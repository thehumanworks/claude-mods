// The efficiency mod's logic, free of the engine: settings, what one session
// records (names, counts and sizes only, never contents), how sessions are kept
// per repository with caps, the ranked findings with their exact fixes, and the
// optional question put to the model and how its answer is checked.

export const $name = 'efficiency'

export const DEFAULT_MODEL = 'opus'

export type Config = {
  enabled: boolean
  /** Whether `/efficiency` also asks the model for recommendations. */
  useModel: boolean
  /** The model asked: an alias or a full id. */
  model: string
  /** The model call is given up after this long, and the code-only list stands. */
  timeoutSeconds: number
  /** A tool result of at least this many characters counts as large. */
  largeResultChars: number
  /** Sessions kept per repository: the latest this many. */
  windowSessions: number
}

export const DEFAULTS: Config = { enabled: true, useModel: true, model: DEFAULT_MODEL, timeoutSeconds: 60, largeResultChars: 20_000, windowSessions: 20 }

const RANGES = {
  timeoutSeconds: [5, 300],
  largeResultChars: [1_000, 1_000_000],
  windowSessions: [2, 100],
} as const

/** The settings from the plugin's options; a value that cannot be used keeps the default and is reported. */
export function resolveConfig(options: Readonly<Record<string, unknown>>): { config: Config; problems: string[] } {
  const config: Config = { ...DEFAULTS }
  const problems: string[] = []
  if (typeof options.enabled === 'boolean') config.enabled = options.enabled
  if (typeof options.useModel === 'boolean') config.useModel = options.useModel
  if (typeof options.model === 'string' && options.model.trim() !== '') config.model = options.model.trim()
  for (const key of Object.keys(RANGES) as (keyof typeof RANGES)[]) {
    const value = options[key]
    if (value === undefined || value === '') continue
    const [min, max] = RANGES[key]
    const raw = typeof value === 'string' ? Number(value) : value
    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= min && raw <= max) config[key] = Math.round(raw)
    else problems.push(`${key}: ${JSON.stringify(value)} is not ${min} to ${max}; using ${DEFAULTS[key]}`)
  }
  return { config, problems }
}

// ---------------------------------------------------------------------------
// What is recorded

export type Sized = { n: number; chars: number }

/** One session's record: names, counts and sizes. */
export type SessionStat = {
  id: string
  startedAt: number
  updatedAt: number
  /** MCP servers whose tools the session's tool list held: how many tools, and the characters of their names. */
  mcp: Record<string, { tools: number; nameChars: number }>
  /** Built-in and plugin tools in the tool list (not MCP). */
  builtin: number
  /** Claude's tool calls by tool name. */
  calls: Record<string, number>
  /** Failed or refused calls by tool, with the characters of the error text Claude read. */
  fails: Record<string, Sized>
  /** Calls with exactly the input of an earlier call of the same tool in the session, with their result sizes. */
  repeats: Record<string, Sized>
  /** Those repeats that failed. */
  failedRepeats: Record<string, number>
  /** Results of at least the large-result threshold, by tool. */
  large: Record<string, Sized>
  /** Compactions of the main conversation. */
  compactions: number
}

/** One repository's record: the latest sessions, and what is known of its MCP servers. */
export type RepoStat = {
  root: string
  updatedAt: number
  /** Sessions seen in this repository in all, the window's and older ones. */
  sessionsSeen: number
  /** The latest sessions, oldest first. */
  sessions: SessionStat[]
  /** The tool names each MCP server listed, by normalized server name. */
  mcpTools: Record<string, string[]>
  /** The configured name of a server, by normalized name, where Claude Code told it. */
  names: Record<string, string>
}

/** The caps on what is kept. */
export const CAPS = {
  /** Repositories kept; past this the one updated longest ago goes. */
  repos: 25,
  /** Distinct tool names per count in one session; the rest go under OTHER. */
  keys: 100,
  /** MCP servers per session and per repository. */
  servers: 50,
  /** Tool names kept per server. */
  toolsPerServer: 200,
  /** A tool or server name is cut to this many characters. */
  name: 120,
  /** Inputs remembered per session to find exact repeats (in memory only, as hashes). */
  hashes: 5_000,
} as const

