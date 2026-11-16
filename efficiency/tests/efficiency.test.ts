import { expect, test } from 'claude-code/testing'
import {
  bump, CAPS, checkAnswer, emptyRepo, emptySession, findings, inputHash, listing, MAX_INPUT_CHARS, mergeSession, OTHER, questionText, readRepo,
  recordCall, reportText, resolveConfig, SYSTEM, withIndex, type RepoStat, type SessionStat,
} from '../hooks/stats.js'
import { engine } from './helpers.js'

const ROOT = '/work/app'
const DRIVE = Array.from({ length: 24 }, (_, i) => `mcp__claude_ai_Drive__tool_${i}`)
const MAIL = Array.from({ length: 30 }, (_, i) => `mcp__claude_ai_Mail__tool_${i}`)
const GH = Array.from({ length: 40 }, (_, i) => `mcp__github__op_${i}`)
const DOCS = ['mcp__docs__search', 'mcp__docs__read']
const BUILTIN = ['Bash', 'Read', 'Edit']
const CFG = { largeResultChars: 20_000 }

type StoredRepo = RepoStat

/** A session record built by hand, for the pure tests. */
function session(id: string, at: number, tools: string[], fill: (s: SessionStat) => void = () => {}): SessionStat {
  const s = emptySession(id, at)
  const l = listing(tools)
  s.mcp = l.mcp
  s.builtin = l.builtin
  fill(s)
  return s
}

function repoWith(sessions: SessionStat[], tools: string[]): RepoStat {
  let repo = emptyRepo(ROOT, 0)
  for (const s of sessions) repo = mergeSession(repo, s, listing(tools).byServer, {}, 20, s.startedAt)
  return repo
}

// ---------------------------------------------------------------------------
// Settings

test('settings: the defaults, and a value out of range keeps its default', async () => {
  const { config, problems } = resolveConfig({})
  expect(config).toEqual({ enabled: true, useModel: true, model: 'opus', timeoutSeconds: 60, largeResultChars: 20_000, windowSessions: 20 })
  expect(problems).toEqual([])
  const bad = resolveConfig({ model: ' haiku ', windowSessions: 1, largeResultChars: '5000', timeoutSeconds: 9999, useModel: false })
  expect(bad.config.model).toBe('haiku')
  expect(bad.config.useModel).toBe(false)
  expect(bad.config.windowSessions).toBe(20)
  expect(bad.config.largeResultChars).toBe(5_000)
  expect(bad.config.timeoutSeconds).toBe(60)
  expect(bad.problems.length).toBe(2)
})

// ---------------------------------------------------------------------------
// Recording and caps

test('a call is recorded by name, count and size: failures, repeats and large results', async () => {
  const s = emptySession('s', 0)
  recordCall(s, { tool: 'Bash', failed: false, chars: 25_000, repeat: false }, 20_000)
  recordCall(s, { tool: 'Bash', failed: true, chars: 40, repeat: true }, 20_000)
  recordCall(s, { tool: 'Read', failed: false, chars: 10, repeat: false }, 20_000)
  expect(s.calls).toEqual({ Bash: 2, Read: 1 })
  expect(s.fails).toEqual({ Bash: { n: 1, chars: 40 } })
  expect(s.repeats).toEqual({ Bash: { n: 1, chars: 40 } })
  expect(s.failedRepeats).toEqual({ Bash: 1 })
  expect(s.large).toEqual({ Bash: { n: 1, chars: 25_000 } })
})

test('caps: distinct tool names, name length, servers and tools per server', async () => {
  const counts: Record<string, number> = {}
  for (let i = 0; i < CAPS.keys + 20; i++) bump(counts, `tool_${i}`)
  expect(Object.keys(counts).length).toBe(CAPS.keys + 1)
  expect(counts[OTHER]).toBe(20)
  bump(counts, 'z'.repeat(500))
  expect(Object.keys(counts).every(k => k.length <= CAPS.name)).toBe(true)
  const many = Array.from({ length: CAPS.servers + 5 }, (_, i) => `mcp__srv${i}__t`)
  expect(Object.keys(listing(many).mcp).length).toBe(CAPS.servers)
  const wide = Array.from({ length: CAPS.toolsPerServer + 50 }, (_, i) => `mcp__big__t${i}`)
  const l = listing([...wide, 'Bash'])
  expect(l.mcp.big).toEqual({ tools: CAPS.toolsPerServer + 50, nameChars: wide.reduce((n, t) => n + t.length, 0) })
  expect(l.byServer.big!.length).toBe(CAPS.toolsPerServer)
  expect(l.builtin).toBe(1)
})

