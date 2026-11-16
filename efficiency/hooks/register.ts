// Efficiency: records, per repository and across sessions, where Claude Code
// sessions spend context and calls (MCP servers loaded against servers called,
// failed and repeated calls, large results, compactions), by names, counts and
// sizes only. `/efficiency` ranks what it found with the exact settings fix for
// each, and, when the user runs it and the setting allows, asks the model for at
// most five recommendations drawn only from those fixes. Nothing here blocks a
// turn or adds anything to Claude's context.

import type { EngineInterface, Register } from 'claude-code'
import {
  $name, checkAnswer, emptySession, findings, INDEX_KEY, inputHash, listing, MAX_TOKENS, mergeSession, questionText, readIndex, readRepo,
  recordCall, repoKey, reportText, resolveConfig, serverOf, normalizeServer, SYSTEM, withIndex, CAPS, type Config, type SessionStat,
} from './stats.js'

type $ = EngineInterface

const COMMAND = 'efficiency'
/** Two compaction signals this close together are one compaction. */
const SAME_COMPACTION_MS = 30_000
/** What a session-end write leaves Claude Code of its exit bound. */
const END_MARGIN_MS = 200

type Live = {
  stat: SessionStat
  /** Hashes of this session's call inputs, to find exact repeats. Never stored. */
  hashes: Set<string>
  /** A main-loop turn or a tool call happened: the session is worth recording. */
  isActive: boolean
  isDirty: boolean
  /** This session's tool list was read with `$.tool.list()`. */
  isListRead: boolean
}

type Runtime = {
  config: Config
  /** Every tool name the session's tool list has held in this process. */
  pool: Set<string>
  /** Configured MCP server names by normalized name, as tool descriptions told them. */
  names: Record<string, string>
  live?: Live
  /** The record being made for a session, so that two hooks at once make one. */
  creating?: { id: string; promise: Promise<Live> }
  roots: Map<string, string>
  /** Writes to the store, one after another. */
  writing: Promise<void>
  lastCompactionAt?: number
}

export const register: Register = (on, options) => {
  const { config, problems } = resolveConfig(options)
  // Off: no hook, no command.
  if (!config.enabled) return
  const rt: Runtime = { config, pool: new Set(), names: {}, roots: new Map(), writing: Promise.resolve() }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    for (const problem of problems) $.ui.log(`${$name}: ${problem}`)
    try {
      await $.command.register({ name: COMMAND, description: 'Where sessions in this repository waste context or calls, with the exact settings fix for each' })
    } catch (err) {
      debug($, `/${COMMAND} not registered: ${messageOf(err)}`)
    }
    return started
  }).catch(($, e, next) => next(e))

  // The tools the model can call, as the engine lists them (servers that join later too): watched, never changed.
  on('tool.list', async ($, e, next) => {
    const listed = await next(e)
    if (listed.value !== undefined) {
      for (const tool of listed.value) rt.pool.add(tool.name)
      if (rt.live !== undefined) rt.live.isDirty = true
    }
    return listed
  }).catch(($, e, next) => next(e))

  // An MCP tool's description names its server as configured: kept to state `/mcp disable <name>` exactly.
  on('tool.describe', async ($, e, next) => {
    const described = await next(e)
    const server = serverOf(e.tool)
    const provider = e.provider.plugin
    if (server !== undefined && provider.startsWith('mcp:')) {
      const name = provider.slice(4)
      if (normalizeServer(name) === server && Object.keys(rt.names).length < CAPS.servers) rt.names[server] = name
    }
    return described
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    const started = await next(e)
    if (e.agentId === undefined) {
      const live = await liveOf($, rt)
      live.isActive = true
      live.isDirty = true
    }
    return started
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    // The model's own calls (a main loop's or a subagent's); a plugin's `$.tool.call` does not count.
    if (next.origin.plugin !== 'engine' || typeof e.tool_use_id !== 'string' || e.tool_use_id === '') return result
    const live = await liveOf($, rt)
    const tool = String(e.tool)
    const hash = inputHash(tool, e as unknown as Record<string, unknown>)
    const repeat = live.hashes.has(hash)
    if (!repeat && live.hashes.size < CAPS.hashes) live.hashes.add(hash)
    const failed = result.deny !== undefined || result.isError === true
    const chars = (result.deny ?? result.text ?? '').length
    recordCall(live.stat, { tool, failed, chars, repeat }, rt.config.largeResultChars)
    live.isActive = true
    live.isDirty = true
    return result
  }).catch(($, e, next) => next(e))

  // A main-loop turn ended: the record is written off the turn's path.
  on('turn.complete', async ($, e, next) => {
    const completed = await next(e)
    if (e.agentId === undefined) $.clock.after(0, () => void afterTurn($, rt))
    return completed
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    const ended = await next(e)
    const wait = next.budget.remainingMs - END_MARGIN_MS
    if (wait > 0) await Promise.race([flush($, rt), $.clock.sleep(wait)])
    return ended
  }).catch(($, e, next) => next(e))

  // A compaction of the main conversation, whoever wrote its summary. Each of these only watches.
  on('session.compact', async ($, e, next) => {
    const compacted = await next(e)
    if (e.agentId === undefined && e.trigger !== 'precompute' && compacted.skip === undefined) await compactionSeen($, rt)
    return compacted
  }).catch(($, e, next) => next(e))

  on('session.append', { door: 'compaction' }, async ($, e, next) => {
    const appended = await next(e)
    if (e.agentId === undefined) await compactionSeen($, rt)
    return appended
  }).catch(($, e, next) => next(e))

  on('command.run', { command: COMMAND }, async $ => {
    await flush($, rt)
    const root = await rootOf($, rt)
    const now = await $.clock.now()
    const repo = readRepo(await $.store.get(repoKey(root)), root, now)
    const found = findings(repo, rt.config, { mcpJson: await mcpJsonNames($, root) })
    const report = reportText(repo, found, rt.config)
    if (!rt.config.useModel || found.length === 0) return { text: report }
    return { text: `${report}\n\n${await advice($, rt, repo, found)}` }
  }).catch(($, e, next) => ({ text: `${$name}: the report could not be built (${messageOf(next.error)}).` }))
}