export const OTHER = '(other)'

export const emptySession = (id: string, now: number): SessionStat => ({
  id, startedAt: now, updatedAt: now, mcp: {}, builtin: 0, calls: {}, fails: {}, repeats: {}, failedRepeats: {}, large: {}, compactions: 0,
})

export const emptyRepo = (root: string, now: number): RepoStat => ({ root, updatedAt: now, sessionsSeen: 0, sessions: [], mcpTools: {}, names: {} })

/** The key a count is kept under: the name, cut, or OTHER once the map holds CAPS.keys names. */
function keyIn(map: Record<string, unknown>, name: string): string {
  const key = clip(name, CAPS.name)
  return key in map || Object.keys(map).length < CAPS.keys ? key : OTHER
}

export function bump(map: Record<string, number>, name: string, by = 1): void {
  const key = keyIn(map, name)
  map[key] = (map[key] ?? 0) + by
}

export function bumpSized(map: Record<string, Sized>, name: string, chars: number): void {
  const key = keyIn(map, name)
  const prev = map[key] ?? { n: 0, chars: 0 }
  map[key] = { n: prev.n + 1, chars: prev.chars + Math.max(0, Math.round(chars)) }
}

/** What one tool call left, as the record counts it. */
export type CallOutcome = {
  tool: string
  /** Failed (an error result) or refused (a deny). */
  failed: boolean
  /** The characters of the text Claude read: the result, the error or the refusal. */
  chars: number
  /** Whether the input was exactly an earlier call's in this session. */
  repeat: boolean
}

export function recordCall(stat: SessionStat, call: CallOutcome, largeChars: number): void {
  bump(stat.calls, call.tool)
  if (call.failed) bumpSized(stat.fails, call.tool, call.chars)
  if (call.repeat) {
    bumpSized(stat.repeats, call.tool, call.chars)
    if (call.failed) bump(stat.failedRepeats, call.tool)
  }
  if (call.chars >= largeChars) bumpSized(stat.large, call.tool, call.chars)
}

/** The tool list as the session's record keeps it: per MCP server its tool count and name characters, and the other tools' count. */
export function listing(names: Iterable<string>): { mcp: SessionStat['mcp']; builtin: number; byServer: Record<string, string[]> } {
  const mcp: SessionStat['mcp'] = {}
  const byServer: Record<string, string[]> = {}
  let builtin = 0
  for (const name of new Set(names)) {
    const server = serverOf(name)
    if (server === undefined) {
      builtin++
      continue
    }
    if (!(server in mcp) && Object.keys(mcp).length >= CAPS.servers) continue
    const entry = mcp[server] ?? { tools: 0, nameChars: 0 }
    mcp[server] = { tools: entry.tools + 1, nameChars: entry.nameChars + name.length }
    const tools = (byServer[server] ??= [])
    if (tools.length < CAPS.toolsPerServer) tools.push(clip(name, CAPS.name))
  }
  return { mcp, builtin, byServer }
}

/** The MCP server of a tool name (`mcp__<server>__<tool>`), as the name spells it; undefined for any other tool. */
export function serverOf(tool: string): string | undefined {
  if (!tool.startsWith('mcp__')) return undefined
  const rest = tool.slice(5)
  const end = rest.indexOf('__')
  if (end <= 0) return undefined
  return clip(rest.slice(0, end), CAPS.name)
}

/** A server name as Claude Code spells it in tool names: any character outside [a-zA-Z0-9_-] becomes `_`. */
export function normalizeServer(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_')
}

/** Arguments that only label a call and change nothing it does: left out of the hash. */
const LABELS: Readonly<Record<string, readonly string[]>> = { Bash: ['description'], PowerShell: ['description'] }

