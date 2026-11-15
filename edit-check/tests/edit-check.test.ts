import type { Register } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { blocksOf, clip, isWatched, judge, mentionTest, resolveConfig, splitGlobs } from '../hooks/check.js'
import { DEBOUNCE_MS } from '../hooks/register.js'
import { CWD, engine, tsc } from './helpers.js'

const on = { command: 'npx tsc --noEmit -p .' }

test('settings: no command is off, and a value out of range keeps the default', async () => {
  expect(resolveConfig({}).config).toEqual({ command: '', globs: [], timeoutSeconds: 60, maxChars: 4000 })
  expect(resolveConfig({ command: '  tsc  ', globs: '**/*.{ts,tsx}, *.py' }).config.globs).toEqual(['**/*.{ts,tsx}', '*.py'])
  const { config, problems } = resolveConfig({ command: 'tsc', timeoutSeconds: 0, maxChars: '9000' })
  expect(config.timeoutSeconds).toBe(60)
  expect(config.maxChars).toBe(9000)
  expect(problems.length).toBe(1)
  expect(splitGlobs('')).toEqual([])
})

test('globs: with a slash against the path in the folder, without one against the file name', async () => {
  expect(isWatched([], CWD, '/repo/README.md')).toBe(true)
  expect(isWatched(['**/*.ts'], CWD, '/repo/src/a.ts')).toBe(true)
  expect(isWatched(['**/*.ts'], CWD, '/repo/a.ts')).toBe(true)
  expect(isWatched(['**/*.ts'], CWD, '/repo/a.tsx')).toBe(false)
  expect(isWatched(['src/*.ts'], CWD, '/repo/src/a.ts')).toBe(true)
  expect(isWatched(['src/*.ts'], CWD, '/repo/src/deep/a.ts')).toBe(false)
  expect(isWatched(['*.{py,pyi}'], CWD, '/repo/pkg/m.pyi')).toBe(true)
  expect(isWatched(['*.py'], CWD, '/repo/notes.md')).toBe(false)
})

test('a line names a touched file by its whole path, relative or absolute', async () => {
  const names = mentionTest(CWD, ['/repo/src/a.ts'])
  expect(names('src/a.ts(3,5): error TS2322')).toBe(true)
  expect(names('./src/a.ts:3:5 - error')).toBe(true)
  expect(names('/repo/src/a.ts')).toBe(true)
  expect(names('  --> src/a.ts:3:5')).toBe(true)
  expect(names('src/a.tsx(3,5): error')).toBe(false)
  expect(names('lib/src/a.ts(3,5): error')).toBe(false)
  expect(names('src/b.ts(3,5): error')).toBe(false)
})

test('blocks keep a heading with the lines indented under it', async () => {
  const eslint = '/repo/src/a.ts\n  3:5  error  no-unused-vars\n  4:1  error  semi\n\n/repo/src/b.ts\n  1:1  error  semi\n'
  expect(blocksOf(eslint)).toEqual([
    ['/repo/src/a.ts', '  3:5  error  no-unused-vars', '  4:1  error  semi'],
    ['/repo/src/b.ts', '  1:1  error  semi'],
  ])
  expect(blocksOf('\u001b[31msrc/a.ts\u001b[0m:1 bad\r\n')).toEqual([['src/a.ts:1 bad']])
})

test('only errors in the files touched since the last run are handed over, with the exit code', async () => {
  const output = tsc(['src/a.ts', 3, 'Type string is not number'], ['src/old.ts', 9, 'an old error'], ['src/b.ts', 1, 'b broke'])
  const { outcome } = judge({ command: 'tsc', exitCode: 2, output, cwd: CWD, touched: ['/repo/src/a.ts', '/repo/src/b.ts'], wasReported: false, maxChars: 4000 })
  expect(outcome.kind).toBe('errors')
  const text = (outcome as { text: string }).text
  expect(text).toContain('exit code 2')
  expect(text).toContain('src/a.ts(3,5)')
  expect(text).toContain('src/b.ts(1,5)')
  expect(text).not.toContain('old.ts')
})

