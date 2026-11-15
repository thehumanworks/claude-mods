import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

/** What the model answers: its text, a failure of the call, or a throw. */
export type ModelAnswer = string | { fail: 'api-error' | 'aborted' | 'empty-reply' } | 'throw'

/** Stands in for Claude Code beneath the plugin: tools, turns, the Stop hook and the model call. */
export function engine(on: On, answer: ModelAnswer = 'ANSWER: yes\nREASON: logic changed\nCOMMAND: npm test') {
  const seen = { asked: [] as { model: string; system: string; prompt: string; timeoutMs?: number; maxTokens?: number }[] }
  let calls = 0
  on('tool.call', (_, e) => {
    if ((e as { fail?: boolean }).fail) return { isError: true, result: 'Exit code 1', text: 'Exit code 1' } as never
    return { result: {}, text: 'ok' } as never
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('classic.Stop', () => ({}))
  on('model.complete', (_, e) => {
    seen.asked.push({ model: e.model, system: String(e.system ?? ''), prompt: String(e.prompt), timeoutMs: e.timeoutMs, maxTokens: e.maxTokens })
    const usage = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
    if (answer === 'throw') throw new Error('model blocked')
    if (typeof answer === 'string') return { value: { isAnswered: true, text: answer, usage } } as never
    if (answer.fail === 'api-error') return { value: { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage } } as never
    return { value: { isAnswered: false, reason: answer.fail, usage } } as never
  })
  on('ui.log', () => ({ value: undefined }) as never)

  const call = ($: Engine, input: Record<string, unknown>) => $.tool.call({ tool_use_id: `toolu_${++calls}`, ...input } as never)
  return {
    seen,
    start: ($: Engine, text = 'Fix the parser bug') => $.turn.start({ text, turnId: `turn_${++calls}` }),
    edit: ($: Engine, file: string, more: Record<string, unknown> = {}) => call($, { tool: 'Edit', file_path: file, old_string: 'a < b', new_string: 'a <= b', ...more }),
    write: ($: Engine, file: string, content = 'export const x = 1') => call($, { tool: 'Write', file_path: file, content }),
    bash: ($: Engine, command: string, more: Record<string, unknown> = {}) => call($, { tool: 'Bash', command, ...more }),
    /** The turn tries to end: what the Stop hooks decided. */
    stop: ($: Engine, more: { stop_hook_active?: boolean; agent_id?: string; last_assistant_message?: string } = {}) =>
      $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'Fixed the off-by-one in the parser.', ...more } as never) as Promise<{ block?: string }>,
  }
}