/** A short hash of a call's input, to find exact repeats without keeping the input. */
export function inputHash(tool: string, input: Readonly<Record<string, unknown>>): string {
  const { tool_use_id: _id, agentId: _agent, requestMeta: _meta, tool: _tool, ...rest } = input
  const args: Record<string, unknown> = { ...rest }
  for (const label of LABELS[tool] ?? []) delete args[label]
  let text: string
  try {
    text = `${tool}\u0000${stableJson(args)}`
  } catch {
    text = `${tool}\u0000${String(Object.keys(args))}`
  }
  // Two FNV-1a passes with different seeds, and the length: collisions are negligible for a session's calls.
  let a = 0x811c9dc5
  let b = 0x01000193
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193) >>> 0
    b = Math.imul(b ^ c, 0x5bd1e995) >>> 0
  }
  return `${a.toString(36)}.${b.toString(36)}.${text.length.toString(36)}`
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined'
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const obj = value as Record<string, unknown>
  return `{${Object.keys(obj).sort().map(k => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(',')}}`
}

// ---------------------------------------------------------------------------
// The store: one key per repository, and an index of them

export const INDEX_KEY = 'index'
export const repoKey = (root: string) => `repo:${root}`

/** The index as read from the store: repository root → when it was last updated. */
export function readIndex(value: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  if (!isObject(value)) return out
  for (const [root, at] of Object.entries(value)) if (typeof at === 'number') out[root] = at
  return out
}

/** The index with `root` updated, and the repositories past the cap to drop. */
export function withIndex(index: Record<string, number>, root: string, now: number, max: number = CAPS.repos): { index: Record<string, number>; dropped: string[] } {
  const next = { ...index, [root]: now }
  const roots = Object.keys(next).sort((a, b) => next[b]! - next[a]!)
  const dropped = roots.slice(max)
  for (const old of dropped) delete next[old]
  return { index: next, dropped }
}

/** A repository's record as read from the store; anything malformed is left out. */
export function readRepo(value: unknown, root: string, now: number): RepoStat {
  const repo = emptyRepo(root, now)
  if (!isObject(value)) return repo
  if (typeof value.updatedAt === 'number') repo.updatedAt = value.updatedAt
  if (typeof value.sessionsSeen === 'number') repo.sessionsSeen = value.sessionsSeen
  if (Array.isArray(value.sessions)) repo.sessions = value.sessions.filter(isSession)
  if (isObject(value.mcpTools)) {
    for (const [server, tools] of Object.entries(value.mcpTools).slice(0, CAPS.servers)) {
      if (Array.isArray(tools)) repo.mcpTools[server] = tools.filter((t): t is string => typeof t === 'string').slice(0, CAPS.toolsPerServer)
    }
  }
  if (isObject(value.names)) for (const [k, v] of Object.entries(value.names)) if (typeof v === 'string') repo.names[k] = v
  repo.sessionsSeen = Math.max(repo.sessionsSeen, repo.sessions.length)
  return repo
}

function isSession(value: unknown): value is SessionStat {
  return isObject(value) && typeof value.id === 'string' && typeof value.startedAt === 'number' && isObject(value.mcp) && isObject(value.calls)
    && isObject(value.fails) && isObject(value.repeats) && isObject(value.large) && typeof value.compactions === 'number'
}

/**
 * The repository's record with `session` put in: in place of an earlier copy of the same
 * session, else added (and counted). The latest `window` sessions are kept; what the
 * session's tool list said of each MCP server joins what is known.
 */