test('with no line naming a touched file, the first lines go over once, and the same errors are not handed over again', async () => {
  const output = Array.from({ length: 50 }, (_, i) => `error ${i}: something is wrong`).join('\n')
  const first = judge({ command: 'make check', exitCode: 1, output, cwd: CWD, touched: ['/repo/x.c'], wasReported: false, maxChars: 4000 })
  const text = (first.outcome as { text: string }).text
  expect(text).toContain('No line names those files')
  expect(text).toContain('error 29:')
  expect(text).not.toContain('error 30:')
  expect(text).toContain('[20 more lines]')
  const again = judge({ command: 'make check', exitCode: 1, output, cwd: CWD, touched: ['/repo/x.c'], previous: first.blocks, wasReported: false, maxChars: 4000 })
  expect(again.outcome.kind).toBe('silent')
})

test('what is handed over is cut to the maximum length', async () => {
  const text = clip('x'.repeat(5000), 1000)
  expect(text.length < 1100).toBe(true)
  expect(text).toContain('[4000 more characters cut]')
  const output = tsc(...Array.from({ length: 200 }, (_, i) => ['src/a.ts', i, 'y'.repeat(40)] as [string, number, string]))
  const { outcome } = judge({ command: 'tsc', exitCode: 2, output, cwd: CWD, touched: ['/repo/src/a.ts'], wasReported: false, maxChars: 500 })
  expect((outcome as { text: string }).text.length < 800).toBe(true)
})

test('off: with no command set nothing runs and nothing is handed over', async ($, onHook) => {
  const { seen, clock, edit, bash, prompt } = engine(onHook, () => ({ exitCode: 2, stdout: tsc(['src/a.ts', 1, 'bad']) }))
  await edit($, '/repo/src/a.ts')
  await clock.advance(60_000)
  expect(seen.runs.length).toBe(0)
  expect(await bash($)).toBeUndefined()
  expect(await prompt($)).toBeUndefined()
})

test('debounce: several edits in a row start one run, after they stop', { options: on }, async ($, onHook) => {
  const { seen, clock, edit, write } = engine(onHook)
  await edit($, '/repo/src/a.ts')
  await clock.advance(DEBOUNCE_MS - 500)
  await edit($, '/repo/src/b.ts')
  await clock.advance(DEBOUNCE_MS - 500)
  await write($, '/repo/src/c.ts')
  expect(seen.runs.length).toBe(0)
  await clock.advance(DEBOUNCE_MS)
  expect(seen.runs.length).toBe(1)
  expect(seen.runs[0]!.argv).toEqual(['sh', '-c', 'npx tsc --noEmit -p .'])
  expect(seen.runs[0]!.cwd).toBe(CWD)
  await clock.advance(60_000)
  expect(seen.runs.length).toBe(1)
})

test('the edit itself is never held up, and a failed edit or another tool starts nothing', { options: on }, async ($, onHook) => {
  const { seen, clock, edit, bash } = engine(onHook, () => ({ exitCode: 0, seconds: 30 }))
  // The tool call resolves with the clock standing still: the check waits on nothing of it.
  expect(await edit($, '/repo/src/a.ts')).toBeUndefined()
  await edit($, '/repo/src/b.ts', { fail: true })
  await bash($)
  await clock.advance(DEBOUNCE_MS)
  expect(seen.runs.length).toBe(1)
})

test('globs: an edit to a file they leave out starts nothing', { options: { ...on, globs: '**/*.ts' } }, async ($, onHook) => {
  const { seen, clock, edit } = engine(onHook)
  await edit($, '/repo/README.md')
  await clock.advance(DEBOUNCE_MS * 2)
  expect(seen.runs.length).toBe(0)
  await edit($, '/repo/src/a.ts')
  await clock.advance(DEBOUNCE_MS)
  expect(seen.runs.length).toBe(1)
})

test('errors in the edited files reach Claude after its next tool call, once', { options: on }, async ($, onHook) => {
  const out = tsc(['src/a.ts', 3, 'Type string is not number'], ['src/other.ts', 1, 'not ours'])
  const { seen, clock, edit, bash } = engine(onHook, () => ({ exitCode: 2, stdout: out }))
  await edit($, '/repo/src/a.ts')
  await clock.advance(DEBOUNCE_MS)
  const context = await bash($)
  expect(context?.length).toBe(1)
  expect(context![0]).toContain('exit code 2')
  expect(context![0]).toContain('src/a.ts(3,5): error TS2322: Type string is not number')
  expect(context![0]).not.toContain('other.ts')
  expect(await bash($)).toBeUndefined()
  expect(seen.runs.length).toBe(1)
})