test('the window keeps the latest sessions, counts every one, and a session written twice counts once', async () => {
  let repo = emptyRepo(ROOT, 0)
  for (let i = 0; i < 7; i++) repo = mergeSession(repo, session(`s${i}`, i, BUILTIN), {}, {}, 5, i)
  expect(repo.sessions.map(s => s.id)).toEqual(['s2', 's3', 's4', 's5', 's6'])
  expect(repo.sessionsSeen).toBe(7)
  repo = mergeSession(repo, session('s6', 6, BUILTIN, s => { s.calls.Bash = 3 }), {}, {}, 5, 7)
  expect(repo.sessionsSeen).toBe(7)
  expect(repo.sessions.at(-1)!.calls).toEqual({ Bash: 3 })
  expect(readRepo('junk', ROOT, 0).sessions).toEqual([])
  expect(readRepo({ sessions: [{ id: 1 }, repo.sessions[0]] }, ROOT, 0).sessions.length).toBe(1)
})

test('repositories past the cap go, the one updated longest ago first', async () => {
  let index: Record<string, number> = {}
  let dropped: string[] = []
  for (let i = 0; i < 4; i++) ({ index, dropped } = withIndex(index, `/r${i}`, i, 3))
  expect(Object.keys(index).sort()).toEqual(['/r1', '/r2', '/r3'])
  expect(dropped).toEqual(['/r0'])
})

test('an input hash ignores the call id and key order, and tells inputs apart', async () => {
  expect(inputHash('Read', { tool_use_id: 'a', file_path: '/x', limit: 5 })).toBe(inputHash('Read', { limit: 5, file_path: '/x', tool_use_id: 'b' }))
  expect(inputHash('Read', { file_path: '/x' })).not.toBe(inputHash('Read', { file_path: '/y' }))
  expect(inputHash('Read', { file_path: '/x' })).not.toBe(inputHash('Grep', { file_path: '/x' }))
  // A Bash call's description labels it and changes nothing it runs.
  expect(inputHash('Bash', { command: 'ls /nope', description: 'List it' })).toBe(inputHash('Bash', { command: 'ls /nope', description: 'Try again' }))
  expect(inputHash('Bash', { command: 'ls /nope' })).not.toBe(inputHash('Bash', { command: 'ls /nope', timeout: 5 }))
})

test('sessions are logged through the hooks: tools listed against called, failures, repeats, large results, compactions', async ($, on) => {
  const h = engine(on, { gitRoot: ROOT, tools: [...BUILTIN, ...DOCS, ...GH] })
  await h.session($, 's1', async () => {
    await h.call($, 'Read', { file_path: '/work/app/a.ts' })
    await h.call($, 'Read', { file_path: '/work/app/a.ts' })
    await h.call($, 'Bash', { command: 'npm test', fail: true })
    await h.call($, 'Bash', { command: 'cat big.log', size: 30_000 })
    await h.call($, 'mcp__docs__search', { q: 'x', deny: true })
    await h.compact($)
  })
  const repo = h.store.get(`repo:${ROOT}`) as StoredRepo
  expect(repo.sessionsSeen).toBe(1)
  const s = repo.sessions[0]!
  expect(s.id).toBe('s1')
  expect(s.builtin).toBe(3)
  expect(Object.keys(s.mcp).sort()).toEqual(['docs', 'github'])
  expect(s.mcp.github!.tools).toBe(40)
  expect(s.calls).toEqual({ Read: 2, Bash: 2, mcp__docs__search: 1 })
  expect(s.fails).toEqual({ Bash: { n: 1, chars: 'Error: it failed'.length }, mcp__docs__search: { n: 1, chars: 'refused by a rule'.length } })
  expect(s.repeats).toEqual({ Read: { n: 1, chars: 2 } })
  expect(s.large).toEqual({ Bash: { n: 1, chars: 30_000 } })
  expect(s.compactions).toBe(1)
  // Names, counts and sizes only: no input or result text is kept.
  const raw = JSON.stringify([...h.store.values()])
  expect(raw).not.toContain('npm test')
  expect(raw).not.toContain('a.ts')
  expect(raw).not.toContain('Error: it failed')
  expect(h.store.get('index')).toEqual({ [ROOT]: expect.any(Number) })
})

