// Handoff: a short note per repository of what the work is, what was done,
// what is next and what is still open. A small model rewrites it after a turn
// that did real work (files edited, or enough tool calls), at most once in a
// while, off the turn's path; and once more when the session ends. Claude reads
// it beside the first prompt of a session and the first prompt after each
// compaction, as context of its own next to whatever summary the compaction left.

import type { EngineInterface, Register, Timer } from 'claude-code'
import {
  $name, addCommand, addEdit, addPrompt, commandText, contextFor, emptyWork, isWorthNote, MAX_TOKENS, mergeWork, NOTES_KEY,
  parseNote, questionText, readNotes, resolveConfig, SYSTEM, withNote, type Config, type Entry, type When, type Work,
} from './note.js'

type $ = EngineInterface

const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])
const COMMAND = 'handoff'
/** What a session-end call leaves Claude Code of its exit bound. */
const END_MARGIN_MS = 250
/** A session-end call with less time than this is not made. */
const END_MIN_MS = 500

type Runtime = {
  config: Config
  /** The work since the last note, waiting to go into the next. */
  work: Work
  /** Whether the work holds a turn that counted: what makes a note due. */
  isDue: boolean
  /** The current main-loop turn: its tool calls and edits. */
  turn: { tools: number; edits: number }
  /** When the last call to the model started. */
  calledAt?: number
  /** A call in flight. */
  running?: Promise<void>
  /** The call that waits for the debounce to pass. */
  timer?: Timer
  /** Why the last call failed, until one succeeds. */
  lastError?: string
  /** Repository roots by working directory. */
  roots: Map<string, string>
  /** The session whose first prompt has had (or had no) note. */
  startedSession?: string
  /** A compaction of the main conversation happened: the next prompt carries the note. */
  isCompacted: boolean
}

export const register: Register = (on, options) => {
  const { config, problems } = resolveConfig(options)
  // Off: no hook at all.
  if (!config.enabled) return
  const rt: Runtime = { config, work: emptyWork(), isDue: false, turn: { tools: 0, edits: 0 }, roots: new Map(), isCompacted: false }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    for (const problem of problems) $.ui.log(`${$name}: ${problem}`)
    try {
      await $.command.register({ name: COMMAND, description: 'Shows the handoff note for this repository, and when it was written', immediate: true })
    } catch (err) {
      debug($, `/${COMMAND} not registered: ${messageOf(err)}`)
    }
    return started
  })

  on('command.run', { command: COMMAND }, async $ => {
    const root = await rootOf($, rt)
    const notes = readNotes(await $.store.get(NOTES_KEY))
    return { text: commandText(root, notes[root], await $.clock.now(), rt.config, rt.lastError) }
  }).catch(($, e, next) => ({ text: `The handoff note could not be read: ${messageOf(next.error)}` }))

  // A typed prompt of the main loop: what the work was for.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      rt.turn = { tools: 0, edits: 0 }
      addPrompt(rt.work, e.text)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    try {
      // The model's own calls in the main loop only: a plugin's `$.tool.call` and a subagent's work do not count.
      const isModelCall = next.origin.plugin === 'engine' && typeof e.tool_use_id === 'string' && e.tool_use_id !== ''
      if (!isModelCall || e.agentId !== undefined || result.deny !== undefined) return result
      const input = e as unknown as Record<string, unknown>
      rt.turn.tools++
      rt.work.tools++
      if (EDIT_TOOLS.has(e.tool) && result.isError !== true) {
        const path = typeof input.file_path === 'string' ? input.file_path : input.notebook_path
        if (typeof path === 'string' && path !== '') {
          addEdit(rt.work, path)
          rt.turn.edits++
        }
      } else if (e.tool === 'Bash' && typeof input.command === 'string') {
        addCommand(rt.work, input.command)
      }
    } catch (err) {
      debug($, `tool.call: ${messageOf(err)}`)
    }
    return result
  }).catch(($, e, next) => next(e))

  // The end of a main-loop turn: a note is due when it edited a file or made enough tool calls.
  on('turn.complete', async ($, e, next) => {
    const completed = await next(e)
    try {
      if (e.agentId !== undefined) return completed
      if (e.answer.trim() !== '') rt.work.answer = e.answer
      const { tools, edits } = rt.turn
      rt.turn = { tools: 0, edits: 0 }
      if (edits === 0 && tools < rt.config.minTools) return completed
      rt.work.turns++
      rt.isDue = true
      await schedule($, rt)
    } catch (err) {
      debug($, `turn.complete: ${messageOf(err)}`)
    }
    return completed
  }).catch(($, e, next) => next(e))

  // The session's end: what is left goes into one more note, within Claude Code's short exit bound.
  on('session.end', async ($, e, next) => {
    rt.timer?.cancel()
    rt.timer = undefined
    const ended = await next(e)
    try {
      if (rt.running !== undefined || !isWorthNote(rt.work, rt.config.minTools)) return ended
      if (e.reason === 'clear') {
        // The process goes on under a new session: the note is written off the exit's clock.
        $.clock.after(0, () => void write($, rt, 'session end (/clear)'))
        return ended
      }
      const left = next.budget.remainingMs - END_MARGIN_MS
      const timeoutMs = Math.min(rt.config.timeoutSeconds * 1000, left)
      if (timeoutMs < END_MIN_MS) {
        debug($, `session end: ${Math.max(0, Math.round(left))}ms left of the exit bound; no note written`)
        return ended
      }
      await write($, rt, 'session end', timeoutMs)
    } catch (err) {
      debug($, `session.end: ${messageOf(err)}`)
    }
    return ended
  }).catch(($, e, next) => next(e))

  // The note rides beside the first prompt of a session, and beside the first prompt after a compaction.
  on('prompt.submit', async ($, e, next) => {
    // A slash command may never reach the model: the note waits for a real prompt.
    if (e.command !== undefined) return next(e)
    const sessionId = await $.session.id()
    const when: When | undefined = rt.startedSession !== sessionId ? 'start' : rt.isCompacted ? 'compaction' : undefined
    if (when === undefined) return next(e)
    const before = { startedSession: rt.startedSession, isCompacted: rt.isCompacted }
    // Claimed before any await, so two prompts at once carry one note.
    rt.startedSession = sessionId
    rt.isCompacted = false
    const root = await rootOf($, rt)
    const entry = readNotes(await $.store.get(NOTES_KEY))[root]
    if (entry === undefined) return next(e)
    const text = contextFor(root, entry, await $.clock.now(), when)
    debug($, `note for ${root} added to the prompt (${when})`)
    const submitted = await next({ ...e, context: [...(e.context ?? []), text] })
    // A prompt that did not enter carried no note: the next one does.
    if (submitted.drop !== undefined) Object.assign(rt, before)
    return submitted
  }).catch(($, e, next) => next(e))

  // A compaction of the main conversation, whoever wrote its summary: the note is read again after it.
  // Each of these only watches: the compaction and its summary pass through untouched.
  on('session.compact', async ($, e, next) => {
    const compacted = await next(e)
    if (e.agentId === undefined && e.trigger !== 'precompute' && compacted.skip === undefined) compactedNow($, rt, `session.compact (${e.trigger})`)
    return compacted
  }).catch(($, e, next) => next(e))

  on('session.append', { door: 'compaction' }, async ($, e, next) => {
    const appended = await next(e)
    if (e.agentId === undefined) compactedNow($, rt, 'compaction row')
    return appended
  }).catch(($, e, next) => next(e))

  on('classic.SessionStart', async ($, e, next) => {
    if (e.source === 'compact') compactedNow($, rt, 'SessionStart (compact)')
    return next(e)
  }).catch(($, e, next) => next(e))
}