test('a check that ends after the turn reaches Claude with the next prompt', { options: on }, async ($, onHook) => {
  const { clock, edit, bash, prompt } = engine(onHook, () => ({ exitCode: 1, stdout: 'src/a.ts:3:1: E302 expected 2 blank lines' }))
  await edit($, '/repo/src/a.ts')
  await clock.advance(DEBOUNCE_MS)
  const context = await prompt($)
  expect(context?.[0]).toContain('E302')
  expect(await bash($)).toBeUndefined()
})

test('a subagent edit counts, but only the main loop is handed the errors', { options: on }, async ($, onHook) => {
  const { clock, edit, bash } = engine(onHook, () => ({ exitCode: 2, stdout: tsc(['src/a.ts', 1, 'bad']) }))
  await edit($, '/repo/src/a.ts', { agentId: 'a1' })
  await clock.advance(DEBOUNCE_MS)
  expect(await bash($, { agentId: 'a1' })).toBeUndefined()
  expect((await bash($))?.[0]).toContain('src/a.ts(1,5)')
})

/** A mod of its own that makes a tool call when a turn ends, as another plugin may, and shows what it read after it. */
const caller: { name: string; register: Register } = {
  name: 'caller',
  register: on => {
    on('turn.complete', async ($, e, next) => {
      const answered = (await $.tool.call({ tool: 'Bash', command: 'ls', tool_use_id: 'toolu_plugin' } as never)) as { context?: unknown }
      $.ui.toast(`caller read: ${JSON.stringify(answered.context ?? null)}`)
      return next(e)
    })
  },
}

test('a tool call another plugin makes does not use up the report', { options: on, plugins: [caller] }, async ($, onHook) => {
  const { seen, clock, edit, bash } = engine(onHook, () => ({ exitCode: 2, stdout: tsc(['src/a.ts', 1, 'bad']) }))
  await edit($, '/repo/src/a.ts')
  await clock.advance(DEBOUNCE_MS)
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never)
  await clock.settle()
  expect(seen.toasts).toEqual([JSON.stringify({ text: 'caller read: null' })])
  expect((await bash($))?.[0]).toContain('src/a.ts(1,5)')
})

test('a prompt that does not get in leaves the report for the next request', { options: on }, async ($, onHook) => {
  const { clock, edit, prompt } = engine(onHook, () => ({ exitCode: 2, stdout: tsc(['src/a.ts', 1, 'bad']) }))
  await edit($, '/repo/src/a.ts')
  await clock.advance(DEBOUNCE_MS)
  await prompt($, 'blocked')
  expect((await prompt($))?.[0]).toContain('src/a.ts(1,5)')
  expect(await prompt($)).toBeUndefined()
})

test('an error Claude was told of and left alone keeps the pass note for later, with no "cleared" note', { options: on }, async ($, onHook) => {
  const aError = tsc(['src/a.ts', 3, 'bad'])
  const answers = [
    { exitCode: 2, stdout: aError },
    // Claude edits only b.ts: the a.ts error is still there.
    { exitCode: 2, stdout: aError },
    { exitCode: 0 },
  ]
  const { clock, edit, bash } = engine(onHook, n => answers[n - 1]!)
  const round = async (file: string) => {
    await edit($, file)
    await clock.advance(DEBOUNCE_MS)
    return bash($)
  }
  expect((await round('/repo/src/a.ts'))?.[0]).toContain('src/a.ts(3,5)')
  expect(await round('/repo/src/b.ts')).toBeUndefined()
  expect(await round('/repo/src/a.ts')).toEqual(['edit-check: `npx tsc --noEmit -p .` passes again.'])
})

test('"cleared" is said only once none of the errors Claude was told of are left', async () => {
  const told = judge({ command: 'tsc', exitCode: 2, output: tsc(['src/a.ts', 3, 'bad'], ['src/old.ts', 1, 'old']), cwd: CWD, touched: ['/repo/src/a.ts'], wasReported: false, maxChars: 4000 })
  const reported = (told.outcome as { blocks: ReadonlySet<string> }).blocks
  const base = { command: 'tsc', exitCode: 2, cwd: CWD, touched: ['/repo/src/b.ts'], previous: told.blocks, wasReported: true, reported, maxChars: 4000 }
  expect(judge({ ...base, output: tsc(['src/a.ts', 3, 'bad'], ['src/old.ts', 1, 'old']) }).outcome.kind).toBe('silent')
  const cleared = judge({ ...base, output: tsc(['src/old.ts', 1, 'old']) }).outcome
  expect(cleared.kind).toBe('cleared')
  expect((cleared as { text: string }).text).toContain('the errors you were told of are gone')
})