/** The current session's record: a new one when the session changed (a /clear or a resume), the old one written first. */
async function liveOf($: $, rt: Runtime): Promise<Live> {
  const id = await $.session.id()
  if (rt.live !== undefined && rt.live.stat.id === id) return rt.live
  if (rt.creating?.id === id) return rt.creating.promise
  const previous = rt.live
  const promise = (async () => {
    if (previous?.isDirty === true) void flush($, rt, previous)
    const live: Live = { stat: emptySession(id, await $.clock.now()), hashes: new Set(), isActive: false, isDirty: true, isListRead: false }
    // A resumed session keeps the counts written for it earlier.
    try {
      const root = await rootOf($, rt)
      const earlier = readRepo(await $.store.get(repoKey(root)), root, live.stat.startedAt).sessions.find(s => s.id === id)
      if (earlier !== undefined) live.stat = earlier
    } catch (err) {
      debug($, `earlier record not read: ${messageOf(err)}`)
    }
    rt.live = live
    return live
  })()
  rt.creating = { id, promise }
  try {
    return await promise
  } finally {
    if (rt.creating?.promise === promise) rt.creating = undefined
  }
}

/** After a main-loop turn: the tool list read once per session (servers that joined late included), then the record written. */
async function afterTurn($: $, rt: Runtime): Promise<void> {
  const live = rt.live
  if (live !== undefined && !live.isListRead) {
    live.isListRead = true
    try {
      for (const tool of await $.tool.list()) rt.pool.add(tool.name)
    } catch (err) {
      debug($, `tool list not read: ${messageOf(err)}`)
    }
  }
  await flush($, rt)
}

async function compactionSeen($: $, rt: Runtime): Promise<void> {
  const now = await $.clock.now()
  if (rt.lastCompactionAt !== undefined && now - rt.lastCompactionAt < SAME_COMPACTION_MS) return
  rt.lastCompactionAt = now
  const live = await liveOf($, rt)
  live.stat.compactions++
  live.isDirty = true
}

