#!/usr/bin/env node
// Live evals for the mods: runs real `claude -p` sessions on Haiku or Sonnet
// in a throwaway repository, with a mod loaded, then checks what reached the
// model (session transcript), the debug log, and the files the sessions left
// behind. See EVALS.md for how to run it and the scenario format.
//
// Node 22, no dependencies.

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
const STORE_DIR = join(CONFIG_DIR, 'plugins', 'store')
const PROJECTS_DIR = join(CONFIG_DIR, 'projects')
const MODELS = ['haiku', 'sonnet']
const FORBIDDEN = /\b(opus|fable|mythos)\b/i
// Inherited variables that could quietly map an alias to another model.
const SCRUBBED_ENV = ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL']
const SOURCES = ['transcript', 'rows', 'attachments', 'toolResults', 'assistant', 'result', 'debug', 'repo', 'store']

const color = process.stdout.isTTY ? (c, s) => `\x1b[${c}m${s}\x1b[0m` : (_c, s) => s
const PASS = color('32', 'PASS')
const FAIL = color('31', 'FAIL')

// ---------------------------------------------------------------- arguments

function usage() {
  return `Usage: node scripts/live-eval.mjs [--keep] [--list] [--only <name>] [<mod> | <scenario.json> ...]

  <mod>            run every scenario in <mod>/evals/*.json
  <scenario.json>  run one scenario file
  (nothing)        run every scenario of every mod
  --only <name>    run only scenarios with this name (repeatable)
  --keep           keep the temp repo, transcripts, debug logs and store files
  --list           list the scenarios found and exit
  --verbose        echo the claude command lines and each turn's result`
}

function parseArgs(argv) {
  const opts = { keep: false, list: false, verbose: false, only: [], targets: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--keep') opts.keep = true
    else if (a === '--list') opts.list = true
    else if (a === '--verbose' || a === '-v') opts.verbose = true
    else if (a === '--only') opts.only.push(argv[++i])
    else if (a === '-h' || a === '--help') {
      console.log(usage())
      process.exit(0)
    } else if (a.startsWith('-')) throw new Error(`unknown option ${a}\n${usage()}`)
    else opts.targets.push(a)
  }
  return opts
}