test('passing says nothing, and one short note follows a failure Claude was told of', { options: on }, async ($, onHook) => {
  const answers = [
    { exitCode: 0 },
    { exitCode: 2, stdout: tsc(['src/a.ts', 3, 'bad']) },
    { exitCode: 0 },
    { exitCode: 0 },
  ]
  const { clock, edit, bash } = engine(onHook, n => answers[n - 1]!)
  const round = async () => {
    await edit($, '/repo/src/a.ts')
    await clock.advance(DEBOUNCE_MS)
    return bash($)
  }
  expect(await round()).toBeUndefined()
  expect((await round())?.[0]).toContain('failed (exit code 2)')
  expect(await round()).toEqual(['edit-check: `npx tsc --noEmit -p .` passes again.'])
  expect(await round()).toBeUndefined()
})

test('a failure fixed before Claude was told of it is never told, nor its pass', { options: on }, async ($, onHook) => {
  const answers = [{ exitCode: 2, stdout: tsc(['src/a.ts', 3, 'bad']) }, { exitCode: 0 }]
  const { seen, clock, edit, bash } = engine(onHook, n => answers[n - 1]!)
  // No tool call between the two checks: the first result is still waiting when the second replaces it.
  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b', agentId: 'a1' } as never)
  await clock.advance(DEBOUNCE_MS)
  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/a.ts', old_string: 'b', new_string: 'c', agentId: 'a1' } as never)
  await clock.advance(DEBOUNCE_MS)
  expect(seen.runs.length).toBe(2)
  expect(await bash($)).toBeUndefined()
})

test('a check edited under is dropped, and the next covers its files too', { options: on }, async ($, onHook) => {
  const answers = [
    { exitCode: 2, stdout: tsc(['src/a.ts', 1, 'stale']), seconds: 10 },
    { exitCode: 2, stdout: tsc(['src/a.ts', 1, 'fresh'], ['src/b.ts', 2, 'also']) },
  ]
  const { seen, clock, edit, bash } = engine(onHook, n => answers[n - 1]!)
  await edit($, '/repo/src/a.ts')
  await clock.advance(DEBOUNCE_MS)
  expect(seen.runs.length).toBe(1)
  await edit($, '/repo/src/b.ts')
  await clock.advance(DEBOUNCE_MS)
  // Still one: the second waits for the first to end.
  expect(seen.runs.length).toBe(1)
  // The first ends 10 s after it started, its result dropped; the second starts a debounce later.
  await clock.advance(10_000 - DEBOUNCE_MS)
  expect(await bash($)).toBeUndefined()
  expect(seen.runs.length).toBe(1)
  await clock.advance(DEBOUNCE_MS)
  expect(seen.runs.length).toBe(2)
  const context = await bash($)
  expect(context?.[0]).toContain('fresh')
  expect(context?.[0]).toContain('src/b.ts(2,5)')
  expect(context?.[0]).not.toContain('stale')
})

test('timeout: a check still running is stopped, nothing reaches Claude, and the user is told once', { options: { ...on, timeoutSeconds: 5 } }, async ($, onHook) => {
  const { seen, clock, edit, bash } = engine(onHook, () => ({ exitCode: 2, stdout: tsc(['src/a.ts', 1, 'late']), seconds: 60 }))
  await edit($, '/repo/src/a.ts')
  await clock.advance(DEBOUNCE_MS)
  expect(seen.runs[0]!.timeoutMs).toBe(5000)
  await clock.advance(5_000)
  expect(seen.toasts.length).toBe(1)
  expect(seen.toasts[0]).toContain('did not finish in 5s')
  // A new check can start once the timed-out one is stopped.
  await edit($, '/repo/src/a.ts')
  await clock.advance(DEBOUNCE_MS)
  expect(seen.runs.length).toBe(2)
  await clock.advance(60_000)
  expect(await bash($)).toBeUndefined()
  expect(seen.toasts.length).toBe(1)
})

test('a command that cannot start is told to the user, not to Claude', { options: on }, async ($, onHook) => {
  const { seen, clock, edit, bash } = engine(onHook, () => 'cannot-start')
  await edit($, '/repo/src/a.ts')
  await clock.advance(DEBOUNCE_MS)
  expect(seen.toasts[0]).toContain('could not run')
  expect(await bash($)).toBeUndefined()
})
