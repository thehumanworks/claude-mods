// Loop breaker: when the same tool call fails several times in a row, Claude
// is told, after that failing result, to stop retrying and change approach.

import type { Register, ToolCallResult } from 'claude-code'
import { noteFor, resolveThreshold, toastFor, Tracker } from './loops.js'

const $name = 'loop-breaker'

export const register: Register = (on, options) => {
  const { threshold, problem } = resolveThreshold(options)
  const tracker = new Tracker(threshold)

  if (problem !== undefined) {
    on('session.start', async ($, e, next) => {
      const started = await next(e)
      $.ui.log(`${$name}: ${problem}`)
      return started
    })
  }

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    // A refused call never ran: not a failure of the call itself.
    if (ran.deny !== undefined) return ran
    try {
      const loop = tracker.record(
        { tool: e.tool, input: e as unknown as Record<string, unknown>, agentId: e.agentId },
        { isError: ran.isError === true, text: ran.text ?? (typeof ran.result === 'string' ? ran.result : undefined) },
      )
      if (loop === undefined) return ran
      $.ui.toast(toastFor(loop), { timeoutMs: 8000 })
      // `context` is what the model reads right after this result: the next request carries it.
      return { ...ran, context: [...(ran.context ?? []), noteFor(loop, e.tool)] } as ToolCallResult
    } catch (err) {
      $.ui.log(`${$name}: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
      return ran
    }
    // A failure of this hook leaves the call as Claude Code answers it.
  }).catch(($, e, next) => next(e))
}