export function mergeSession(repo: RepoStat, session: SessionStat, byServer: Record<string, string[]>, names: Record<string, string>, window: number, now: number): RepoStat {
  const sessions = repo.sessions.filter(s => s.id !== session.id)
  const isNew = sessions.length === repo.sessions.length
  sessions.push(session)
  sessions.sort((a, b) => a.startedAt - b.startedAt)
  const mcpTools: Record<string, string[]> = { ...repo.mcpTools }
  for (const [server, tools] of Object.entries(byServer)) {
    if (!(server in mcpTools) && Object.keys(mcpTools).length >= CAPS.servers) continue
    mcpTools[server] = [...new Set([...(mcpTools[server] ?? []), ...tools])].slice(0, CAPS.toolsPerServer)
  }
  const merged: Record<string, string> = { ...repo.names }
  for (const [k, v] of Object.entries(names)) if (Object.keys(merged).length < CAPS.servers || k in merged) merged[k] = clip(v, CAPS.name)
  return {
    root: repo.root,
    updatedAt: now,
    sessionsSeen: repo.sessionsSeen + (isNew ? 1 : 0),
    sessions: sessions.slice(-window),
    mcpTools,
    names: merged,
  }
}

// ---------------------------------------------------------------------------
// Findings

/** The settings file every fix names, relative to the repository root: personal and not checked in. */
export const LOCAL_SETTINGS = '.claude/settings.local.json'

export type Finding = {
  kind: 'unused-connectors' | 'unused-server' | 'partial-server' | 'large-results' | 'failures' | 'repeats' | 'compactions'
  /** What was seen, in one line. */
  title: string
  /** The fix, one line each; exact settings files and keys, or a plain statement that there is none. */
  fix: string[]
  /** Whether the fix is a settings change stated exactly. */
  isExact: boolean
  /** Estimated tokens it costs over the window: what ranks it. */
  score: number
}

/** Fewer sessions than this with a server loaded is too thin to call it unused. */
export const MIN_SESSIONS = 2
/** A tool needs this many failures, repeats or large results in the window to be named. */
export const MIN_EVENTS = 3
/** At most this many findings are shown. */
export const MAX_FINDINGS = 10

export type Known = {
  /** The configured names of the repository's `.mcp.json` servers. */
  mcpJson: readonly string[]
}

const tokens = (chars: number) => Math.round(chars / 4)
const fmt = (n: number) => n.toLocaleString('en-US')
const plural = (n: number, one: string, many = `${one}s`) => `${fmt(n)} ${n === 1 ? one : many}`

