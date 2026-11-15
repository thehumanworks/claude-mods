import type { On } from 'claude-code'
import { mock, type Engine } from 'claude-code/testing'

export const CWD = '/repo'

/** What the check command answers, given how many times it has run. */
export type Answer = { exitCode: number; stdout?: string; stderr?: string; seconds?: number } | 'cannot-start'

/** Stands in for Claude Code beneath the plugin: the session's folder, its tools, its prompts and the shell. */
export function engine(on: On, answer: (n: number) => Answer = () => ({ exitCode: 0 })) {
  const clock = mock.clock(on, { now: 1_000_000 })
  const seen = {
    runs: [] as { argv: readonly string[]; cwd?: string; timeoutMs?: number }[],
    /** What the model read after each tool result, by call. */
    toolContext: [] as (readonly string[] | undefined)[],
    promptContext: [] as (readonly string[] | undefined)[],
    toasts: [] as string[],
  }
  on('session.cwd', () => ({ value: CWD }))
  on('env.get', () => ({ value: undefined }) as never)
  on('process.run', async (_, e) => {
    seen.runs.push({ argv: e.argv, cwd: e.init?.cwd, timeoutMs: e.init?.timeoutMs })
    const a = answer(seen.runs.length)
    if (a === 'cannot-start') throw new Error('spawn sh ENOENT')
    if (a.seconds !== undefined) await clock.sleep(a.seconds * 1000)
    return { value: { exitCode: a.exitCode, stdout: a.stdout ?? '', stderr: a.stderr ?? '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', (_, e) => {
    if ((e as { fail?: boolean }).fail) return { isError: true, result: 'old_string not found', text: 'old_string not found' } as never
    return { result: {} } as never
  })
  on('prompt.submit', (_, e) => {
    seen.promptContext.push(e.context)
    // A prompt the engine does not let in (a Stop hook stands, say).
    if (e.text === 'blocked') return { drop: 'blocked' }
    return { text: e.text, context: e.context }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('ui.log', () => ({ value: undefined }) as never)
  on('ui.toast', (_, e) => {
    seen.toasts.push(JSON.stringify(e))
    return { value: undefined } as never
  })

  /** One tool call of the main loop (or of a subagent), and what the model read after its result. */
  const call = async ($: Engine, input: Record<string, unknown>): Promise<readonly string[] | undefined> => {
    // The model's calls carry the id of their tool_use block.
    const answered = (await $.tool.call({ tool_use_id: `toolu_${seen.toolContext.length + 1}`, ...input } as never)) as { context?: readonly string[] }
    seen.toolContext.push(answered.context)
    await clock.settle()
    return answered.context
  }
  const edit = ($: Engine, file: string, more: Record<string, unknown> = {}) =>
    call($, { tool: 'Edit', file_path: file, old_string: 'a', new_string: 'b', ...more })
  const write = ($: Engine, file: string) => call($, { tool: 'Write', file_path: file, content: 'x' })
  const bash = ($: Engine, more: Record<string, unknown> = {}) => call($, { tool: 'Bash', command: 'ls', ...more })
  const prompt = async ($: Engine, text = 'go on'): Promise<readonly string[] | undefined> => {
    await $.prompt.submit({ text } as never)
    return seen.promptContext.at(-1)
  }
  return { seen, clock, edit, write, bash, prompt }
}

/** tsc's output for errors in these files, one line each. */
export const tsc = (...errors: [file: string, line: number, text: string][]) =>
  errors.map(([file, line, text]) => `${file}(${line},5): error TS2322: ${text}`).join('\n')
