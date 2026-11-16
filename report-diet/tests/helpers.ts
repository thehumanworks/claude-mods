import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

/** Stands in for Claude Code beneath the plugin: the Stop and SubagentStop hooks, and the log. */
export function engine(on: On, beneath: { block?: string } = {}) {
  on('classic.Stop', () => ({}))
  on('classic.SubagentStop', () => ({ ...beneath }))
  on('ui.log', () => ({ value: undefined }) as never)
  on('session.start', () => ({}) as never)
  return {
    /** A subagent tries to end: what the SubagentStop hooks decided. */
    subStop: ($: Engine, answer: string, more: { agent_id?: string; agent_type?: string; stop_hook_active?: boolean } = {}) =>
      $.classic.SubagentStop({
        stop_hook_active: false, agent_id: 'a1b2c3', agent_type: 'general-purpose', agent_transcript_path: '/t/a.jsonl',
        last_assistant_message: answer, ...more,
      } as never) as Promise<{ block?: string }>,
    /** The main loop tries to end. */
    stop: ($: Engine, answer: string) =>
      $.classic.Stop({ stop_hook_active: false, last_assistant_message: answer } as never) as Promise<{ block?: string }>,
  }
}

export const long = (n = 6000) => `Findings:\n${'x'.repeat(n)}`