/** The ranked findings for a repository: those with an exact settings fix first, each group by estimated tokens. */
export function findings(repo: RepoStat, config: Pick<Config, 'largeResultChars'>, known: Known): Finding[] {
  const out: Finding[] = []
  const sessions = repo.sessions
  const listed = sessions.filter(s => s.builtin > 0 || Object.keys(s.mcp).length > 0)

  // Calls per server, and the distinct tools called.
  const serverCalls: Record<string, number> = {}
  const calledTools = new Set<string>()
  for (const s of sessions) {
    for (const [tool, n] of Object.entries(s.calls)) {
      const server = serverOf(tool)
      if (server !== undefined) serverCalls[server] = (serverCalls[server] ?? 0) + n
      calledTools.add(tool)
    }
  }

  type ServerSeen = { server: string; loaded: number; maxTools: number; carried: number }
  const servers: Record<string, ServerSeen> = {}
  for (const s of listed) {
    for (const [server, m] of Object.entries(s.mcp)) {
      const seen = (servers[server] ??= { server, loaded: 0, maxTools: 0, carried: 0 })
      seen.loaded++
      seen.maxTools = Math.max(seen.maxTools, m.tools)
      seen.carried += tokens(m.nameChars)
    }
  }
  const unused = Object.values(servers).filter(v => (serverCalls[v.server] ?? 0) === 0 && v.loaded >= MIN_SESSIONS)
  const of = (v: ServerSeen) => `loaded in ${v.loaded} of ${plural(listed.length, 'session')} (${plural(v.maxTools, 'tool')}, ~${fmt(Math.round(v.carried / v.loaded))} est. tokens of tool names each), called 0 times`

  // All claude.ai connectors unused: one switch turns them all off.
  const connectors = Object.values(servers).filter(v => v.server.startsWith('claude_ai_'))
  const isAllConnectorsUnused = connectors.length >= 2 && connectors.every(v => unused.includes(v))
  if (isAllConnectorsUnused) {
    const total = connectors.reduce((sum, v) => sum + v.carried, 0)
    out.push({
      kind: 'unused-connectors',
      title: `claude.ai connectors: ${connectors.length} loaded (${connectors.map(v => v.server.slice('claude_ai_'.length)).join(', ')}), none called in ${plural(listed.length, 'session')} (~${fmt(total)} est. tokens of tool names in all)`,
      fix: [
        `Fix: in ${LOCAL_SETTINGS}, set "disableClaudeAiConnectors": true. claude.ai connectors are then not fetched or connected in this project.`,
        `Or deny only some: add "mcp__<server>" to "permissions"."deny" there, e.g. "mcp__${connectors[0]!.server}".`,
      ],
      isExact: true,
      score: total + 1,
    })
  }

  for (const v of unused) {
    if (isAllConnectorsUnused && v.server.startsWith('claude_ai_')) continue
    out.push({
      kind: 'unused-server',
      title: `MCP server "${v.server}": ${of(v)}`,
      fix: [
        `Fix: in ${LOCAL_SETTINGS}, add "mcp__${v.server}" to "permissions"."deny". Its tools leave Claude's tool list in this project; the server itself still starts.`,
        stopLine(v.server, repo, known),
      ],
      isExact: true,
      score: v.carried,
    })
  }

  // Servers used for a few of many tools.
  for (const v of Object.values(servers)) {
    if ((serverCalls[v.server] ?? 0) === 0) continue
    const names = repo.mcpTools[v.server] ?? []
    const idle = names.filter(t => !calledTools.has(t))
    if (idle.length < 10 || idle.length < names.length / 2) continue
    const used = names.length - idle.length
    const shown = idle.slice(0, 12).map(t => `"${t}"`).join(', ')
    const more = idle.length > 12 ? `, and ${idle.length - 12} more of this server's uncalled tools` : ''
    const carried = Math.round(tokens(idle.reduce((sum, t) => sum + t.length, 0)) * v.loaded)
    out.push({
      kind: 'partial-server',
      title: `MCP server "${v.server}": ${plural(names.length, 'tool')} loaded, ${used} called, in ${plural(v.loaded, 'session')}`,
      fix: [`Fix: in ${LOCAL_SETTINGS}, add one "permissions"."deny" rule per uncalled tool (${plural(idle.length, 'rule')}): ${shown}${more}.`],
      isExact: true,
      score: carried,
    })
  }

  // Large results, failures and repeats, summed per tool over the window.
  const sum = (pick: (s: SessionStat) => Record<string, Sized>) => {
    const total: Record<string, Sized & { sessions: number }> = {}
    for (const s of sessions) {
      for (const [tool, v] of Object.entries(pick(s))) {
        const t = (total[tool] ??= { n: 0, chars: 0, sessions: 0 })
        t.n += v.n
        t.chars += v.chars
        t.sessions++
      }
    }
    return total
  }
  const callsOf = (tool: string) => sessions.reduce((n, s) => n + (s.calls[tool] ?? 0), 0)

  for (const [tool, v] of Object.entries(sum(s => s.large))) {
    if (v.n < MIN_EVENTS || tool === OTHER) continue
    const title = `Tool "${tool}": ${plural(v.n, 'result')} of ${fmt(config.largeResultChars)}+ characters in ${plural(v.sessions, 'session')} (~${fmt(tokens(v.chars))} est. tokens)`
    if (tool === 'Bash' || tool === 'PowerShell') {
      const cap = clamp(Math.round(config.largeResultChars / 2), 4_000, 128_000)
      out.push({ kind: 'large-results', title, isExact: true, score: tokens(v.chars), fix: [`Fix: in ${LOCAL_SETTINGS}, set "bashOutputMaxChars": ${cap} (default 30000; 4000 to 128000). Output past it is saved to a file, and Claude gets a preview and the path.`] })
    } else if (serverOf(tool) !== undefined) {
      const cap = Math.max(1_000, Math.round(config.largeResultChars / 8 / 1_000) * 1_000)
      out.push({ kind: 'large-results', title, isExact: true, score: tokens(v.chars), fix: [`Fix: in ${LOCAL_SETTINGS}, set "env": { "MAX_MCP_OUTPUT_TOKENS": "${cap}" } (default 25000). It caps every MCP tool's result in this project, not only this tool's.`] })
    } else {
      out.push({ kind: 'large-results', title, isExact: false, score: tokens(v.chars), fix: [`No exact settings fix: Claude Code has no settings key that caps ${tool} results. Asking for narrower reads or searches is the lever.`] })
    }
  }

  for (const [tool, v] of Object.entries(sum(s => s.fails))) {
    if (v.n < MIN_EVENTS || tool === OTHER) continue
    const why = serverOf(tool) !== undefined ? ' /mcp shows whether its server is connected and signed in.' : ''
    out.push({
      kind: 'failures',
      title: `Tool "${tool}": ${fmt(v.n)} of ${plural(callsOf(tool), 'call')} failed or were refused, in ${plural(v.sessions, 'session')} (~${fmt(tokens(v.chars))} est. tokens of error text)`,
      fix: [`No exact settings fix: the calls themselves fail.${why}`],
      isExact: false,
      score: tokens(v.chars),
    })
  }

  for (const [tool, v] of Object.entries(sum(s => s.repeats))) {
    if (v.n < MIN_EVENTS || tool === OTHER) continue
    const failed = sessions.reduce((n, s) => n + (s.failedRepeats[tool] ?? 0), 0)
    out.push({
      kind: 'repeats',
      title: `Tool "${tool}": ${plural(v.n, 'exact repeat')} (the same input as an earlier call in the session${failed > 0 ? `; ${failed} of them failed again` : ''}), in ${plural(v.sessions, 'session')} (~${fmt(tokens(v.chars))} est. tokens)`,
      fix: [failed >= MIN_EVENTS
        ? 'No settings key stops repeats. loop-breaker in this marketplace tells Claude to change approach after a repeated failure: /plugin install loop-breaker --marketplace thehumanworks/claude-mods'
        : 'No exact settings fix: a repeat can be legitimate (a re-read after an edit).'],
      isExact: false,
      score: tokens(v.chars),
    })
  }

  const compactions = sessions.reduce((n, s) => n + s.compactions, 0)
  if (compactions >= 2) {
    const most = Math.max(...sessions.map(s => s.compactions))
    out.push({
      kind: 'compactions',
      title: `Compactions: ${fmt(compactions)} in ${plural(sessions.length, 'session')} (at most ${most} in one)`,
      fix: ['No settings key reduces them: they follow from long sessions. A new session per task (/clear) does, and the fixes above shrink every request.'],
      isExact: false,
      score: 0,
    })
  }

  return out.sort((a, b) => Number(b.isExact) - Number(a.isExact) || b.score - a.score).slice(0, MAX_FINDINGS)
}