/** Writes the current session into its repository's record, one write at a time. Never throws. */
function flush($: $, rt: Runtime, live: Live | undefined = rt.live): Promise<void> {
  rt.writing = rt.writing.then(() => write($, rt, live)).catch(err => debug($, `not written: ${messageOf(err)}`))
  return rt.writing
}

async function write($: $, rt: Runtime, live: Live | undefined): Promise<void> {
  if (live === undefined || !live.isDirty || !live.isActive) return
  live.isDirty = false
  const root = await rootOf($, rt)
  const now = await $.clock.now()
  const listed = listing(rt.pool)
  const stat: SessionStat = { ...structuredClone(live.stat), mcp: listed.mcp, builtin: listed.builtin, updatedAt: now }
  // Read again: another session in the same repository may have written meanwhile.
  const repo = readRepo(await $.store.get(repoKey(root)), root, now)
  await $.store.set(repoKey(root), mergeSession(repo, stat, listed.byServer, rt.names, rt.config.windowSessions, now))
  const { index, dropped } = withIndex(readIndex(await $.store.get(INDEX_KEY)), root, now)
  await $.store.set(INDEX_KEY, index)
  for (const old of dropped) await $.store.delete(repoKey(old))
  debug($, `session ${stat.id} written for ${root}`)
}

/** The model's recommendations, or a line saying why there are none; the code's list stands either way. Never throws. */
async function advice($: $, rt: Runtime, repo: Parameters<typeof questionText>[0], found: Parameters<typeof questionText>[1]): Promise<string> {
  const { model, timeoutSeconds } = rt.config
  const fallback = (why: string) => `(No recommendations from ${model}: ${why}. The list above is the code's own and complete.)`
  const prompt = questionText(repo, found, rt.config)
  try {
    $.ui.status(`${$name}: asking ${model} for recommendations…`)
    const timeoutMs = timeoutSeconds * 1000
    const reply = await $.model.complete({ model, system: SYSTEM, prompt, maxTokens: MAX_TOKENS, effort: 'low', timeoutMs })
    if (!reply.isAnswered) {
      return fallback(reply.reason === 'aborted' ? `no answer in ${timeoutSeconds}s` : reply.reason === 'api-error' ? `the call failed (${reply.status ?? ''} ${reply.error})`.replace('( ', '(') : 'it answered nothing')
    }
    const checked = checkAnswer(reply.text, prompt)
    if (checked === undefined) return fallback('its answer named settings the findings do not, so none of it is shown')
    const note = checked.dropped > 0 ? `\n(${checked.dropped} line${checked.dropped === 1 ? '' : 's'} naming a setting the findings do not name were left out.)` : ''
    return `Recommendations from ${model}, drawn only from the fixes above:\n${checked.text}${note}`
  } catch (err) {
    return fallback(`it could not be called (${messageOf(err)})`)
  } finally {
    try {
      $.ui.status(undefined)
    } catch {
      // The status line is only a courtesy.
    }
  }
}

/** The configured names of the repository's `.mcp.json` servers: the keys alone are read. */
async function mcpJsonNames($: $, root: string): Promise<string[]> {
  try {
    const path = `${root}/.mcp.json`
    if (!(await $.fs.exists(path))) return []
    const parsed: unknown = JSON.parse(await $.fs.read(path))
    const servers = parsed !== null && typeof parsed === 'object' ? (parsed as { mcpServers?: unknown }).mcpServers : undefined
    return servers !== null && typeof servers === 'object' ? Object.keys(servers).slice(0, CAPS.servers) : []
  } catch {
    return []
  }
}

/** The repository: git's top level for the working directory, else the directory itself. */
async function rootOf($: $, rt: Runtime): Promise<string> {
  const cwd = await $.session.cwd()
  const known = rt.roots.get(cwd)
  if (known !== undefined) return known
  let root = cwd
  try {
    const ran = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd, timeoutMs: 5_000 })
    const top = ran.stdout.trim()
    if (ran.exitCode === 0 && top !== '') root = top
  } catch {
    // No git, or not a repository: the directory stands for it.
  }
  rt.roots.set(cwd, root)
  return root
}

function debug($: $, text: string): void {
  try {
    $.ui.log(`${$name}: ${text}`, { to: 'debug' })
  } catch {
    // Logging never stands in the way.
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
