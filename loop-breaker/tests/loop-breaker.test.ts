import type { On, ToolCallResult } from 'claude-code'
import { expect, test, type Engine } from 'claude-code/testing'
import { keyOf, resolveThreshold, Tracker } from '../hooks/loops.js'

/**
 * Stands in for Claude Code beneath the plugin. A Bash command fails, as core
 * reports a non-zero exit (`isError`, the text the model reads), when it holds
 * `fail`; `Read` fails on a path holding `missing`.
 */
function engine(on: On) {
  const seen = { toasts: [] as string[] }
  on('tool.call', { tool: 'Bash' }, (_, e) =>
    (e.command.includes('fail')
      ? { isError: true, result: `Exit code 1\nerror: ${e.command} broke`, text: `Exit code 1\nerror: ${e.command} broke` }
      : { result: { stdout: 'ok', stderr: '', interrupted: false }, text: 'ok' }) as never,
  )
  on('tool.call', { tool: 'Read' }, (_, e) =>
    (e.file_path.includes('missing')
      ? { isError: true, result: 'File does not exist.', text: 'File does not exist.' }
      : { result: { type: 'text', file: { filePath: e.file_path, content: 'x' } }, text: 'x' }) as never,
  )
  on('ui.toast', (_, e) => {
    seen.toasts.push(e.text)
    return { value: undefined } as never
  })
  return seen
}

const bash = ($: Engine, command: string, agentId?: string) =>
  $.tool.call({ tool: 'Bash', command, ...(agentId !== undefined && { agentId }) } as never) as Promise<ToolCallResult>

const notes = (r: ToolCallResult) => (r.context ?? []).filter(c => c.startsWith('loop-breaker:'))

test('the third failure in a row adds one note and one toast', async ($, on) => {
  const seen = engine(on)
  expect(notes(await bash($, 'npm run fail'))).toEqual([])
  expect(notes(await bash($, 'npm run fail'))).toEqual([])
  const third = await bash($, 'npm run fail')

  expect(third.isError).toBe(true) // the failure still reaches Claude as it was
  const [note] = notes(third)
  expect(note).toContain('`npm run fail`')
  expect(note).toContain('failed 3 times in a row')
  expect(note).toContain('Last error: Exit code 1 error: npm run fail broke')
  expect(note).toContain('change approach')
  expect(note).toContain('ask the user')
  expect(seen.toasts.length).toBe(1)
  expect(seen.toasts[0]).toContain('npm run fail')
})

test('the note is not repeated for the same call until its count resets', async ($, on) => {
  const seen = engine(on)
  for (let i = 0; i < 3; i++) await bash($, 'make fail')
  for (let i = 0; i < 4; i++) expect(notes(await bash($, 'make fail'))).toEqual([])
  expect(seen.toasts.length).toBe(1)

  await bash($, 'ls') // a success clears the count
  for (let i = 0; i < 2; i++) expect(notes(await bash($, 'make fail'))).toEqual([])
  expect(notes(await bash($, 'make fail')).length).toBe(1)
  expect(seen.toasts.length).toBe(2)
})

test('a success in between resets the count', async ($, on) => {
  const seen = engine(on)
  await bash($, 'cargo fail')
  await bash($, 'cargo fail')
  await bash($, 'git status') // a different call that works
  expect(notes(await bash($, 'cargo fail'))).toEqual([])
  expect(notes(await bash($, 'cargo fail'))).toEqual([])
  expect(notes(await bash($, 'cargo fail')).length).toBe(1)
  expect(seen.toasts.length).toBe(1)
})

test('different inputs are counted apart, whitespace differences are not', async ($, on) => {
  const seen = engine(on)
  await bash($, 'pytest fail_a')
  await bash($, 'pytest fail_b')
  await $.tool.call({ tool: 'Read', file_path: '/missing/one' } as never)
  await bash($, 'pytest fail_a')
  await $.tool.call({ tool: 'Read', file_path: '/missing/two' } as never)
  expect(seen.toasts.length).toBe(0)

  // The same command with other spacing is the same call: its third failure.
  const third = await bash($, '  pytest   fail_a ')
  expect(notes(third).length).toBe(1)
  expect(seen.toasts.length).toBe(1)
})