/** How to stop a server for this project, by where it is configured; plain about what is not known. */
function stopLine(server: string, repo: RepoStat, known: Known): string {
  const fromMcpJson = known.mcpJson.find(n => normalizeServer(n) === server)
  if (fromMcpJson !== undefined) {
    return `Or stop it in this project: it is in .mcp.json, so add ${JSON.stringify(fromMcpJson)} to "disabledMcpjsonServers" in ${LOCAL_SETTINGS}.`
  }
  if (server.startsWith('plugin_')) return 'It comes from a plugin; /plugin turns plugins off. The mod does not know which plugin, so it names no key.'
  const name = repo.names[server]
  if (name !== undefined) {
    return `Or stop it in this project: run /mcp disable ${name} (Claude Code keeps that under "disabledMcpServers" in this project's entry of ~/.claude.json; /mcp enable ${name} undoes it).`
  }
  return 'To stop the server itself in this project, use /mcp disable with the name /mcp lists it under; the mod does not know that name exactly.'
}

export function findingsText(fs: readonly Finding[]): string {
  return fs.map((f, i) => [`${i + 1}. ${f.title}`, ...f.fix.map(l => `   ${l}`)].join('\n')).join('\n')
}

/** The header: the repository and its sessions. */
export function headerText(repo: RepoStat, config: Pick<Config, 'windowSessions'>): string {
  const n = repo.sessions.length
  return `efficiency for ${repo.root}: ${plural(n, 'session')} in the window (the latest ${config.windowSessions} are kept; ${fmt(repo.sessionsSeen)} seen in all).`
}

