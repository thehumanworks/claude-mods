// When a Bash command of Claude's prints a lot, Claude reads its first and
// last lines, the counts, and the path of the whole output, in place of the
// whole dump or Claude Code's own preview of its start.

import type { EngineInterface, Register, ToolCallResult } from 'claude-code'
import {
  DEFAULT_SAVE_DIR,
  errorNote,
  hasBashPreToolUse,
  keptNote,
  lostTheEnd,
  TAIL_FILE_MAX_AGE_MS,
  TAIL_FILE_RE,
  TAIL_FILES_MAX,
  TAIL_NOTE_MAX_CHARS,
  TAIL_SUBDIR,
  tailFileNameFor,
  tailNote,
  EXCERPT_BUDGET_MAX,
  excerpt,
  fileNameFor,
  isAbsolute,
  isSessionToolResult,
  joinPath,
  keepStderr,
  linesOf,
  render,
  resolveConfig,
  savedPathInError,
  type Config,
  type Whole,
} from './shape.js'
import { skipReason, wrapCommand } from './wrap.js'

type $ = EngineInterface
type BashRecord = Record<string, unknown> & { stdout?: unknown; stderr?: unknown }

const $name = 'output-shaper'
/** What one `$.fs.read` takes. */
export const FS_READ_MAX_BYTES = 4 * 1024 * 1024
/** Fields of Bash's record that make Claude Code show its own preview in place of stdout. */
const PREVIEW_FIELDS = ['persistedOutputPath', 'persistedOutputSize', 'stdoutHoldsOutputEnd'] as const

/** A model's Bash call whose command line was wrapped to copy its whole output to `file`. */
type Tail = {
  original: string
  wrapped: string
  file: string
  /** Set by the tool.check hook when the wrapped line was not allowed: the call runs again as written. */
  runAsWritten?: boolean
}

type Runtime = {
  config: Config
  dir?: string
  /** Where the wrap's files go. */
  tailDir?: string
  /** Wrapped calls in flight, by tool_use_id. */
  tails: Map<string, Tail>
  /** When the wrap's folder was last cleaned, ms since the epoch. */
  cleanedAt?: number
}
/** The folder is cleaned at most this often. */
const CLEAN_EVERY_MS = 10 * 60 * 1000

export const register: Register = (on, options) => {
  const { config, problems } = resolveConfig(options)
  const rt: Runtime = { config, tails: new Map() }

  if (problems.length > 0) {
    on('session.start', async ($, e, next) => {
      const started = await next(e)
      for (const problem of problems) $.ui.log(`${$name}: ${problem}`)
      return started
    })
  }

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    // Only the model's own calls in the main loop: a plugin's `$.tool.call` carries a tool_use_id too, so the
    // origin decides; a subagent's output goes to the subagent, whose own budget is its business.
    const isModelCall = next.origin.plugin === 'engine' && typeof e.tool_use_id === 'string' && e.tool_use_id !== ''
    if (!isModelCall || e.agentId !== undefined) return next(e)
    const toolUseId = e.tool_use_id!
    const tail = config.keepFailingTail ? await planTail($, rt, toolUseId, e).catch(err => void debug($, `not wrapped: ${messageOf(err)}`)) : undefined
    let ran = await next(tail === undefined ? e : { ...e, command: tail.wrapped })
    if (tail?.runAsWritten === true && !wasRefused(ran, rerunReason(toolUseId))) {
      // A hook above this one answered over the refusal and the wrapped line ran: never run it twice.
      tail.runAsWritten = false
    }
    if (tail?.runAsWritten === true) {
      // The wrapped line was refused where the command itself is allowed: run it as the model wrote it.
      rt.tails.delete(toolUseId)
      await removeFiles($, [tail.file])
      ran = await next(e)
    }
    try {
      if (ran.deny !== undefined) return ran
      if (ran.isError === true) {
        const noted = await noteOnError($, rt, ran)
        return tail === undefined || tail.runAsWritten === true ? noted : await tailOnError($, rt, tail, noted, noted !== ran)
      }
      const shaped = await shapeAnswer($, rt, toolUseId, ran)
      if (tail === undefined || tail.runAsWritten === true) return shaped ?? ran
      return await tailOnSuccess($, rt, tail, ran, shaped)
    } catch (err) {
      debug($, `left as it was: ${messageOf(err)}`)
      return ran
    } finally {
      if (tail !== undefined) {
        rt.tails.delete(toolUseId)
        await cleanTails($, rt).catch(err => debug($, `cleaning ${rt.tailDir ?? 'the tail folder'}: ${messageOf(err)}`))
      }
    }
  })
    // A failure of this hook leaves the call as Claude Code answers it: unwrapped when it had not run yet.
    .catch(($, e, next) => next(e))

  if (config.keepFailingTail) {
    // The wrapped line is a different command line to the permission check. A call is only wrapped when the
    // command as written is allowed with nobody asked; here the wrapped line gets the same answer, or, when
    // anything stronger than a rule (a deny, a hook's ask) holds it, the call runs again as written.
    on('tool.check', { tool: 'Bash' }, async ($, e, next) => {
      const tail = e.tool_use_id === undefined ? undefined : rt.tails.get(e.tool_use_id)
      const input = e.input as { command?: unknown } | undefined
      if (tail === undefined || next.origin.plugin !== 'engine' || e.agentId !== undefined || input?.command !== tail.wrapped) return next(e)
      const verdict = await next(e)
      if (verdict.decision === 'allow') return verdict
      if (verdict.decision === 'ask' && verdict.hook === undefined && verdict.plugin === undefined && verdict.setting === undefined) {
        return { decision: 'allow' as const, reason: `${$name}: the command it wraps is allowed as written` }
      }
      tail.runAsWritten = true
      return { decision: 'deny' as const, reason: rerunReason(e.tool_use_id!) }
    })
      .catch(($, e, next) => next(e))
  }
}