test("a subagent's calls count too; the tool list is read once per session, and again after /clear", async ($, on) => {
  const h = engine(on, { gitRoot: ROOT })
  await h.session($, 's1', async () => {
    await h.call($, 'Read', { file_path: '/x', agentId: 'a1' })
  })
  await h.turn($)
  expect(h.seen.toolLists).toBe(1)
  // /clear: the process goes on under a new session id, which gets its own record.
  h.state.sessionId = 's2'
  await h.turn($, () => h.call($, 'Bash', { command: 'ls' }))
  expect(h.seen.toolLists).toBe(2)
  const repo = h.store.get(`repo:${ROOT}`) as StoredRepo
  expect(repo.sessions.map(s => [s.id, s.calls, s.builtin])).toEqual([['s1', { Read: 1 }, 3], ['s2', { Bash: 1 }, 3]])
})

test('a session with no turn is not recorded', async ($, on) => {
  const h = engine(on, { gitRoot: ROOT })
  await $.session.start({ cwd: '/work/app/src', surface: null, isInteractive: false } as never)
  await $.session.end({ reason: 'other', sessionId: 'session-1' } as never)
  await h.clock.settle()
  expect(h.store.get(`repo:${ROOT}`)).toBeUndefined()
})

test('the repository is the git root of the working directory', async ($, on) => {
  const h = engine(on, { gitRoot: ROOT, cwd: '/work/app/src/deep' })
  await h.session($, 'a1', () => h.call($, 'Read', { file_path: '/x' }))
  expect(Object.keys(h.store.get('index') as object)).toEqual([ROOT])
})

test('per-repo separation: two working copies never mix', async ($, on) => {
  const h = engine(on, { cwd: '/tmp/one' })
  await h.session($, 'x1', () => h.call($, 'Read', { file_path: '/x' }))
  h.state.cwd = '/tmp/two'
  await h.session($, 'x2', () => h.call($, 'Bash', { command: 'ls' }))
  const one = h.store.get('repo:/tmp/one') as StoredRepo
  const two = h.store.get('repo:/tmp/two') as StoredRepo
  expect(one.sessions.map(s => s.id)).toEqual(['x1'])
  expect(two.sessions.map(s => s.id)).toEqual(['x2'])
  expect(one.sessions[0]!.calls).toEqual({ Read: 1 })
  expect(two.sessions[0]!.calls).toEqual({ Bash: 1 })
  // /efficiency in one reports only that one.
  const text = await h.command($)
  expect(text).toContain('/tmp/two')
  expect(text).not.toContain('/tmp/one')
})

test('the window setting caps the sessions kept through the hooks', { options: { windowSessions: 3 } }, async ($, on) => {
  const h = engine(on, { gitRoot: ROOT })
  for (let i = 0; i < 5; i++) await h.session($, `w${i}`, () => h.call($, 'Read', { file_path: `/f${i}` }))
  const repo = h.store.get(`repo:${ROOT}`) as StoredRepo
  expect(repo.sessions.map(s => s.id)).toEqual(['w2', 'w3', 'w4'])
  expect(repo.sessionsSeen).toBe(5)
})

// ---------------------------------------------------------------------------
// Ranking and fix text

