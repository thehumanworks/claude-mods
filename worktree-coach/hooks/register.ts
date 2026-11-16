// Worktree coach: when Claude Code refuses a worktree-isolated agent's Bash
// command because it cannot verify that the command stays in the worktree,
// Claude reads, right after the refusal, Claude Code's reason and remedy (its
// fixed sentences only), its worktree path (once checked against the agent's
// own directory) and fixed tips. The refused command is never echoed back.

import type { EngineInterface, Register, ToolCallResult } from 'claude-code'
import { Coach, isAgentWorktree, isEnabled, isModelCall, parseRefusal, textOf } from './coach.js'

const $name = 'worktree-coach'

/** The top folder of the git worktree `cwd` is in, or undefined when it cannot be read. */
async function worktreeRoot($: EngineInterface, cwd: string | undefined): Promise<string | undefined> {
  if (cwd === undefined) return undefined
  try {
    const { exitCode, stdout } = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd, timeoutMs: 5000 })
    const top = stdout.trim()
    return exitCode === 0 && top.startsWith('/') && !top.includes('\n') ? top : undefined
  } catch {
    return undefined
  }
}

export const register: Register = (on, options) => {
  if (!isEnabled(options)) return
  const coach = new Coach()

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    // Only the model's own calls (the main loop's and every subagent's): a plugin's own `$.tool.call` result never reaches Claude.
    if (!isModelCall(next.origin, e.tool_use_id)) return next(e)
    // The agent's own directory, read in its own hook before the command runs (a subagent's is its worktree).
    let cwd: string | undefined
    try {
      cwd = await $.session.cwd()
    } catch {
      cwd = undefined
    }
    const ran = await next(e)
    // Only a refusal: Claude Code reports it as an error. Refusal wording in a command's output is not one.
    if (ran.deny !== undefined || ran.isError !== true) return ran
    const refusal = parseRefusal(textOf(ran))
    if (refusal === undefined) return ran
    // The path must be the agent's real worktree; with none to check it against, it is not echoed.
    const root = await worktreeRoot($, cwd)
    if (root !== undefined && !isAgentWorktree(refusal.worktree, root)) {
      $.ui.log(`${$name}: refusal text names ${JSON.stringify(refusal.worktree)}, not this agent's worktree; no note`, { to: 'debug' })
      return ran
    }
    const note = coach.record(refusal, e.agentId, root === undefined ? undefined : refusal.worktree)
    $.ui.log(`${$name}: ${refusal.pattern} refusal${e.agentId === undefined ? '' : ` in agent ${e.agentId}`}${note === undefined ? ', no note (already given)' : ', note added'}`, { to: 'debug' })
    if (note === undefined) return ran
    // `context` is what the model reads right after this result. The command and the permissions are left as they are.
    return { ...ran, context: [...(ran.context ?? []), note] } as ToolCallResult
  })
    // A failure of this hook leaves the call as Claude Code answers it.
    .catch(($, e, next) => next(e))
}
