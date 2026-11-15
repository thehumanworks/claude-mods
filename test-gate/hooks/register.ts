// The test gate: when Claude ends a turn after editing files without running a
// test or check, a small model is asked whether the edits need one. If they do,
// the turn is kept going once (a Stop hook that blocks), with a short note
// asking Claude to run the relevant tests or say why not.

import type { EngineInterface, Register } from 'claude-code'
import { $name, describeEdit, fallback, isTestCommand, noteFor, parseVerdict, questionText, resolveConfig, saysNoTests, SYSTEM, type Config, type Decision, type Edit } from './gate.js'

type $ = EngineInterface

const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])
/** Enough for the three lines asked for. */
const MAX_TOKENS = 200

/** What one main-loop turn did, from its prompt to its end. */
type Turn = {
  prompt: string
  /** Edited files, by path, with the last edit of each. */
  edits: Map<string, Edit>
  testRan: boolean
  /** The turn was kept going once already: never again. */
  nudged: boolean
  /** How many files were edited when the model last said no: asked again only after more edits. */
  clearedAt?: number
}

const fresh = (prompt = ''): Turn => ({ prompt, edits: new Map(), testRan: false, nudged: false })

export const register: Register = (on, options) => {
  const { config, problems } = resolveConfig(options)
  if (!config.enabled) return
  let turn = fresh()

  if (problems.length > 0) {
    on('session.start', async ($, e, next) => {
      const started = await next(e)
      for (const problem of problems) $.ui.log(`${$name}: ${problem}`)
      return started
    })
  }

  // A typed prompt starts a new turn. A turn started with no text (a continuation) keeps what the turn did.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined && e.text !== '') turn = fresh(e.text)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    try {
      // The model's own calls in the main loop only: a plugin's `$.tool.call` and a subagent's work do not count.
      const isModelCall = next.origin.plugin === 'engine' && typeof e.tool_use_id === 'string' && e.tool_use_id !== ''
      if (!isModelCall || e.agentId !== undefined || result.deny !== undefined) return result
      const input = e as unknown as Record<string, unknown>
      if (EDIT_TOOLS.has(e.tool) && result.isError !== true) {
        const edit = describeEdit(e.tool, input)
        if (edit !== undefined) turn.edits.set(edit.path, edit)
      } else if (e.tool === 'Bash' && typeof input.command === 'string' && isTestCommand(input.command, config.patterns)) {
        // A failing test run is still a test run.
        turn.testRan = true
      }
    } catch (err) {
      debug($, `tool.call: ${messageOf(err)}`)
    }
    return result
  }).catch(($, e, next) => next(e))

  on('classic.Stop', async ($, e, next) => {
    const result = await next(e)
    // Another hook already keeps the turn going or stops the session; a Stop that follows a block is let through.
    if (e.agent_id !== undefined || e.stop_hook_active || result.block !== undefined || result.preventContinuation) return result
    const t = turn
    if (t.nudged || t.testRan || t.edits.size === 0 || t.edits.size === t.clearedAt) return result
    if (saysNoTests(t.prompt)) {
      debug($, 'the user said not to run tests')
      t.clearedAt = t.edits.size
      return result
    }
    const decision = await decide($, config, t, e.last_assistant_message ?? '')
    debug($, `${decision.nudge ? 'nudge' : 'no nudge'}: ${decision.why}`)
    if (!decision.nudge) {
      t.clearedAt = t.edits.size
      return result
    }
    t.nudged = true
    return { ...result, block: noteFor([...t.edits.keys()], decision) }
  }).catch(($, e, next) => next(e))
}

/** Asks the model; any failure, timeout or answer that is not yes or no falls back to the code-only rule. Never throws. */
async function decide($: $, config: Config, t: Turn, answer: string): Promise<Decision> {
  const paths = [...t.edits.keys()]
  const prompt = questionText({ paths, edits: [...t.edits.values()], prompt: t.prompt, answer })
  try {
    const reply = await $.model.complete({ model: config.model, system: SYSTEM, prompt, maxTokens: MAX_TOKENS, effort: 'low', timeoutMs: config.timeoutSeconds * 1000 })
    if (!reply.isAnswered) {
      const why = reply.reason === 'aborted' ? `no answer from ${config.model} in ${config.timeoutSeconds}s` : `${config.model} failed (${reply.reason}${reply.reason === 'api-error' ? ` ${reply.status ?? ''} ${reply.error}` : ''})`
      return fallback(paths, why)
    }
    const verdict = parseVerdict(reply.text)
    if (verdict === undefined) return fallback(paths, `${config.model} answered neither yes nor no`)
    return verdict.needsTests
      ? { nudge: true, why: `${config.model}: yes, ${verdict.reason}`, reason: verdict.reason, command: verdict.command, byModel: true }
      : { nudge: false, why: `${config.model}: no, ${verdict.reason}` }
  } catch (err) {
    return fallback(paths, `${config.model} could not be called (${messageOf(err)})`)
  }
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