/** What `/efficiency` prints before any model step. */
export function reportText(repo: RepoStat, fs: readonly Finding[], config: Pick<Config, 'windowSessions'>): string {
  const head = headerText(repo, config)
  if (repo.sessions.length === 0) return `No sessions recorded for ${repo.root} yet. The mod records from the next session on.`
  if (fs.length === 0) return `${head}\nNo waste found: every MCP server loaded was called, and no tool failed, repeated or returned large results ${MIN_EVENTS}+ times.`
  return [
    head,
    `Findings, the ones with an exact settings fix first, then by estimated tokens (est. ≈ characters / 4). Settings paths are relative to ${repo.root}; ${LOCAL_SETTINGS} is personal and not checked in (.claude/settings.json takes the same keys for everyone).`,
    '',
    findingsText(fs),
  ].join('\n')
}

// ---------------------------------------------------------------------------
// The optional model step

export const MAX_INPUT_CHARS = 4_000
export const MAX_TOKENS = 600

export const SYSTEM = [
  'You advise on making Claude Code sessions in one repository waste less context and fewer calls.',
  'You get the repository\'s usage summary and a numbered list of findings, each with its fix, built by code from names, counts and sizes.',
  'Write at most 5 recommendations, most valuable first, as a numbered list. Each is one or two short lines and cites the finding numbers it acts on, like [1].',
  'Use only the fixes given: name only settings files, keys, values and commands that appear in the findings, exactly as written there. Never invent a setting, key, value or command.',
  'Where a finding says there is no exact settings fix, say so rather than proposing one.',
  'If nothing is worth changing, answer exactly: No change needed.',
  'Plain text: no preamble, no headings, no code blocks.',
].join('\n')

/** The user message for the model: the summary and the findings, capped. */
export function questionText(repo: RepoStat, fs: readonly Finding[], config: Pick<Config, 'windowSessions'>): string {
  const room = MAX_INPUT_CHARS - SYSTEM.length
  return clip(`${headerText(repo, config)}\n\nFindings:\n${findingsText(fs)}`, Math.max(500, room))
}

/** A settings key or environment variable as it would be written: camelCase or UPPER_SNAKE. */
const KEY_LIKE = /\b(?:[a-z]+(?:[A-Z][a-z0-9]*)+|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/g

/**
 * The model's answer checked against the question: a line naming a key the findings do
 * not name is dropped. Undefined when nothing is left.
 */
export function checkAnswer(text: string, question: string): { text: string; dropped: number } | undefined {
  let body = text.trim()
  const fenced = /^```[\w-]*\n([\s\S]*?)\n```$/.exec(body)
  if (fenced) body = fenced[1]!.trim()
  if (body === '') return undefined
  let dropped = 0
  const kept = body.split('\n').filter(line => {
    const keys = line.match(KEY_LIKE) ?? []
    const isKnown = keys.every(k => question.includes(k))
    if (!isKnown) dropped++
    return isKnown
  })
  const out = clip(kept.join('\n').trim(), 3_000)
  return out === '' ? undefined : { text: out, dropped }
}

// ---------------------------------------------------------------------------

export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