/** The refusal this mod gives a wrapped line it will run again as written; the call's id makes it its own. */
const rerunReason = (toolUseId: string): string => `${$name}: the wrapped command was not allowed; it runs again as written (${toolUseId})`

/** Whether the call was refused with `reason`, so nothing ran; a result the tool produced is never taken for one. */
function wasRefused(ran: ToolCallResult<'Bash'>, reason: string): boolean {
  if (ran.deny !== undefined) return ran.deny.includes(reason)
  return ran.isError === true && typeof ran.text === 'string' && ran.text.includes(reason)
}

/**
 * Wraps the command line when it is safe to, so its whole output is also
 * written to a file of its own. Undefined leaves the call as it is.
 */
async function planTail($: $, rt: Runtime, toolUseId: string, e: { command: string; run_in_background?: boolean }): Promise<Tail | undefined> {
  if (e.run_in_background === true) return undefined
  const reason = skipReason(e.command)
  if (reason !== undefined) {
    debug($, `not wrapped: ${reason}`)
    return undefined
  }
  // The sandbox decides by the command line too (its excluded commands), and may not let the shell write the file.
  const sandbox = (await $.settings.read({ key: 'sandbox' }).catch(() => undefined)) as { enabled?: unknown } | undefined
  if (sandbox?.enabled === true) return undefined
  // A PreToolUse hook of the person's that fires for Bash may guard by the command line (`^git push`), and would
  // read the wrap instead: never weaken it. Settings files only (user, project, local, flag, policy, merged); other
  // plugins' hooks cannot be seen through the API.
  const hooks = await $.settings.read({ key: 'hooks' }).catch(() => ({ PreToolUse: [{}] }))
  if (hasBashPreToolUse(hooks)) {
    debug($, 'not wrapped: a PreToolUse hook in the settings fires for Bash and may read the command line')
    return undefined
  }
  // Only a command the session would run with nobody asked: a person is never shown the wrapped line.
  const { decision } = await $.tool.check({ tool: 'Bash', input: { command: e.command } })
  if (decision !== 'allow') {
    debug($, `not wrapped: the command as written is not allowed outright (${decision})`)
    return undefined
  }
  const dir = await tailDir($, rt)
  if (!isAbsolute(dir) || !dir.startsWith('/')) return undefined
  const file = joinPath(dir, tailFileNameFor(toolUseId))
  const wrapped = wrapCommand(e.command, file)
  // The shell must read both as it reads the command, or the command runs as written.
  const [asWritten, asWrapped] = await Promise.all([e.command, wrapped].map(script => $.process.run(['bash', '-n', '-c', script], { timeoutMs: 5_000 })))
  if (asWritten?.exitCode !== 0 || asWrapped?.exitCode !== 0) {
    debug($, `not wrapped: bash -n ${asWritten?.exitCode !== 0 ? 'refuses the command' : 'refuses the wrap'}`)
    return undefined
  }
  await $.fs.write(file, '')
  const tail: Tail = { original: e.command, wrapped, file }
  rt.tails.set(toolUseId, tail)
  return tail
}