test('an MCP server loaded in every session and never called: ranked first, with the exact settings fix', async () => {
  const tools = [...BUILTIN, ...GH, ...DOCS]
  const sessions = Array.from({ length: 7 }, (_, i) => session(`s${i}`, i, tools, s => { s.calls['mcp__docs__search'] = 1 }))
  const fs = findings(repoWith(sessions, tools), CFG, { mcpJson: [] })
  expect(fs.length).toBe(1)
  const f = fs[0]!
  expect(f.kind).toBe('unused-server')
  expect(f.isExact).toBe(true)
  expect(f.title).toMatch(/^MCP server "github": loaded in 7 of 7 sessions \(40 tools, ~\d+ est\. tokens of tool names each\), called 0 times$/)
  expect(f.fix[0]).toBe('Fix: in .claude/settings.local.json, add "mcp__github" to "permissions"."deny". Its tools leave Claude\'s tool list in this project; the server itself still starts.')
  expect(f.fix[1]).toBe('To stop the server itself in this project, use /mcp disable with the name /mcp lists it under; the mod does not know that name exactly.')
})

test('the stop line: disabledMcpjsonServers for a .mcp.json server, /mcp disable when the configured name is known', async () => {
  const tools = [...BUILTIN, 'mcp__my_db__query', 'mcp__linear__issue']
  const sessions = [session('a', 1, tools), session('b', 2, tools)]
  const repo = repoWith(sessions, tools)
  repo.names = { linear: 'linear' }
  const fs = findings(repo, CFG, { mcpJson: ['my.db'] })
  const db = fs.find(f => f.title.includes('"my_db"'))!
  expect(db.fix[1]).toBe('Or stop it in this project: it is in .mcp.json, so add "my.db" to "disabledMcpjsonServers" in .claude/settings.local.json.')
  const linear = fs.find(f => f.title.includes('"linear"'))!
  expect(linear.fix[1]).toBe('Or stop it in this project: run /mcp disable linear (Claude Code keeps that under "disabledMcpServers" in this project\'s entry of ~/.claude.json; /mcp enable linear undoes it).')
})

test('all claude.ai connectors unused: one finding with disableClaudeAiConnectors', async () => {
  const tools = [...BUILTIN, ...DRIVE, ...MAIL]
  const fs = findings(repoWith([session('a', 1, tools), session('b', 2, tools)], tools), CFG, { mcpJson: [] })
  expect(fs.length).toBe(1)
  expect(fs[0]!.kind).toBe('unused-connectors')
  expect(fs[0]!.title).toContain('claude.ai connectors: 2 loaded (Drive, Mail), none called in 2 sessions')
  expect(fs[0]!.fix[0]).toBe('Fix: in .claude/settings.local.json, set "disableClaudeAiConnectors": true. claude.ai connectors are then not fetched or connected in this project.')
})

test('one session is too thin to call a server unused', async () => {
  const tools = [...BUILTIN, ...GH]
  expect(findings(repoWith([session('a', 1, tools)], tools), CFG, { mcpJson: [] })).toEqual([])
})

test('ranking: exact fixes first, each group by estimated tokens; failures, repeats, large results and compactions', async () => {
  const tools = [...BUILTIN, ...GH, ...DOCS, ...DRIVE]
  const sessions = Array.from({ length: 4 }, (_, i) => session(`s${i}`, i, tools, s => {
    s.calls = { Bash: 10, Read: 5, 'mcp__claude_ai_Drive__tool_0': 1 }
    s.fails = { Bash: { n: 2, chars: 4_000 } }
    s.repeats = { Read: { n: 1, chars: 800 } }
    s.large = { Bash: { n: 1, chars: 25_000 } }
    s.compactions = 1
  }))
  const fs = findings(repoWith(sessions, tools), CFG, { mcpJson: [] })
  expect(fs.map(f => f.kind)).toEqual(['large-results', 'unused-server', 'partial-server', 'unused-server', 'failures', 'repeats', 'compactions'])
  expect(fs.slice(0, 4).every(f => f.isExact)).toBe(true)
  expect(fs.slice(4).every(f => !f.isExact)).toBe(true)
  const scores = fs.slice(0, 4).map(f => f.score)
  expect([...scores].sort((a, b) => b - a)).toEqual(scores)
  // GitHub's 40 unused names, then Drive's 23 uncalled ones, then docs' 2.
  expect(fs[1]!.title).toContain('"github"')
  expect(fs[3]!.title).toContain('"docs"')
  expect(fs[0]!.fix[0]).toBe('Fix: in .claude/settings.local.json, set "bashOutputMaxChars": 10000 (default 30000; 4000 to 128000). Output past it is saved to a file, and Claude gets a preview and the path.')
  expect(fs[2]!.title).toBe('MCP server "claude_ai_Drive": 24 tools loaded, 1 called, in 4 sessions')
  expect(fs[2]!.fix[0]).toContain('add one "permissions"."deny" rule per uncalled tool (23 rules): "mcp__claude_ai_Drive__tool_1"')
  expect(fs[2]!.fix[0]).toContain('and 11 more of this server\'s uncalled tools.')
  expect(fs[4]!.title).toBe('Tool "Bash": 8 of 40 calls failed or were refused, in 4 sessions (~4,000 est. tokens of error text)')
  expect(fs[4]!.fix).toEqual(['No exact settings fix: the calls themselves fail.'])
  expect(fs[5]!.fix).toEqual(['No exact settings fix: a repeat can be legitimate (a re-read after an edit).'])
  expect(fs[6]!.title).toBe('Compactions: 4 in 4 sessions (at most 1 in one)')
})

