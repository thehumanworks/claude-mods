// Worktree coach: when Claude Code refuses a worktree-isolated agent's Bash
// command because it cannot verify that the command stays in the worktree,
// Claude reads, right after the refusal, which part of the command tripped the
// check and the command rewritten as plain, separate calls.

import type { Register, ToolCallResult } from 'claude-code'
import { Coach, isEnabled, isModelCall, parseRefusal, textOf } from './coach.js'

const $name = 'worktree-coach'

export const register: Register = (on, options) => {
  if (!isEnabled(options)) return
  const coach = new Coach()

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    // Only the model's own calls (the main loop's and every subagent's): a plugin's own `$.tool.call` result never reaches Claude.
    if (!isModelCall(next.origin, e.tool_use_id)) return next(e)
    const ran = await next(e)
    if (ran.deny !== undefined) return ran
    const refusal = parseRefusal(textOf(ran))
    if (refusal === undefined) return ran
    const note = coach.record(refusal, e.command, e.agentId)
    $.ui.log(`${$name}: ${refusal.pattern} refusal${e.agentId === undefined ? '' : ` in agent ${e.agentId}`}${note === undefined ? ', no note (already given)' : ', note added'}`, { to: 'debug' })
    if (note === undefined) return ran
    // `context` is what the model reads right after this result. The command and the permissions are left as they are.
    return { ...ran, context: [...(ran.context ?? []), note] } as ToolCallResult
  })
    // A failure of this hook leaves the call as Claude Code answers it.
    .catch(($, e, next) => next(e))
}