/**
 * A failing wrapped call: when Claude Code cut its output and the real end was
 * lost, the end and the path are added as context. Otherwise the file goes.
 */
async function tailOnError($: $, rt: Runtime, tail: Tail, ran: ToolCallResult<'Bash'>, isNoted: boolean): Promise<ToolCallResult<'Bash'>> {
  const text = typeof ran.text === 'string' ? ran.text : typeof ran.result === 'string' ? ran.result : ''
  const read = isNoted ? undefined : await readTail($, tail, rt.config)
  if (read === undefined || !lostTheEnd(text, read.whole.size, read.lines)) {
    await removeFiles($, [tail.file])
    return ran
  }
  const ex = excerpt(read.lines, 0, rt.config.tailLines, Math.min(budgetOf(rt.config), TAIL_NOTE_MAX_CHARS))
  return { ...ran, context: [...(ran.context ?? []), tailNote(ex, read.whole)] } as ToolCallResult<'Bash'>
}

/**
 * A wrapped call that did not fail: its file goes, unless the output was cut
 * and no other copy is kept, when its path is added as context.
 */
async function tailOnSuccess($: $, rt: Runtime, tail: Tail, ran: ToolCallResult<'Bash'>, shaped: ToolCallResult<'Bash'> | undefined): Promise<ToolCallResult<'Bash'>> {
  const answer = shaped ?? ran
  const record = ran.result as unknown as BashRecord | undefined
  // A command moved to the background is still writing its file; the cleanup takes it later.
  if (record !== null && typeof record === 'object' && record.backgroundTaskId !== undefined) return answer
  const hasCopy = shaped !== undefined || (typeof record?.persistedOutputPath === 'string' && record.persistedOutputPath !== '')
  const read = hasCopy ? undefined : await readTail($, tail, rt.config)
  const shown = typeof record?.stdout === 'string' ? `${record.stdout}${typeof record.stderr === 'string' ? record.stderr : ''}` : (ran.text ?? '')
  if (read === undefined || !lostTheEnd(shown, read.whole.size, read.lines)) {
    await removeFiles($, [tail.file])
    return answer
  }
  return { ...answer, context: [...(answer.context ?? []), keptNote(read.whole)] } as ToolCallResult<'Bash'>
}

/** The wrap's file, read like a saved one; only a plain file, never a link put in its place. */
async function readTail($: $, tail: Tail, config: Config): Promise<{ lines: string[]; whole: Whole } | undefined> {
  const stat = await $.fs.stat(tail.file).catch(() => undefined)
  if (stat === undefined || stat.kind !== 'file' || stat.isLink === true || stat.size === 0) return undefined
  return readSaved($, tail.file, config)
}

/** Where the wrap's files go: `tails` under the default folder, or the folder the person chose. */
async function tailDir($: $, rt: Runtime): Promise<string> {
  if (rt.tailDir === undefined) {
    const root = await $.session.root()
    if (rt.config.saveDir === '') {
      const base = await defaultBase($, root)
      rt.tailDir = joinPath(base, TAIL_SUBDIR)
    } else rt.tailDir = toAbs(root, rt.config.saveDir)
  }
  return rt.tailDir
}

/**
 * Removes the wrap's old files: past TAIL_FILE_MAX_AGE_MS, and past the newest
 * TAIL_FILES_MAX. Only `tail-<id>.txt` files, and never one a call in flight
 * writes. At most once every CLEAN_EVERY_MS.
 */