test('large MCP results name MAX_MCP_OUTPUT_TOKENS; other tools say there is no exact fix; repeated failures name loop-breaker', async () => {
  const tools = [...BUILTIN, ...DOCS]
  const sessions = Array.from({ length: 3 }, (_, i) => session(`s${i}`, i, tools, s => {
    s.calls = { 'mcp__docs__read': 2, Read: 1, Bash: 2 }
    s.large = { 'mcp__docs__read': { n: 1, chars: 50_000 }, Read: { n: 1, chars: 30_000 } }
    s.repeats = { Bash: { n: 1, chars: 10 } }
    s.failedRepeats = { Bash: 1 }
  }))
  const fs = findings(repoWith(sessions, tools), CFG, { mcpJson: [] })
  const mcp = fs.find(f => f.title.startsWith('Tool "mcp__docs__read"'))!
  expect(mcp.fix[0]).toBe('Fix: in .claude/settings.local.json, set "env": { "MAX_MCP_OUTPUT_TOKENS": "3000" } (default 25000). It caps every MCP tool\'s result in this project, not only this tool\'s.')
  const read = fs.find(f => f.title.startsWith('Tool "Read"'))!
  expect(read.isExact).toBe(false)
  expect(read.fix[0]).toBe('No exact settings fix: Claude Code has no settings key that caps Read results. Asking for narrower reads or searches is the lever.')
  const rep = fs.find(f => f.kind === 'repeats')!
  expect(rep.fix[0]).toBe('No settings key stops repeats. loop-breaker in this marketplace tells Claude to change approach after a repeated failure: /plugin install loop-breaker --marketplace thehumanworks/claude-mods')
})

test('the report: header, ranked list, and the empty cases', async () => {
  const tools = [...BUILTIN, ...GH]
  const repo = repoWith([session('a', 1, tools), session('b', 2, tools)], tools)
  const text = reportText(repo, findings(repo, CFG, { mcpJson: [] }), { windowSessions: 20 })
  expect(text.split('\n')[0]).toBe('efficiency for /work/app: 2 sessions in the window (the latest 20 are kept; 2 seen in all).')
  expect(text).toContain('\n1. MCP server "github": loaded in 2 of 2 sessions')
  expect(text).toContain('\n   Fix: in .claude/settings.local.json, add "mcp__github" to "permissions"."deny".')
  expect(reportText(emptyRepo(ROOT, 0), [], { windowSessions: 20 })).toBe('No sessions recorded for /work/app yet. The mod records from the next session on.')
  expect(reportText(repoWith([session('a', 1, BUILTIN)], BUILTIN), [], { windowSessions: 20 })).toContain('No waste found')
})

