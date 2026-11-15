// After Claude edits files, the project's own check command runs in the
// background, and what it finds in those files is handed to Claude at its next
// request: after its next tool call, or with the next prompt.

import type { EngineInterface, Register } from 'claude-code'
import { isWatched, judge, normalize, resolveConfig, shellArgv, type Config, type Outcome } from './check.js'

type $ = EngineInterface

/** Edits closer together than this start one check. */
export const DEBOUNCE_MS = 1_500
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])
const $name = 'edit-check'

type Runtime = {
  config: Config
  cwd?: string
  /** Files edited since the last check started, absolute. */
  pending: Set<string>
  timer?: { cancel: () => void }
  /** The check under way; stale once a file is edited while it runs. */
  running?: { isStale: boolean }
  /** The output blocks of the last finished check. */
  previous?: ReadonlySet<string>
  /** What Claude is handed at its next request. */
  report?: Exclude<Outcome, { kind: 'silent' }>
  /** Claude was handed a failure, and not yet that it passes again. */
  failureDelivered: boolean
  /** Toasts already shown, once a session each. */
  warned: Set<string>
}

export const register: Register = (on, options) => {
  const { config, problems } = resolveConfig(options)
  // Off: no check command, so no hook at all.
  if (config.command === '') return
  const rt: Runtime = { config, pending: new Set(), failureDelivered: false, warned: new Set() }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    for (const problem of problems) $.ui.log(`${$name}: ${problem}`)
    return started
  })

  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    try {
      if (result.deny !== undefined) return result
      if (EDIT_TOOLS.has(e.tool) && result.isError !== true) {
        const input = e as { file_path?: unknown; notebook_path?: unknown }
        const path = typeof input.file_path === 'string' ? input.file_path : input.notebook_path
        if (typeof path === 'string' && path !== '') await edited($, rt, path)
      }
      // A subagent's edits count, but what the check finds is the main loop's to read.
      if (e.agentId === undefined && rt.report !== undefined) {
        return { ...result, context: [...(result.context ?? []), take(rt)] } as typeof result
      }
    } catch (err) {
      debug($, `tool.call: ${messageOf(err)}`)
    }
    return result
  }).catch(($, e, next) => next(e))

  // A check that finished after Claude's last tool call reaches it with the next prompt.
  on('prompt.submit', ($, e, next) => {
    if (rt.report === undefined || e.command !== undefined) return next(e)
    return next({ ...e, context: [...(e.context ?? []), take(rt)] })
  }).catch(($, e, next) => next(e))
}

/** Counts an edit and starts the check once edits stop for DEBOUNCE_MS. */
async function edited($: $, rt: Runtime, path: string): Promise<void> {
  const cwd = (rt.cwd ??= await $.session.cwd())
  const abs = /^([/\\]|[A-Za-z]:)/.test(path) ? normalize(path) : `${normalize(cwd)}/${normalize(path).replace(/^\.\//, '')}`
  if (!isWatched(rt.config.globs, cwd, abs)) return
  rt.pending.add(abs)
  if (rt.running !== undefined) rt.running.isStale = true
  schedule($, rt)
}

function schedule($: $, rt: Runtime): void {
  rt.timer?.cancel()
  rt.timer = $.clock.after(DEBOUNCE_MS, () => {
    rt.timer = undefined
    void check($, rt)
  })
}

/** Runs one check over the files edited since the last. Never throws. */
async function check($: $, rt: Runtime): Promise<void> {
  // One at a time: edits made meanwhile start the next once this one ends.
  if (rt.running !== undefined || rt.pending.size === 0) return
  const touched = [...rt.pending]
  rt.pending.clear()
  const running = { isStale: false }
  rt.running = running
  const { command, timeoutSeconds, maxChars } = rt.config
  try {
    const ran = await runCommand($, rt)
    if (running.isStale) {
      // A file changed under the check: its result may be out of date, so the next check covers these files too.
      debug($, `result dropped: files were edited while ${command} ran`)
      for (const file of touched) rt.pending.add(file)
      return
    }
    if (ran === 'timeout') {
      debug($, `${command} did not finish in ${timeoutSeconds}s; stopped`)
      warnOnce($, rt, 'timeout', `${$name}: the check did not finish in ${timeoutSeconds}s and was stopped. Raise the timeout in /config, or use a faster command.`)
      return
    }
    const { outcome, blocks } = judge({
      command,
      exitCode: ran.exitCode,
      output: [ran.stdout, ran.stderr].filter(s => s.trim() !== '').join('\n'),
      cwd: rt.cwd ?? '',
      touched,
      previous: rt.previous,
      wasReported: rt.failureDelivered,
      maxChars,
    })
    rt.previous = blocks
    debug($, `${command}: exit code ${ran.exitCode} over ${touched.length} edited file(s); ${outcome.kind}`)
    // A newer result replaces one not yet handed over: a failure since fixed is never told.
    rt.report = outcome.kind === 'silent' ? undefined : outcome
  } catch (err) {
    debug($, `${command} could not run: ${messageOf(err)}`)
    warnOnce($, rt, 'start', `${$name}: the check command could not run (${messageOf(err)}). Fix it in /config.`)
  } finally {
    rt.running = undefined
    if (rt.pending.size > 0 && rt.timer === undefined) schedule($, rt)
  }
}

type Ran = { exitCode: number; stdout: string; stderr: string }

/** Runs the command through the shell in the session's folder, racing the timeout on `$.clock`. */
async function runCommand($: $, rt: Runtime): Promise<Ran | 'timeout'> {
  const timeoutMs = rt.config.timeoutSeconds * 1000
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  const started = await $.clock.now()
  let timer: { cancel: () => void } | undefined
  const timedOut = new Promise<'timeout'>(resolve => {
    timer = $.clock.after(timeoutMs, () => resolve('timeout'))
  })
  // The engine kills the child at the same timeout, and then rejects.
  const run = $.process.run(shellArgv(rt.config.command, isWindows), { cwd: rt.cwd, timeoutMs })
  run.catch(() => undefined)
  try {
    return await Promise.race([run, timedOut])
  } catch (err) {
    if ((await $.clock.now()) - started >= timeoutMs - 100) return 'timeout'
    throw err
  } finally {
    timer?.cancel()
  }
}

/** The report for Claude, handed over once. */
function take(rt: Runtime): string {
  const report = rt.report!
  rt.report = undefined
  rt.failureDelivered = report.kind === 'errors'
  return report.text
}

function warnOnce($: $, rt: Runtime, key: string, text: string): void {
  if (rt.warned.has(key)) return
  rt.warned.add(key)
  $.ui.toast(text)
}

function debug($: $, text: string): void {
  $.ui.log(`${$name}: ${text}`, { to: 'debug' })
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