async function cleanTails($: $, rt: Runtime): Promise<void> {
  const now = Date.now()
  if (rt.tailDir === undefined || (rt.cleanedAt !== undefined && now - rt.cleanedAt < CLEAN_EVERY_MS)) return
  rt.cleanedAt = now
  const inFlight = new Set([...rt.tails.values()].map(t => t.file))
  const entries = (await $.fs.list(rt.tailDir).catch(() => []))
    .filter(f => f.kind === 'file' && !f.isLink && TAIL_FILE_RE.test(f.name))
    .map(f => ({ path: joinPath(rt.tailDir!, f.name), mtimeMs: f.mtimeMs }))
    .filter(f => !inFlight.has(f.path))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
  const old = entries.filter((f, i) => i >= TAIL_FILES_MAX || now - f.mtimeMs > TAIL_FILE_MAX_AGE_MS)
  await removeFiles($, old.map(f => f.path))
}

async function removeFiles($: $, paths: readonly string[]): Promise<void> {
  if (paths.length === 0) return
  const r = await $.process.run(['rm', '-f', '--', ...paths], { timeoutMs: 10_000 }).catch(() => undefined)
  if (r?.exitCode !== 0) debug($, `could not remove ${paths.join(', ')}`)
}

/**
 * A successful call: shaped when its output is over the threshold or Claude Code
 * saved it to a file. Undefined leaves the result as it is.
 */
async function shapeAnswer($: $, rt: Runtime, toolUseId: string, ran: ToolCallResult<'Bash'>): Promise<ToolCallResult<'Bash'> | undefined> {
  const record = ran.result as unknown as BashRecord | undefined
  if (record === undefined || record === null || typeof record !== 'object' || typeof record.stdout !== 'string') return undefined
  // A backgrounded command, an image, or structured content: Claude Code shows something else than stdout.
  if (record.backgroundTaskId !== undefined || record.isImage === true) return undefined
  if (Array.isArray(record.structuredContent) && record.structuredContent.length > 0) return undefined
  const stdout = record.stdout
  const stderr = typeof record.stderr === 'string' ? record.stderr : ''
  const { config } = rt

  let lines: string[]
  let whole: Whole
  const saved = typeof record.persistedOutputPath === 'string' && record.persistedOutputPath !== '' ? record.persistedOutputPath : undefined
  if (saved !== undefined) {
    // Claude Code saved the whole output already: reuse its file, and read it for the counts and the end.
    const read = await readSaved($, saved, config)
    if (read === undefined) return undefined
    ;({ lines, whole } = read)
  } else {
    if (stdout.length + stderr.length <= config.threshold) return undefined
    const path = await savePath($, rt, toolUseId)
    await $.fs.write(path, stderr === '' ? stdout : `${stdout}${stdout.endsWith('\n') ? '' : '\n'}--- stderr ---\n${stderr}`)
    lines = linesOf(stdout)
    whole = { path, lines: lines.length, size: stdout.length, unit: 'characters' }
  }

  const shaped = render(excerpt(lines, config.headLines, config.tailLines, budgetOf(config)), whole)
  const next: BashRecord = { ...record, stdout: shaped, stderr: keepStderr(stderr, config.tailLines) }
  for (const field of PREVIEW_FIELDS) delete next[field]
  // A hook's own `{ result }`: Claude Code maps it for the model with Bash's own mapper, notes included.
  return {
    result: next as unknown as ToolCallResult<'Bash'>['result'] & object,
    ...(ran.context !== undefined && { context: ran.context }),
  } as ToolCallResult<'Bash'>
}

/**
 * An error result stays whole (the exit code and the end of the output are in
 * it). When Claude Code saved the output and shows only its start, the last
 * lines are added as context.
 *
 * The path comes from the result's text, which holds the command's own output,
 * so it is trusted only in Claude Code's place and format, and only for a file
 * in this session's tool-results folder (where it lands too, links followed):
 * anything else would let a command's output have the mod read any file.
 */
