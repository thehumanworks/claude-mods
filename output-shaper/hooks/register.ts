// When a Bash command of Claude's prints a lot, Claude reads its first and
// last lines, the counts, and the path of the whole output, in place of the
// whole dump or Claude Code's own preview of its start.

import type { EngineInterface, Register, ToolCallResult } from 'claude-code'
import {
  DEFAULT_SAVE_DIR,
  errorNote,
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

type $ = EngineInterface
type BashRecord = Record<string, unknown> & { stdout?: unknown; stderr?: unknown }

const $name = 'output-shaper'
/** What one `$.fs.read` takes. */
export const FS_READ_MAX_BYTES = 4 * 1024 * 1024
/** Fields of Bash's record that make Claude Code show its own preview in place of stdout. */
const PREVIEW_FIELDS = ['persistedOutputPath', 'persistedOutputSize', 'stdoutHoldsOutputEnd'] as const

type Runtime = { config: Config; dir?: string }

export const register: Register = (on, options) => {
  const { config, problems } = resolveConfig(options)
  const rt: Runtime = { config }

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
    const ran = await next(e)
    try {
      if (ran.deny !== undefined) return ran
      if (ran.isError === true) return await noteOnError($, rt, ran)
      return (await shapeAnswer($, rt, e.tool_use_id!, ran)) ?? ran
    } catch (err) {
      debug($, `left as it was: ${messageOf(err)}`)
      return ran
    }
  })
    // A failure of this hook leaves the call as Claude Code answers it.
    .catch(($, e, next) => next(e))
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
    const toAbs = (dir: string) => (isAbsolute(dir) ? dir : dir === '.' ? root : joinPath(root, dir.replace(/^\.[\\/]/, '')))
    if (rt.config.saveDir === '') {
      const base = toAbs(DEFAULT_SAVE_DIR)
      const ignore = joinPath(base, '.gitignore')
      if (!(await $.fs.exists(ignore))) await $.fs.write(ignore, '*\n')
      const session = (await $.session.id()).replace(/[^A-Za-z0-9_-]/g, '_') || 'session'
      rt.dir = joinPath(base, session)
    } else rt.dir = toAbs(rt.config.saveDir)
  }
  return joinPath(rt.dir, fileNameFor(toolUseId))
}

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
