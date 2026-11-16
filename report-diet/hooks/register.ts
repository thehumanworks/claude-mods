// The report diet: when a subagent is about to hand back a final answer longer
// than maxChars, its stop is held once (a SubagentStop hook that blocks), with
// a note asking it to write the full report to a file and answer with a short
// summary that ends with the file's path. The main loop is never touched.

import type { Register } from 'claude-code'
import { $name, isErrorAnswer, isExcluded, noteFor, resolveConfig } from './diet.js'

/** Ids remembered at most: enough for any session, and bounded. */
const MAX_REMEMBERED = 1000

export const register: Register = (on, options) => {
  const { config, problems } = resolveConfig(options)
  if (!config.enabled) return
  /** Subagents held once already: never again. */
  const held = new Set<string>()

  if (problems.length > 0) {
    on('session.start', async ($, e, next) => {
      const started = await next(e)
      for (const problem of problems) $.ui.log(`${$name}: ${problem}`)
      return started
    }).catch(($, e, next) => next(e))
  }

  // SubagentStop fires for subagents only; the main loop's Stop is not hooked at all.
  on('classic.SubagentStop', async ($, e, next) => {
    const result = await next(e)
    const agentId = typeof e.agent_id === 'string' ? e.agent_id : ''
    // Another hook already holds the stop or ends the session; a stop that follows a block is let through.
    if (agentId === '' || e.stop_hook_active || result.block !== undefined || result.preventContinuation) return result
    if (next.signal.aborted || held.has(agentId) || isExcluded(e.agent_type, config.exclude)) return result
    const answer = e.last_assistant_message ?? ''
    if (answer.length <= config.maxChars || isErrorAnswer(answer)) return result
    if (held.size >= MAX_REMEMBERED) held.clear()
    held.add(agentId)
    try {
      $.ui.log(`${$name}: held ${e.agent_type || 'subagent'} ${agentId} once (${answer.length} chars)`, { to: 'debug' })
    } catch {
      // Logging never stands in the way.
    }
    return { ...result, block: noteFor(agentId, answer.length, config) }
  }).catch(($, e, next) => next(e))
}
