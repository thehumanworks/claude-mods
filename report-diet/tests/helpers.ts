import type { On, ToolCallResult } from 'claude-code'
import type { Engine } from 'claude-code/testing'

export const TMP = '/tmp-test'
export const DIR = `${TMP}/claude-report-diet`

export type Answer = { status: 'completed'; text: string } | { status: 'async_launched' } | { isError: true; text: string }

/**
 * Stands in for Claude Code beneath the plugin: the Agent tool answers with what `answer`
 * gives, the file system is a map, and the process runner reports the temp folder.
 */
export function engine(on: On, answer: (prompt: string) => Answer = () => ({ status: 'completed', text: long() }), world: { failWrite?: boolean; tmp?: string; dirIsLink?: boolean } = {}) {
  const files = new Map<string, string>()
  const seen = { runs: [] as (readonly string[])[], logs: [] as string[] }
  on('session.root', () => ({ value: '/repo' }) as never)
  on('tool.call', (_, e) => {
    const a = answer(String((e as unknown as { prompt?: string }).prompt ?? ''))
    if ('isError' in a) return { isError: true, result: a.text, text: a.text } as never
    if (a.status === 'async_launched') return { result: { status: 'async_launched', agentId: 'bg1', description: 'd', prompt: 'p', outputFile: '/o' }, text: 'Async agent launched' } as never
    return { result: { status: 'completed', agentId: 'fg1', content: [{ type: 'text', text: a.text }], totalToolUseCount: 0, totalDurationMs: 1, totalTokens: 1, prompt: 'p' }, text: a.text } as never
  })
  on('fs.write', (_, e) => {
    if (world.failWrite) throw new Error('EACCES')
    files.set(e.path, e.text)
    return { value: undefined } as never
  })
  on('fs.stat', (_, e) => {
    if (e.path === DIR && world.dirIsLink) return { value: { kind: 'other', size: 0, mtimeMs: 0, isLink: true } } as never
    throw new Error(`ENOENT: ${e.path}`)
  })
  on('fs.list', () => ({ value: [...files.keys()].map(p => ({ name: p.split('/').pop()!, kind: 'file', size: 1, mtimeMs: 0, isLink: false })) }) as never)
  on('process.run', (_, e) => {
    seen.runs.push(e.argv)
    const stdout = e.argv[0] === 'sh' ? (world.tmp ?? TMP) : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })
  on('ui.log', (_, e) => {
    seen.logs.push(e.text)
    return { value: undefined } as never
  })
  on('session.start', () => ({}) as never)

  let n = 0
  return {
    files,
    seen,
    /** The model's own Agent call: what the parent gets back. */
    agent: ($: Engine, more: Record<string, unknown> = {}) =>
      $.tool.call({ tool: 'Agent', description: 'Research', prompt: 'Look into it', tool_use_id: `toolu_${++n}`, ...more } as never) as Promise<ToolCallResult<'Agent'>>,
    /** A background agent's notification row arriving at the parent. */
    notify: async ($: Engine, toolUseId: string, result: string, status = 'completed', kind = 'task-notification') => {
      const text = `<task-notification>\n<task-id>bg1</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>${status}</status>\n<summary>Agent "Research" finished</summary>\n<result>\n${result}\n</result>\n<usage><tool_uses>0</tool_uses></usage>\n</task-notification>`
      const stored = await $.session.append({ message: { type: 'user', role: 'user', content: [{ type: 'text', text }] }, door: 'prompt', origin: { kind }, uuid: `row-${++n}` } as never) as unknown as { message: { content: { text: string }[] } }
      return stored.message.content[0]!.text
    },
  }
}

/** A report: a conclusion, many lines, an ending. */
export const long = (lines = 200) => ['Conclusion: the bug is in parse().', ...Array.from({ length: lines }, (_, i) => `Detail line ${i} ${'x'.repeat(40)}`), 'Files: src/parse.ts'].join('\n')

/** The text the parent reads from a completed Agent result. */
export const textOf = (r: ToolCallResult<'Agent'>): string => {
  const rec = r.result as { content?: { text: string }[] }
  return (rec.content ?? []).map(b => b.text).join('\n')
}