function scenarioFiles(targets) {
  const fromMod = dir => {
    const evals = join(dir, 'evals')
    if (!existsSync(evals)) return []
    // Only top-level *.json that look like scenarios: async-compaction/evals holds another harness.
    return readdirSync(evals)
      .filter(f => f.endsWith('.json'))
      .map(f => join(evals, f))
      .filter(f => {
        try {
          return Array.isArray(JSON.parse(readFileSync(f, 'utf8')).sessions)
        } catch {
          return false
        }
      })
  }
  if (targets.length === 0) {
    return readdirSync(REPO, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.') && existsSync(join(REPO, d.name, '.claude-plugin', 'plugin.json')))
      .flatMap(d => fromMod(join(REPO, d.name)))
  }
  return targets.flatMap(t => {
    const p = resolve(t)
    if (existsSync(p) && statSync(p).isFile()) return [p]
    const dir = existsSync(p) ? p : join(REPO, t)
    if (!existsSync(dir)) throw new Error(`no such mod or scenario: ${t}`)
    const found = fromMod(dir)
    if (found.length === 0) throw new Error(`no scenarios in ${join(dir, 'evals')}`)
    return found
  })
}

// ---------------------------------------------------------------- scenarios

function pluginNameOf(dir) {
  const manifest = join(dir, '.claude-plugin', 'plugin.json')
  if (!existsSync(manifest)) throw new Error(`${dir} is not a plugin folder (no .claude-plugin/plugin.json)`)
  return JSON.parse(readFileSync(manifest, 'utf8')).name
}

/** Reads and checks a scenario before anything runs. Throws with every problem found. */
function loadScenario(file) {
  const s = JSON.parse(readFileSync(file, 'utf8'))
  const problems = []
  const modDir = resolve(dirname(file), '..')
  s.file = file
  s.name ??= basename(file, '.json')
  s.modDir = s.plugin ? resolve(dirname(file), s.plugin) : modDir
  s.setup ??= {}
  if (!Array.isArray(s.sessions) || s.sessions.length === 0) problems.push('"sessions" must be a non-empty array')
  const scan = (where, value) => {
    // Refuse a forbidden model hiding in plugin options or env (a mod's own `model` setting, ANTHROPIC_MODEL, ...).
    const text = JSON.stringify(value ?? {})
    const m = text.match(FORBIDDEN)
    if (m) problems.push(`${where} mentions "${m[0]}": live evals run on haiku or sonnet only`)
  }
  for (const [i, sess] of (s.sessions ?? []).entries()) {
    const at = `sessions[${i}]${sess.name ? ` (${sess.name})` : ''}`
    sess.name ??= `session ${i + 1}`
    const model = sess.model ?? 'haiku'
    if (FORBIDDEN.test(String(model))) problems.push(`${at}: model "${model}" is refused. Live evals run on haiku or sonnet only (cost); opus, fable and mythos are never used`)
    else if (!MODELS.includes(model)) problems.push(`${at}: model "${model}" is not allowed; use "haiku" or "sonnet"`)
    sess.model = model
    sess.turns ??= sess.prompt !== undefined ? [sess.prompt] : undefined
    if (!Array.isArray(sess.turns) || sess.turns.length === 0 || sess.turns.some(t => typeof t !== 'string')) problems.push(`${at}: needs "prompt" (a string) or "turns" (strings; a turn may be a slash command such as "/compact")`)
    scan(`${at}.options`, sess.options)
    scan(`${at}.pluginOptions`, sess.pluginOptions)
    scan(`${at}.env`, sess.env)
    for (const d of sess.pluginDirs ?? []) {
      const p = resolve(REPO, d)
      if (!existsSync(join(p, '.claude-plugin', 'plugin.json'))) problems.push(`${at}: plugin dir ${d} is not a plugin folder`)
    }
    for (const [j, a] of (sess.assert ?? []).entries()) {
      const aat = `${at}.assert[${j}]`
      if (!SOURCES.includes(a.in)) problems.push(`${aat}: "in" must be one of ${SOURCES.join(', ')}`)
      for (const k of ['matches', 'notMatches']) {
        if (a[k] === undefined) continue
        try {
          new RegExp(a[k], a.flags ?? '')
        } catch (err) {
          problems.push(`${aat}: bad ${k} regex: ${err.message}`)
        }
      }
      if (a.in === 'repo' && typeof a.path !== 'string') problems.push(`${aat}: "repo" needs "path" (a glob relative to the temp repo)`)
      if (a.matches === undefined && a.notMatches === undefined && a.count === undefined && a.exists === undefined) problems.push(`${aat}: give matches, notMatches, count or exists`)
    }
  }
  try {
    s.pluginName = pluginNameOf(s.modDir)
  } catch (err) {
    problems.push(err.message)
  }
  if (problems.length > 0) throw new Error(`${relative(REPO, file)}:\n  - ${problems.join('\n  - ')}`)
  return s
}

// ---------------------------------------------------------------- store

function snapshotStore(prefixes) {
  const snap = new Map()
  if (!existsSync(STORE_DIR)) return snap
  for (const f of readdirSync(STORE_DIR)) {
    if (!prefixes.some(p => f.startsWith(`${p}_inline-`))) continue
    try {
      snap.set(f, readFileSync(join(STORE_DIR, f)))
    } catch {
      // Gone between listing and reading.
    }
  }
  return snap
}

/** Store files of these plugins created or changed since `before`. */
function storeChanges(before, prefixes) {
  const now = snapshotStore(prefixes)
  const created = [...now.keys()].filter(f => !before.has(f))
  const changed = [...now.keys()].filter(f => before.has(f) && !before.get(f).equals(now.get(f)))
  return { created, changed, now }
}

function restoreStore(before, prefixes) {
  const { created, changed } = storeChanges(before, prefixes)
  for (const f of created) rmSync(join(STORE_DIR, f), { force: true })
  for (const f of changed) writeFileSync(join(STORE_DIR, f), before.get(f))
  return { created, changed }
}

// ---------------------------------------------------------------- running a session

async function writeSetup(repo, setup) {
  mkdirSync(repo, { recursive: true })
  for (const [path, content] of Object.entries(setup.files ?? {})) {
    const p = join(repo, path)
    if (!p.startsWith(repo + sep)) throw new Error(`setup file ${path} leaves the repo`)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content, null, 2))
  }
  if (setup.git !== false) {
    const git = args => run('git', args, repo)
    await git(['init', '-q', '-b', 'main'])
    await git(['add', '-A'])
    if (setup.commit !== false) await git(['-c', 'user.name=live-eval', '-c', 'user.email=live-eval@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'setup'])
  }
}

function run(cmd, args, cwd) {
  return new Promise((ok, fail) => {
    const c = spawn(cmd, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    c.stderr.on('data', d => (err += d))
    c.on('error', fail)
    c.on('exit', code => (code === 0 ? ok() : fail(new Error(`${cmd} ${args.join(' ')}: exit ${code}\n${err}`))))
  })
}

let activeChild = null

function sessionArgs(scenario, sess, sessionId, debugFile) {
  const pluginDirs = [scenario.modDir, ...(sess.pluginDirs ?? []).map(d => resolve(REPO, d))]
  const pluginConfigs = {}
  if (sess.options) pluginConfigs[scenario.pluginName] = { options: sess.options }
  for (const [name, options] of Object.entries(sess.pluginOptions ?? {})) pluginConfigs[name] = { options }
  const args = ['-p', '--model', sess.model, '--session-id', sessionId, '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose']
  for (const d of pluginDirs) args.push('--plugin-dir', d)
  if (Object.keys(pluginConfigs).length > 0 || sess.settings) args.push('--settings', JSON.stringify({ ...(sess.settings ?? {}), pluginConfigs }))
  const allowed = sess.allowedTools ?? []
  if (allowed.length > 0) args.push('--allowedTools', ...allowed)
  // Only the listed tools exist in the session (no Agent tool, so no subagent on another model).
  const tools = [...new Set(allowed.map(t => t.replace(/\(.*$/, '')))]
  args.push('--tools', tools.join(','))
  // Isolated from the user's own settings, plugins and MCP servers unless the scenario says otherwise.
  args.push('--setting-sources', sess.settingSources ?? '')
  if (sess.strictMcp !== false) args.push('--strict-mcp-config')
  if (debugFile) {
    if (typeof sess.debug === 'string') args.push('--debug', sess.debug)
    args.push('--debug-file', debugFile)
  }
  return args
}

/**
 * One session: the turns go in as stream-json on stdin, one after each result, so a
 * slash command (`/compact`) works as a follow-up turn; stdin closes after the last
 * result and the process runs its exit hooks.
 */
function runSession(scenario, sess, repo, artifacts, index, verbose, sessionId) {
  const wantsDebug = sess.debug !== undefined ? sess.debug !== false : (sess.assert ?? []).some(a => a.in === 'debug')
  const debugFile = wantsDebug ? join(artifacts, `session-${index + 1}.debug.log`) : null
  const streamFile = join(artifacts, `session-${index + 1}.stream.jsonl`)
  const args = sessionArgs(scenario, sess, sessionId, debugFile)
  const env = { ...process.env }
  for (const k of SCRUBBED_ENV) delete env[k]
  Object.assign(env, Object.fromEntries(Object.entries(sess.env ?? {}).map(([k, v]) => [k, String(v)])))
  if (verbose) console.log(color('2', `    $ ${Object.entries(sess.env ?? {}).map(([k, v]) => `${k}=${v} `).join('')}claude ${args.map(a => (/[\s{"]/.test(a) ? `'${a}'` : a)).join(' ')}`))

  return new Promise(done => {
    const started = Date.now()
    const child = spawn('claude', args, { cwd: repo, env, stdio: ['pipe', 'pipe', 'pipe'] })
    activeChild = child
    const results = []
    const out = []
    let stderr = ''
    let buf = ''
    let next = 0
    let timedOut = false
    const send = () => {
      const text = sess.turns[next++]
      child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`)
    }
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 5000).unref()
    }, (sess.timeoutSeconds ?? 300) * 1000)
    child.stdout.on('data', d => {
      buf += d
      let n
      while ((n = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, n)
        buf = buf.slice(n + 1)
        out.push(line)
        let msg
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        if (msg.type !== 'result') continue
        results.push(msg)
        if (verbose) console.log(color('2', `    turn ${results.length}: ${msg.subtype}${msg.is_error ? ' (error)' : ''} $${msg.total_cost_usd ?? '?'} ${JSON.stringify(String(msg.result ?? '').slice(0, 120))}`))
        if (next < sess.turns.length) send()
        else child.stdin.end()
      }
    })
    child.stderr.on('data', d => (stderr += d))
    child.stdin.on('error', () => {})
    child.on('error', err => {
      stderr += String(err)
    })
    child.on('close', code => {
      clearTimeout(timer)
      activeChild = null
      writeFileSync(streamFile, out.join('\n'))
      done({ sessionId, code, timedOut, results, stderr, debugFile, streamFile, ms: Date.now() - started })
    })
    send()
  })
}

// ---------------------------------------------------------------- what the session left

function findTranscript(sessionId) {
  if (!existsSync(PROJECTS_DIR)) return null
  for (const d of readdirSync(PROJECTS_DIR)) {
    const f = join(PROJECTS_DIR, d, `${sessionId}.jsonl`)
    if (existsSync(f)) return f
  }
  return null
}

const textOf = content => {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(c => (typeof c === 'string' ? c : c?.text ?? JSON.stringify(c))).join('\n')
  return content === undefined ? '' : JSON.stringify(content)
}

function evidence(run) {
  const raw = run.transcript ? readFileSync(run.transcript, 'utf8') : ''
  const lines = raw.split('\n').filter(Boolean)
  const rows = lines.map(l => {
    try {
      return JSON.parse(l)
    } catch {
      return null
    }
  }).filter(Boolean)
  const blocks = (row, type) => (Array.isArray(row.message?.content) ? row.message.content.filter(b => b?.type === type) : [])
  return {
    lines,
    rows,
    attachments: rows.filter(r => r.attachment).map(r => r.attachment),
    toolResults: rows.flatMap(r => (r.type === 'user' ? blocks(r, 'tool_result') : [])).map(b => textOf(b.content)),
    assistant: rows.flatMap(r => (r.type === 'assistant' ? blocks(r, 'text') : [])).map(b => b.text),
    result: run.results.map(r => String(r.result ?? '')),
    debug: run.debugFile && existsSync(run.debugFile) ? readFileSync(run.debugFile, 'utf8').split('\n') : [],
  }
}

function globToRegExp(glob) {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*'
      i++
      if (glob[i + 1] === '/') i++
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

function walk(dir, base = dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap(d => {
    const p = join(dir, d.name)
    if (d.isDirectory()) return d.name === '.git' ? [] : walk(p, base)
    return [relative(base, p).split(sep).join('/')]
  })
}

// ---------------------------------------------------------------- assertions

function countOk(count, n) {
  if (count === undefined) return true
  if (typeof count === 'number') return n === count
  return (count.min === undefined || n >= count.min) && (count.max === undefined || n <= count.max)
}

const countText = c => (typeof c === 'number' ? `${c}` : [c.min !== undefined && `>=${c.min}`, c.max !== undefined && `<=${c.max}`].filter(Boolean).join(' and '))

function describe(a) {
  if (a.label) return a.label
  const parts = [a.in]
  if (a.type) parts.push(`type=${a.type}`)
  if (a.path) parts.push(a.path)
  if (a.plugin) parts.push(a.plugin)
  if (a.exists !== undefined) parts.push(a.exists ? 'exists' : 'absent')
  if (a.matches !== undefined) parts.push(`~ /${a.matches}/`)
  if (a.notMatches !== undefined) parts.push(`!~ /${a.notMatches}/`)
  if (a.count !== undefined) parts.push(`count ${countText(a.count)}`)
  return parts.join(' ')
}

/** Checks one assertion. Returns [ok, detail]. */
function check(a, ev, ctx) {
  // {{repo}} in a regex stands for the temp repo's path, escaped.
  const expand = src => src.replaceAll('{{repo}}', ctx.repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const re = a.matches !== undefined ? new RegExp(expand(a.matches), a.flags ?? '') : null
  const notRe = a.notMatches !== undefined ? new RegExp(expand(a.notMatches), a.flags ?? '') : null

  if (a.in === 'repo' || a.in === 'store') {
    let files
    if (a.in === 'repo') {
      const g = globToRegExp(a.path)
      files = walk(ctx.repo).filter(f => g.test(f)).map(f => ({ name: f, content: () => readFileSync(join(ctx.repo, f), 'utf8') }))
    } else {
      const plugin = a.plugin ?? ctx.scenario.pluginName
      const { created, changed, now } = storeChanges(ctx.storeBefore, ctx.prefixes)
      files = [...created, ...changed].filter(f => f.startsWith(`${plugin}_inline-`)).map(f => ({ name: f, content: () => now.get(f).toString('utf8') }))
    }
    const n = files.length
    if (a.exists === false) return [n === 0, n === 0 ? 'none' : `found ${files.map(f => f.name).join(', ')}`]
    if (n === 0) return [false, a.in === 'store' ? 'the eval wrote no store file for this plugin' : 'no such file']
    const hits = files.filter(f => (!re || re.test(f.content())) && (!notRe || !notRe.test(f.content())))
    const want = a.count ?? (re || notRe ? { min: 1 } : undefined)
    const ok = countOk(want, re || notRe ? hits.length : n)
    return [ok, `${hits.length}/${n} file(s) match`]
  }

  let units
  switch (a.in) {
    case 'transcript':
      units = ev.lines
      break
    case 'rows':
      units = ev.rows.filter(r => !a.type || r.type === a.type).map(r => JSON.stringify(r))
      break
    case 'attachments':
      units = ev.attachments.filter(x => !a.type || x.type === a.type).map(x => (x.content !== undefined ? textOf(x.content) : JSON.stringify(x)))
      break
    default:
      units = ev[a.in]
  }
  if (a.in !== 'debug' && ev.rows.length === 0) return [false, 'no transcript found']
  if (a.in === 'debug' && units.length === 0) return [false, 'no debug log']
  const matching = units.filter(u => (!re || re.test(u)) && (!notRe || !notRe.test(u)))
  if (notRe && !re && a.count === undefined) {
    const bad = units.filter(u => notRe.test(u))
    return [bad.length === 0, bad.length === 0 ? `0 of ${units.length} match` : `${bad.length} match, first: ${snippet(bad[0], notRe)}`]
  }
  const want = a.count ?? { min: 1 }
  const ok = countOk(want, matching.length)
  return [ok, `${matching.length} of ${units.length} ${a.in === 'debug' || a.in === 'transcript' ? 'lines' : 'items'} match${!ok && matching[0] ? `, first: ${snippet(matching[0], re)}` : ''}`]
}

function snippet(text, re) {
  const m = re ? text.match(re) : null
  const at = m ? Math.max(0, m.index - 40) : 0
  return JSON.stringify(text.slice(at, at + 140))
}

// ---------------------------------------------------------------- one scenario

async function runScenario(scenario, opts) {
  console.log(`\n${color('1', scenario.name)}  ${color('2', relative(REPO, scenario.file))}`)
  if (scenario.description) console.log(color('2', `  ${scenario.description}`))
  const root = realpathSync(mkdtempSync(join(tmpdir(), `live-eval-${scenario.name.replace(/[^\w-]/g, '_')}-`)))
  const repo = join(root, 'repo')
  const artifacts = join(root, 'artifacts')
  mkdirSync(artifacts, { recursive: true })
  const names = new Set([scenario.pluginName])
  for (const sess of scenario.sessions) for (const d of sess.pluginDirs ?? []) names.add(pluginNameOf(resolve(REPO, d)))
  const prefixes = [...names]
  const storeBefore = snapshotStore(prefixes)
  const sessionIds = []
  let failures = 0
  let cost = 0
  const cleanup = () => {
    const transcripts = sessionIds.map(findTranscript).filter(Boolean)
    // Per-session folders some mods keep beside the store, e.g. ~/.claude/async-compaction/<session id>.
    const sessionDirs = prefixes.flatMap(name => {
      const dir = join(CONFIG_DIR, name)
      if (!existsSync(dir)) return []
      return readdirSync(dir).filter(f => sessionIds.some(id => f.startsWith(id))).map(f => join(dir, f))
    })
    // Claude Code's own per-session folder for Bash.
    for (const id of sessionIds) if (existsSync(join(CONFIG_DIR, 'session-env', id))) sessionDirs.push(join(CONFIG_DIR, 'session-env', id))
    if (opts.keep) {
      const { created, changed } = storeChanges(storeBefore, prefixes)
      console.log(color('2', `  kept: ${root}`))
      for (const p of [...transcripts, ...sessionDirs]) console.log(color('2', `  kept: ${p}`))
      for (const f of created) console.log(color('2', `  kept: ${join(STORE_DIR, f)} (new)`))
      if (changed.length > 0) {
        // The eval changed a store file that was there before: keep the old copy so it can be put back.
        const backup = join(artifacts, 'store-before')
        mkdirSync(backup, { recursive: true })
        for (const f of changed) {
          writeFileSync(join(backup, f), storeBefore.get(f))
          console.log(color('2', `  kept: ${join(STORE_DIR, f)} (changed; the copy from before is ${join(backup, f)})`))
        }
      }
      return
    }
    rmSync(root, { recursive: true, force: true })
    for (const t of transcripts) {
      // The project folder is named after the temp repo, so all of it belongs to this run.
      const dir = dirname(t)
      if (dir.startsWith(PROJECTS_DIR + sep) && basename(dir).includes('live-eval-')) rmSync(dir, { recursive: true, force: true })
    }
    for (const d of sessionDirs) rmSync(d, { recursive: true, force: true })
    const { created, changed } = restoreStore(storeBefore, prefixes)
    if (created.length + changed.length > 0) console.log(color('2', `  store: removed ${created.length} file(s) the eval created${changed.length ? `, restored ${changed.length} it changed` : ''}`))
  }
  const onSignal = () => {
    activeChild?.kill('SIGKILL')
    cleanup()
    process.exit(130)
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  try {
    await writeSetup(repo, scenario.setup)
    for (const [i, sess] of scenario.sessions.entries()) {
      const sessionId = randomUUID()
      sessionIds.push(sessionId)
      const r = await runSession(scenario, sess, repo, artifacts, i, opts.verbose, sessionId)
      r.transcript = findTranscript(sessionId)
      // total_cost_usd is the session's running total.
      const turnCost = Math.max(0, ...r.results.map(x => x.total_cost_usd ?? 0))
      cost += turnCost
      const head = `  ${sess.name} [${sess.model}] ${r.results.length}/${sess.turns.length} turns, ${(r.ms / 1000).toFixed(0)}s, $${turnCost.toFixed(3)}`
      console.log(head)
      const runProblems = []
      if (r.timedOut) runProblems.push(`timed out after ${sess.timeoutSeconds ?? 300}s`)
      if (r.results.length < sess.turns.length) runProblems.push(`only ${r.results.length} of ${sess.turns.length} turns answered (exit ${r.code})${r.stderr ? `: ${r.stderr.trim().split('\n').slice(-3).join(' | ')}` : ''}`)
      for (const x of r.results) if (x.is_error && !sess.allowErrors) runProblems.push(`turn error: ${String(x.result ?? x.subtype).slice(0, 200)}`)
      for (const p of runProblems) {
        failures++
        console.log(`    ${FAIL} session: ${p}`)
      }
      const ev = evidence(r)
      for (const a of sess.assert ?? []) {
        let ok, detail
        try {
          ;[ok, detail] = check(a, ev, { repo, scenario, storeBefore, prefixes })
        } catch (err) {
          ;[ok, detail] = [false, `error: ${err.message}`]
        }
        if (!ok) failures++
        console.log(`    ${ok ? PASS : FAIL} ${describe(a)}  ${color('2', `(${detail})`)}`)
      }
    }
  } catch (err) {
    failures++
    console.log(`    ${FAIL} ${err.stack ?? err}`)
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    cleanup()
  }
  console.log(`  ${failures === 0 ? PASS : FAIL} ${scenario.name}  ${color('2', `$${cost.toFixed(3)}`)}`)
  return { failures, cost }
}

// ---------------------------------------------------------------- main

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  let scenarios = scenarioFiles(opts.targets).map(loadScenario)
  if (opts.only.length > 0) scenarios = scenarios.filter(s => opts.only.includes(s.name))
  if (scenarios.length === 0) throw new Error('no scenarios to run')
  if (opts.list) {
    for (const s of scenarios) console.log(`${s.name}\t${relative(REPO, s.file)}\t${s.sessions.length} session(s)`)
    return 0
  }
  let failed = 0
  let cost = 0
  for (const s of scenarios) {
    const r = await runScenario(s, opts)
    if (r.failures > 0) failed++
    cost += r.cost
  }
  console.log(`\n${failed === 0 ? PASS : FAIL} ${scenarios.length - failed}/${scenarios.length} scenario(s) passed, $${cost.toFixed(3)} in all`)
  return failed === 0 ? 0 : 1
}

main().then(
  code => process.exit(code),
  err => {
    console.error(`live-eval: ${err.message}`)
    process.exit(2)
  },
)