async function noteOnError($: $, rt: Runtime, ran: ToolCallResult<'Bash'>): Promise<ToolCallResult<'Bash'>> {
  const text = typeof ran.text === 'string' ? ran.text : typeof ran.result === 'string' ? ran.result : ''
  const saved = savedPathInError(text)
  if (saved === undefined) return ran
  const sessionId = await $.session.id()
  if (!isSessionToolResult(saved, sessionId)) {
    debug($, `not read: ${saved} is not in this session's tool-results folder`)
    return ran
  }
  const stat = await $.fs.stat(saved, { resolve: true }).catch(() => undefined)
  if (stat === undefined || stat.kind !== 'file' || stat.isLink || stat.realPath === undefined || !isSessionToolResult(stat.realPath, sessionId)) {
    debug($, `not read: ${saved} is not a plain file in this session's tool-results folder`)
    return ran
  }
  const read = await readSaved($, stat.realPath, rt.config)
  if (read === undefined) return ran
  const ex = excerpt(read.lines, 0, rt.config.tailLines, budgetOf(rt.config))
  return { ...ran, context: [...(ran.context ?? []), errorNote(ex, read.whole)] } as ToolCallResult<'Bash'>
}

/**
 * The lines and counts of a file Claude Code saved. Within what one read takes,
 * the whole text; past it, `wc`, `head` and `tail` (the counts then in bytes).
 */
async function readSaved($: $, path: string, config: Config): Promise<{ lines: string[]; whole: Whole } | undefined> {
  const stat = await $.fs.stat(path).catch(() => undefined)
  if (stat === undefined || stat.kind !== 'file') return undefined
  if (stat.size <= FS_READ_MAX_BYTES) {
    const text = await $.fs.read(path)
    if (typeof text !== 'string') return undefined
    const lines = linesOf(text)
    return { lines, whole: { path, lines: lines.length, size: text.length, unit: 'characters' } }
  }
  try {
    const run = async (argv: string[]) => {
      const r = await $.process.run(argv, { timeoutMs: 10_000 })
      if (r.exitCode !== 0) throw new Error(`${argv[0]} exited ${r.exitCode}`)
      return r.stdout
    }
    const count = Number.parseInt((await run(['wc', '-l', '--', path])).trim(), 10)
    const head = linesOf(await run(['head', '-n', String(config.headLines), '--', path]))
    const tail = linesOf(await run(['tail', '-n', String(config.tailLines), '--', path]))
    if (!Number.isFinite(count)) return undefined
    // Lines the middle stands for, so the excerpt counts and numbers them right.
    const middle = Math.max(0, count - head.length - tail.length)
    const lines = [...head.slice(0, config.headLines), ...new Array<string>(middle).fill(''), ...tail]
    return { lines, whole: { path, lines: Math.max(count, lines.length), size: stat.size, unit: 'bytes' } }
  } catch (err) {
    debug($, `${path} is over ${FS_READ_MAX_BYTES} bytes and could not be read in parts: ${messageOf(err)}`)
    return undefined
  }
}

/**
 * Where this call's output is saved. The default folder holds one folder per
 * session and is kept out of git by a `.gitignore` of its own; a folder the
 * person chose is used as it is, and nothing else is written in it.
 */
async function savePath($: $, rt: Runtime, toolUseId: string): Promise<string> {
  if (rt.dir === undefined) {
    const root = await $.session.root()
    if (rt.config.saveDir === '') {
      const base = await defaultBase($, root)
      const session = (await $.session.id()).replace(/[^A-Za-z0-9_-]/g, '_') || 'session'
      rt.dir = joinPath(base, session)
    } else rt.dir = toAbs(root, rt.config.saveDir)
  }
  return joinPath(rt.dir, fileNameFor(toolUseId))
}

/** The default folder in the session's folder, kept out of git by a `.gitignore` of its own. */
async function defaultBase($: $, root: string): Promise<string> {
  const base = toAbs(root, DEFAULT_SAVE_DIR)
  const ignore = joinPath(base, '.gitignore')
  if (!(await $.fs.exists(ignore))) await $.fs.write(ignore, '*\n')
  return base
}

const toAbs = (root: string, dir: string): string => (isAbsolute(dir) ? dir : dir === '.' ? root : joinPath(root, dir.replace(/^\.[\\/]/, '')))

/** The most the kept lines may take: the threshold, held under Claude Code's own inline limit. */
const budgetOf = (config: Config): number => Math.min(config.threshold, EXCERPT_BUDGET_MAX)

function debug($: $, message: string): void {
  try {
    $.ui.log(`${$name}: ${message}`, { to: 'debug' })
  } catch {
    // nothing to do
  }
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))
