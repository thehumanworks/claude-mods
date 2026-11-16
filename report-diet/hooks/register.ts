// The report diet: when a subagent's report reaches the agent that started it
// and is longer than maxChars, the whole text is saved to a file in the system
// temp folder, and the parent reads the start, a marker with the file's path,
// and the end. The subagent is never asked to do anything differently.
//
// Two doors: a foreground Agent call's result (`tool.call`), and a background
// agent's `<task-notification>` (`session.append`), for a call this mod saw
// launched. Errors, failed or stopped agents and excluded types are left whole,
// and so is anything the mod could not save.

import type { EngineInterface, Register } from 'claude-code'
import { $name, cut, FILE_MAX_AGE_MS, FILE_RE, fileNameFor, FILES_MAX, fileText, isExcluded, parseNotification, reportOf, resolveConfig, type Config } from './diet.js'

type $ = EngineInterface

const AGENT_TOOLS = new Set(['Agent', 'Task'])
/** Background calls remembered at most, until their notification arrives. */
const PENDING_MAX = 500
const CLEAN_EVERY_MS = 60 * 60 * 1000
const SUBDIR = 'claude-report-diet'

type About = { agentType?: string; description?: string }
type Runtime = { config: Config; dir?: string; cleanedAt?: number; pending: Map<string, About> }

export const register: Register = (on, options) => {
  const { config, problems } = resolveConfig(options)
  if (!config.enabled) return
  const rt: Runtime = { config, pending: new Map() }

  if (problems.length > 0) {
    on('session.start', async ($, e, next) => {
      const started = await next(e)
      for (const problem of problems) $.ui.log(`${$name}: ${problem}`)
      return started
    }).catch(($, e, next) => next(e))
  }

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (!AGENT_TOOLS.has(e.tool)) return ran
    // The model's own call only: a plugin's `$.tool.call` is left alone.
    if (next.origin.plugin !== 'engine' || typeof e.tool_use_id !== 'string' || e.tool_use_id === '') return ran
    if (ran.deny !== undefined || ran.isError === true) return ran
    const input = e as unknown as Record<string, unknown>
    const about: About = {
      ...(typeof input.subagent_type === 'string' && { agentType: input.subagent_type }),
      ...(typeof input.description === 'string' && { description: input.description }),
    }
    if (isExcluded(about.agentType, config.exclude)) return ran
    const record = ran.result as unknown as Record<string, unknown> | undefined
    if (record?.status === 'async_launched') {
      if (rt.pending.size >= PENDING_MAX) rt.pending.delete(rt.pending.keys().next().value!)
      rt.pending.set(e.tool_use_id, about)
      return ran
    }
    const report = reportOf(record)
    if (report === undefined || report.length <= config.maxChars) return ran
    const path = await save($, rt, e.tool_use_id, report, about)
    if (path === undefined) return ran
    debug($, `cut ${e.tool_use_id}: ${report.length} chars, saved to ${path}`)
    return {
      result: { ...record, content: [{ type: 'text', text: cut(report, path, config) }] } as unknown as typeof ran.result,
      ...(ran.context !== undefined && { context: ran.context }),
    } as typeof ran
  }).catch(($, e, next) => next(e))

  on('session.append', async ($, e, next) => {
    if (rt.pending.size === 0 || e.origin.kind !== 'task-notification') return next(e)
    const content = [...e.message.content]
    let changed = false
    for (const [i, block] of content.entries()) {
      const text = (block as { type?: unknown; text?: unknown }).text
      if (block.type !== 'text' || typeof text !== 'string') continue
      const n = parseNotification(text)
      const about = n === undefined ? undefined : rt.pending.get(n.toolUseId)
      if (n === undefined || about === undefined) continue
      rt.pending.delete(n.toolUseId)
      // A failed or stopped agent's notification is an error: left whole.
      if (n.status !== 'completed') continue
      const report = n.result.replace(/^\n+|\n+$/g, '')
      if (report.length <= config.maxChars) continue
      const path = await save($, rt, n.toolUseId, report, about)
      if (path === undefined) continue
      debug($, `cut the notification of ${n.toolUseId}: ${report.length} chars, saved to ${path}`)
      content[i] = { ...block, text: `${text.slice(0, n.start)}\n${cut(report, path, config)}\n${text.slice(n.end)}` } as typeof block
      changed = true
    }
    return next(changed ? { ...e, message: { ...e.message, content } } : e)
  }).catch(($, e, next) => next(e))
}

/** Saves the whole report; the file's path, or undefined when it could not be saved. Never throws. */
async function save($: $, rt: Runtime, toolUseId: string, report: string, about: About): Promise<string | undefined> {
  try {
    const dir = await saveDir($, rt)
    if (dir === undefined) return undefined
    const path = joinPath(dir, fileNameFor(toolUseId))
    await $.fs.write(path, fileText(report, about))
    await clean($, rt, dir).catch(err => debug($, `clean: ${messageOf(err)}`))
    return path
  } catch (err) {
    debug($, `could not save ${toolUseId}: ${messageOf(err)}`)
    return undefined
  }
}

/** `claude-report-diet` in the system temp folder, outside the repository; undefined if that is a link. */
async function saveDir($: $, rt: Runtime): Promise<string | undefined> {
  if (rt.dir !== undefined) return rt.dir
  const windows = /^(?:[A-Za-z]:[\\/]|\\\\)/.test(await $.session.root())
  const argv = windows ? ['cmd', '/d', '/c', 'echo %TEMP%'] : ['sh', '-c', 'printf %s "${TMPDIR:-/tmp}"']
  const r = await $.process.run(argv, { timeoutMs: 10_000 }).catch(() => undefined)
  const tmp = r?.exitCode === 0 ? r.stdout.trim().replace(/[\\/]+$/, '') : ''
  const base = tmp !== '' && !tmp.includes('%') ? tmp : windows ? undefined : '/tmp'
  if (base === undefined) return undefined
  const dir = joinPath(base, SUBDIR)
  const stat = await $.fs.stat(dir).catch(() => undefined)
  if (stat !== undefined && (stat.kind !== 'dir' || stat.isLink === true)) return undefined
  rt.dir = dir
  return dir
}

/** Removes saved files past FILE_MAX_AGE_MS and past the newest FILES_MAX; at most once an hour. */
async function clean($: $, rt: Runtime, dir: string): Promise<void> {
  const now = Date.now()
  if (rt.cleanedAt !== undefined && now - rt.cleanedAt < CLEAN_EVERY_MS) return
  rt.cleanedAt = now
  const files = (await $.fs.list(dir))
    .filter(f => f.kind === 'file' && !f.isLink && FILE_RE.test(f.name))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
  const old = files.filter((f, i) => i >= FILES_MAX || now - f.mtimeMs > FILE_MAX_AGE_MS).map(f => joinPath(dir, f.name))
  if (old.length === 0) return
  const windows = dir.includes('\\')
  const argv = windows ? ['cmd', '/d', '/c', 'del', '/q', ...old] : ['rm', '-f', '--', ...old]
  const r = await $.process.run(argv, { timeoutMs: 10_000 }).catch(() => undefined)
  if (r?.exitCode !== 0) debug($, `could not remove ${old.length} old file(s)`)
}

function joinPath(dir: string, name: string): string {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/'
  return `${dir}${sep}${name}`
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