test("a server's configured name, from its tools' descriptions, makes the /mcp disable line exact", { options: { useModel: false } }, async ($, on) => {
  const tools = [...BUILTIN, 'mcp__my_notes__find', 'mcp__my_notes__open']
  const h = engine(on, { gitRoot: ROOT, tools })
  await $.tool.describe({ tool: 'mcp__my_notes__find', description: 'Find.', isDeferred: true, provider: { plugin: 'mcp:my notes', tier: 'user' } } as never)
  // A provider whose name does not normalize to the tool's server is not taken.
  await $.tool.describe({ tool: 'mcp__my_notes__open', description: 'Open.', provider: { plugin: 'mcp:other', tier: 'user' } } as never)
  await h.session($, 'n1', () => h.call($, 'Read', { file_path: '/a' }))
  await h.session($, 'n2', () => h.call($, 'Read', { file_path: '/b' }))
  const text = await h.command($)
  expect(text).toContain('1. MCP server "my_notes": loaded in 2 of 2 sessions (2 tools,')
  expect(text).toContain('   Or stop it in this project: run /mcp disable my notes (Claude Code keeps that under "disabledMcpServers" in this project\'s entry of ~/.claude.json; /mcp enable my notes undoes it).')
})

test('/efficiency reads only the server names of .mcp.json', { options: { useModel: false } }, async ($, on) => {
  const tools = [...BUILTIN, 'mcp__pg__query']
  const h = engine(on, { gitRoot: ROOT, tools, files: { [`${ROOT}/.mcp.json`]: JSON.stringify({ mcpServers: { pg: { command: 'pg-mcp', env: { PASSWORD: 'hunter2' } } } }) } })
  await h.session($, 'p1', () => h.call($, 'Read', { file_path: '/a' }))
  await h.session($, 'p2', () => h.call($, 'Read', { file_path: '/b' }))
  const text = await h.command($)
  expect(text).toContain('add "pg" to "disabledMcpjsonServers" in .claude/settings.local.json.')
  expect(text).not.toContain('hunter2')
  expect(JSON.stringify([...h.store.values()])).not.toContain('hunter2')
})

// ---------------------------------------------------------------------------
// The model step

const SEEDED = (n = 3) => {
  const tools = [...BUILTIN, ...GH]
  let repo = emptyRepo(ROOT, 0)
  for (let i = 0; i < n; i++) repo = mergeSession(repo, session(`old${i}`, i, tools), listing(tools).byServer, {}, 20, i)
  return { [`repo:${ROOT}`]: repo, index: { [ROOT]: 1 } }
}

test('the question is capped and carries the findings; the answer is checked against them', async () => {
  const tools = [...BUILTIN, ...Array.from({ length: 49 }, (_, i) => `mcp__server_${i}_${'n'.repeat(60)}__t`)]
  const repo = repoWith([session('a', 1, tools), session('b', 2, tools)], tools)
  const q = questionText(repo, findings(repo, CFG, { mcpJson: [] }), { windowSessions: 20 })
  expect(q.length + SYSTEM.length).toBeLessThanOrEqual(MAX_INPUT_CHARS)
  const question = 'Fix: add "mcp__github" to "permissions"."deny" in .claude/settings.local.json'
  expect(checkAnswer('1. Deny github [1].\n2. Set enableAllProjectMcpServers to false.\n3. Raise MAX_MCP_OUTPUT_TOKENS.', question)).toEqual({ text: '1. Deny github [1].', dropped: 2 })
  expect(checkAnswer('```\n1. Deny it [1].\n```', question)).toEqual({ text: '1. Deny it [1].', dropped: 0 })
  expect(checkAnswer('Set deniedMcpServers.', question)).toBeUndefined()
  expect(checkAnswer('  ', question)).toBeUndefined()
})

test('/efficiency: the code list first, then the model step on opus by default', async ($, on) => {
  const h = engine(on, { gitRoot: ROOT, tools: [...BUILTIN, ...GH], store: SEEDED(), answer: '1. Add "mcp__github" to "permissions"."deny" in .claude/settings.local.json [1].' })
  await h.session($, 'now')
  const text = await h.command($)
  expect(h.seen.asked.length).toBe(1)
  const asked = h.seen.asked[0]!
  expect(asked.model).toBe('opus')
  expect(asked.maxTokens).toBe(600)
  expect(asked.timeoutMs).toBe(60_000)
  expect(asked.system).toBe(SYSTEM)
  expect(asked.prompt).toContain('mcp__github')
  expect(asked.prompt.length + asked.system.length).toBeLessThanOrEqual(MAX_INPUT_CHARS)
  const code = text.indexOf('1. MCP server "github": loaded in 4 of 4 sessions')
  const model = text.indexOf('Recommendations from opus, drawn only from the fixes above:\n1. Add "mcp__github"')
  expect(code).toBeGreaterThan(0)
  expect(model).toBeGreaterThan(code)
})