test('a failing tool other than Bash is caught too', async ($, on) => {
  const seen = engine(on)
  for (let i = 0; i < 2; i++) await $.tool.call({ tool: 'Read', file_path: '/missing/x' } as never)
  const third = (await $.tool.call({ tool: 'Read', file_path: '/missing/x' } as never)) as ToolCallResult
  const [note] = notes(third)
  expect(note).toContain('Read {"file_path":"/missing/x"}')
  expect(note).toContain('Last error: File does not exist.')
  expect(seen.toasts.length).toBe(1)
})

test('subagent calls are counted apart from the main loop and from each other', async ($, on) => {
  const seen = engine(on)
  await bash($, 'tsc fail')
  await bash($, 'tsc fail', 'agent-1')
  await bash($, 'tsc fail', 'agent-2')
  await bash($, 'tsc fail')
  await bash($, 'tsc fail', 'agent-1')
  expect(seen.toasts.length).toBe(0)

  // A success in one loop leaves the others' counts alone.
  await bash($, 'ls', 'agent-2')
  expect(notes(await bash($, 'tsc fail')).length).toBe(1)
  expect(notes(await bash($, 'tsc fail', 'agent-1')).length).toBe(1)
  expect(notes(await bash($, 'tsc fail', 'agent-2'))).toEqual([])
  expect(seen.toasts.length).toBe(2)
})

test('the last error is cut to 300 characters', async ($, on) => {
  on('tool.call', { tool: 'Bash' }, () => ({ isError: true, result: 'x', text: `Exit code 2\n${'boom '.repeat(200)}` }) as never)
  for (let i = 0; i < 2; i++) await bash($, 'long')
  const [note] = notes(await bash($, 'long'))
  const error = /Last error: (.*)\n/.exec(note!)![1]!
  expect(error.length).toBe(300)
  expect(error.endsWith('…')).toBe(true)
})

test('the threshold comes from the options', { options: { threshold: 2 } }, async ($, on) => {
  const seen = engine(on)
  await bash($, 'go fail')
  expect(notes(await bash($, 'go fail')).length).toBe(1)
  expect(seen.toasts.length).toBe(1)
})

test('a refused call is not counted', async ($, on) => {
  on('tool.call', { tool: 'Bash' }, () => ({ deny: 'not here' }))
  for (let i = 0; i < 5; i++) expect((await bash($, 'rm -rf fail')).deny).toBe('not here')
})

test('the tracker on its own', async () => {
  const t = new Tracker(3)
  const call = { tool: 'Grep', input: { pattern: 'a  b', path: '/x', tool_use_id: 'tu1' } }
  const fail = { isError: true, text: 'no' }
  t.record(call, fail)
  // Key order, reserved keys and whitespace do not make a different call.
  t.record({ tool: 'Grep', input: { path: '/x', pattern: 'a b', tool_use_id: 'tu2' } }, fail)
  expect(t.countOf(call)).toBe(2)
  expect(t.record(call, fail)?.count).toBe(3)
  expect(keyOf({ tool: 'Bash', input: { command: 'ls', description: 'one' } })).toBe(keyOf({ tool: 'Bash', input: { command: 'ls ', description: 'two' } }))
  expect(keyOf({ tool: 'Grep', input: { pattern: 'a' } })).not.toBe(keyOf({ tool: 'Glob', input: { pattern: 'a' } }))
})

test('a threshold outside 2 to 20 keeps the default', async () => {
  expect(resolveThreshold({}).threshold).toBe(3)
  expect(resolveThreshold({ threshold: 5 }).threshold).toBe(5)
  expect(resolveThreshold({ threshold: '4' }).threshold).toBe(4)
  for (const threshold of [1, 21, 2.5, 'many']) {
    const { threshold: n, problem } = resolveThreshold({ threshold })
    expect(n).toBe(3)
    expect(problem).toContain('using 3')
  }
})