function compactedNow($: $, rt: Runtime, why: string): void {
  if (!rt.isCompacted) debug($, `compaction seen (${why}): the next prompt carries the note`)
  rt.isCompacted = true
}

/**
 * Starts a note now, or once the debounce has passed, off the hook's path:
 * the turn never waits for the model. One call at a time; work done while a
 * call runs, or while the debounce holds, goes into the next.
 */
async function schedule($: $, rt: Runtime): Promise<void> {
  if (!rt.isDue || rt.running !== undefined || rt.timer !== undefined) return
  const now = await $.clock.now()
  const wait = rt.calledAt === undefined ? 0 : rt.calledAt + rt.config.minSecondsBetween * 1000 - now
  if (wait > 0) debug($, `note due; written in ${Math.ceil(wait / 1000)}s (at most one every ${rt.config.minSecondsBetween}s)`)
  rt.timer = $.clock.after(Math.max(0, wait), () => {
    rt.timer = undefined
    void write($, rt, 'turn end')
  })
}

/** Asks the model for the new note and stores it; any failure keeps the old note and the work for the next try. Never throws. */
function write($: $, rt: Runtime, why: string, timeoutMs = rt.config.timeoutSeconds * 1000): Promise<void> {
  if (rt.running !== undefined) return rt.running
  const work = rt.work
  rt.work = emptyWork()
  rt.isDue = false
  const running = (async () => {
    const { model } = rt.config
    try {
      rt.calledAt = await $.clock.now()
      const root = await rootOf($, rt)
      const previous = readNotes(await $.store.get(NOTES_KEY))[root]
      const reply = await $.model.complete({ model, system: SYSTEM, prompt: questionText(root, previous?.note, work), maxTokens: MAX_TOKENS, effort: 'low', timeoutMs })
      if (!reply.isAnswered) {
        const reason = reply.reason === 'aborted' ? `no answer from ${model} in ${Math.round(timeoutMs / 1000)}s` : `${model} failed (${reply.reason}${reply.reason === 'api-error' ? ` ${reply.status ?? ''} ${reply.error}` : ''})`
        return failed($, rt, work, why, reason)
      }
      const note = parseNote(reply.text)
      if (note === undefined) return failed($, rt, work, why, `${model} answered nothing`)
      const entry: Entry = { note, writtenAt: await $.clock.now(), model, sessionId: await $.session.id() }
      // Read again: another session may have written meanwhile.
      await $.store.set(NOTES_KEY, withNote(readNotes(await $.store.get(NOTES_KEY)), root, entry))
      rt.lastError = undefined
      debug($, `note for ${root} written (${why}): ${note.length} characters, ${reply.usage.input_tokens} tokens in, ${reply.usage.output_tokens} out`)
    } catch (err) {
      failed($, rt, work, why, `${model} could not be called (${messageOf(err)})`)
    }
  })()
  rt.running = running.finally(() => {
    rt.running = undefined
    // Work that counted while the call ran waits for the debounce, then goes in.
    if (rt.isDue) void schedule($, rt).catch(() => undefined)
  })
  return rt.running
}

/** The old note stays; the work goes back in front of what came since, for the next note. */
function failed($: $, rt: Runtime, work: Work, why: string, reason: string): void {
  rt.work = mergeWork(work, rt.work)
  // Due again at the next turn that counts, or at the session's end: never retried on its own.
  rt.lastError = reason
  debug($, `note not written (${why}): ${reason}; the old note stays`)
}

/** The repository the session works in: git's top level for the working directory, else the directory itself. */
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