test('the model is a setting', { options: { model: 'haiku', timeoutSeconds: 10 } }, async ($, on) => {
  const h = engine(on, { gitRoot: ROOT, tools: [...BUILTIN, ...GH], store: SEEDED() })
  await h.session($, 'now')
  await h.command($)
  expect(h.seen.asked[0]!.model).toBe('haiku')
  expect(h.seen.asked[0]!.timeoutMs).toBe(10_000)
})

for (const [label, answer, why] of [
  ['an API error', { fail: 'api-error' }, 'the call failed (529 overloaded)'],
  ['a timeout', { fail: 'aborted' }, 'no answer in 60s'],
  ['an empty reply', { fail: 'empty-reply' }, 'it answered nothing'],
  ['a throw', 'throw', 'it could not be called ('],
  ['an answer naming only invented keys', 'Set deniedMcpServers in managed settings.', 'its answer named settings the findings do not, so none of it is shown'],
] as const) {
  test(`the model step fails on ${label}: the code-only list is shown`, async ($, on) => {
    const h = engine(on, { gitRoot: ROOT, tools: [...BUILTIN, ...GH], store: SEEDED(), answer })
    await h.session($, 'now')
    const text = await h.command($)
    expect(text).toContain('1. MCP server "github"')
    expect(text).toContain(`(No recommendations from opus: ${why}`)
    expect(text).toContain("The list above is the code's own and complete.)")
    expect(text).not.toContain('Recommendations from opus, drawn')
  })
}

test('useModel off: no model call, the code list alone', { options: { useModel: false } }, async ($, on) => {
  const h = engine(on, { gitRoot: ROOT, tools: [...BUILTIN, ...GH], store: SEEDED() })
  await h.session($, 'now')
  const text = await h.command($)
  expect(h.seen.asked.length).toBe(0)
  expect(text).toContain('1. MCP server "github"')
  expect(text).not.toContain('Recommendations')
  expect(text).not.toContain('No recommendations')
})

test('the model never runs in the background', async ($, on) => {
  const h = engine(on, { gitRoot: ROOT, tools: [...BUILTIN, ...GH], store: SEEDED() })
  for (let i = 0; i < 3; i++) await h.session($, `bg${i}`, () => h.call($, 'Bash', { command: 'ls', fail: true }))
  await h.clock.advance(3_600_000)
  expect(h.seen.asked.length).toBe(0)
})

test('no model call when there is nothing to advise on', async ($, on) => {
  const h = engine(on, { cwd: '/tmp/quiet' })
  await h.session($, 'q1', () => h.call($, 'Read', { file_path: '/q' }))
  const text = await h.command($)
  expect(text).toContain('No waste found')
  expect(h.seen.asked.length).toBe(0)
})

test('the mod never blocks or changes a turn, a tool result or the context', async ($, on) => {
  const h = engine(on, { gitRoot: ROOT })
  await $.session.start({ cwd: '/work/app/src', surface: null, isInteractive: false } as never)
  const described = await $.tool.describe({ tool: 'mcp__github__op_1', description: 'Op.', isDeferred: true, provider: { plugin: 'mcp:github', tier: 'user' } } as never)
  expect(described).toEqual({ description: 'Op.', isDeferred: true })
  const result = await $.tool.call({ tool: 'Bash', tool_use_id: 'toolu_x', command: 'ls', size: 7 } as never)
  expect(result).toEqual({ result: {}, text: 'xxxxxxx' })
  expect(h.seen.registered).toEqual(['efficiency'])
})

// ---------------------------------------------------------------------------
// Disabled

test('disabled: nothing is recorded, no command, no model call', { options: { enabled: false } }, async ($, on) => {
  const h = engine(on, { gitRoot: ROOT, tools: [...BUILTIN, ...GH] })
  await h.session($, 'off', async () => {
    await h.call($, 'Bash', { command: 'ls', fail: true })
    await h.compact($)
  })
  expect(h.seen.registered).toEqual([])
  expect([...h.store.keys()]).toEqual([])
  expect(h.seen.asked.length).toBe(0)
})
