import type { Register } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { DEFAULT_PATTERNS, describeEdit, fallback, isCodeFile, isTestCommand, MAX_INPUT_CHARS, noteFor, parseVerdict, questionText, resolveConfig, saysNoTests, SYSTEM } from '../hooks/gate.js'
import { engine } from './helpers.js'

test('settings: the defaults, and a value out of range keeps its default', async () => {
  const { config, problems } = resolveConfig({})
  expect(config.model).toBe('claude-haiku-5-5')
  expect(config.timeoutSeconds).toBe(10)
  expect(config.patterns).toEqual(DEFAULT_PATTERNS)
  expect(problems).toEqual([])
  const bad = resolveConfig({ timeoutSeconds: 600, model: '  haiku ', testPatterns: 'just check, ,  make   verify ' })
  expect(bad.config.timeoutSeconds).toBe(10)
  expect(bad.config.model).toBe('haiku')
  expect(bad.config.patterns).toEqual(['just check', 'make verify'])
  expect(bad.problems.length).toBe(1)
  expect(resolveConfig({ testPatterns: '' }).config.patterns).toEqual(DEFAULT_PATTERNS)
})

test('test commands: a part of the command starts with a pattern, runners stripped', async () => {
  const yes = ['npm test', 'npm run test:unit', 'cd pkg && pytest -q', 'npx tsc --noEmit -p .', 'python -m pytest tests/', 'CI=1 bun test',
    'cargo check --quiet 2>&1 | tail -20', 'go test ./...', 'make test', 'claude plugin test ./test-gate', 'uv run pytest', 'timeout 60 npm test']
  const no = ['ls', 'npm install', 'git commit -m "npm test"', 'echo pytest', 'cat test.py', 'npm run build', 'make', 'gotest']
  for (const c of yes) expect([c, isTestCommand(c, DEFAULT_PATTERNS)]).toEqual([c, true])
  for (const c of no) expect([c, isTestCommand(c, DEFAULT_PATTERNS)]).toEqual([c, false])
})

test('test commands: package managers, runners and prefixes all count', async () => {
  const yes = [
    // pnpm, yarn and bun forms of test, check, lint and typecheck
    'pnpm test', 'pnpm lint', 'pnpm typecheck', 'pnpm run check', 'yarn lint', 'yarn test', 'bun test', 'bun run lint',
    'bun run typecheck', 'npm run type-check', 'yarn run test:e2e',
    // runner forms
    'pnpm vitest run', 'yarn jest', 'node --test', 'npx --yes tsc', 'npx -y vitest run',
    // prefixed forms
    'pnpm -C pkg test', 'npm --prefix pkg test', 'yarn workspace x test', 'pnpm --filter web lint', 'sudo make test', 'bash -c "npm test"', "sh -c 'cd pkg && pytest'",
    // a part in a subshell
    'cd a && (npm test)',
  ]
  for (const c of yes) expect([c, isTestCommand(c, DEFAULT_PATTERNS)]).toEqual([c, true])
})

test('test commands: a version check or a quoted commit message is not a test run', async () => {
  const no = [
    'tsc --version', 'npx jest --version', 'jest --version', 'pytest --help', 'npm install', 'pnpm add -D vitest', 'yarn build',
    'git commit -m "Fix parser; npm test passes"', "git commit -m 'run pytest later'",
    "git commit -F - <<'EOF'\nFix parser\n\nnpm test\nEOF", 'test -f package.json',
  ]
  for (const c of no) expect([c, isTestCommand(c, DEFAULT_PATTERNS)]).toEqual([c, false])
  // A test run after the commit still counts.
  expect(isTestCommand('git commit -m "wip" && npm test', DEFAULT_PATTERNS)).toBe(true)
})

test('the user saying not to test is caught in plain words', async () => {
  for (const p of ["Fix it, don't run tests", 'no tests please', 'Do not run the tests, just edit', 'skip the tests', 'Quick fix without testing', 'don’t test this']) {
    expect([p, saysNoTests(p)]).toEqual([p, true])
  }
  for (const p of ['Fix the parser bug', 'Add tests for the parser', 'Run the tests after', 'CI says no tests ran, fix that', 'pytest printed no tests found',
    "Don't skip the tests this time", 'do not skip tests', 'never skip the checks']) {
    expect([p, saysNoTests(p)]).toEqual([p, false])
  }
})

test('code files by the code-only rule: docs, config and data are not code', async () => {
  for (const f of ['/r/src/a.ts', '/r/main.py', '/r/Makefile', '/r/lib/x.rs', '/r/build.gradle']) expect([f, isCodeFile(f)]).toEqual([f, true])
  for (const f of ['/r/README.md', '/r/package.json', '/r/.github/ci.yml', '/r/LICENSE', '/r/pyproject.toml', '/r/.gitignore']) expect([f, isCodeFile(f)]).toEqual([f, false])
})

test('the model reply is read strictly: yes or no, with the reason and the command', async () => {
  expect(parseVerdict('ANSWER: yes\nREASON: parser logic changed\nCOMMAND: `npm test`')).toEqual({ needsTests: true, reason: 'parser logic changed', command: 'npm test' })
  expect(parseVerdict('**ANSWER:** No\nREASON: docs only\nCOMMAND: none')).toEqual({ needsTests: false, reason: 'docs only', command: '' })
  expect(parseVerdict('yes')?.needsTests).toBe(true)
  expect(parseVerdict('Maybe, it depends.')).toBeUndefined()
  expect(parseVerdict('ANSWER: perhaps\nREASON: x')).toBeUndefined()
  expect(parseVerdict('')).toBeUndefined()
})

test('the question is capped, and the note names the files and the command', async () => {
  const edit = describeEdit('Edit', { file_path: '/r/a.ts', old_string: 'x'.repeat(5000), new_string: 'y' })!
  expect(edit.summary.length <= 300).toBe(true)
  const q = questionText({ paths: ['/r/a.ts'], edits: Array.from({ length: 50 }, () => edit), prompt: 'p'.repeat(9000), answer: 'a'.repeat(9000) })
  expect(q.length + SYSTEM.length <= MAX_INPUT_CHARS).toBe(true)
  const note = noteFor(['/r/src/a.ts', '/r/src/b.ts'], { nudge: true, why: '', reason: 'logic changed', command: 'npm test', byModel: true })
  expect(note).toContain('test-gate:')
  expect(note).toContain('2 files (a.ts, b.ts)')
  expect(note).toContain('`npm test`')
  expect(note).toContain('why they are not needed')
  expect(note).toContain('Why: logic changed')
  expect(fallback(['/r/README.md'], 'x').nudge).toBe(false)
  expect(fallback(['/r/README.md', '/r/a.go'], 'x').nudge).toBe(true)
})

test('no edits: the turn ends and the model is not asked', async ($, on) => {
  const { seen, start, bash, stop } = engine(on)
  await start($)
  await bash($, 'ls')
  expect((await stop($)).block).toBeUndefined()
  expect(seen.asked.length).toBe(0)
})

test('edits with a test run: the turn ends and the model is not asked', async ($, on) => {
  const { seen, start, edit, bash, stop } = engine(on)
  await start($)
  await edit($, '/r/src/parser.ts')
  // A failing run is a run too.
  await bash($, 'npm test', { fail: true })
  expect((await stop($)).block).toBeUndefined()
  expect(seen.asked.length).toBe(0)
})

test('edits without tests, the model says yes: the turn goes on once with the note', async ($, on) => {
  const { seen, start, edit, write, stop } = engine(on)
  await start($, 'Fix the parser bug')
  await edit($, '/r/src/parser.ts')
  await write($, '/r/src/lexer.ts')
  const stopped = await stop($)
  expect(stopped.block).toContain('test-gate: You edited 2 files (parser.ts, lexer.ts)')
  expect(stopped.block).toContain('`npm test`')
  expect(stopped.block).toContain('Why: logic changed')
  expect(seen.asked.length).toBe(1)
  const asked = seen.asked[0]!
  expect(asked.model).toBe('claude-haiku-5-5')
  expect(asked.timeoutMs).toBe(10_000)
  expect(asked.prompt).toContain('/r/src/parser.ts')
  expect(asked.prompt).toContain('+ a <= b')
  expect(asked.prompt).toContain('Fix the parser bug')
  expect(asked.prompt).toContain('Fixed the off-by-one in the parser.')
  expect(asked.system).toContain('ANSWER: yes or no')
  expect(asked.system).toContain('exactly one shell command')
})

test('edits without tests, the model says no: the turn ends', async ($, on) => {
  const { seen, start, edit, stop } = engine(on, 'ANSWER: no\nREASON: docs only\nCOMMAND: none')
  await start($, 'Update the README')
  await edit($, '/r/README.md')
  expect((await stop($)).block).toBeUndefined()
  // Asked once: a second Stop with no new edits does not ask again.
  expect((await stop($)).block).toBeUndefined()
  expect(seen.asked.length).toBe(1)
})

for (const failure of [{ fail: 'aborted' }, { fail: 'api-error' }, { fail: 'empty-reply' }, 'throw', 'I think you should probably test.'] as const) {
  test(`model failure (${typeof failure === 'string' ? failure.slice(0, 12) : failure.fail}): the code-only rule decides`, async ($, on) => {
    const { seen, start, edit, stop } = engine(on, failure)
    await start($)
    await edit($, '/r/src/parser.ts')
    const stopped = await stop($)
    expect(stopped.block).toContain('test-gate: You edited a file (parser.ts)')
    expect(stopped.block).not.toContain('Why:')
    expect(seen.asked.length).toBe(1)
  })
}

test('model failure with only docs or config edited: the turn ends', async ($, on) => {
  const { start, edit, write, stop } = engine(on, { fail: 'aborted' })
  await start($)
  await edit($, '/r/README.md')
  await write($, '/r/package.json', '{}')
  expect((await stop($)).block).toBeUndefined()
})

test('the user said no tests: no nudge and no model call', async ($, on) => {
  const { seen, start, edit, stop } = engine(on)
  await start($, "Rename the helper, don't run tests")
  await edit($, '/r/src/parser.ts')
  expect((await stop($)).block).toBeUndefined()
  expect(seen.asked.length).toBe(0)
})

test('once per turn: after a nudge the turn always ends, and the next prompt starts over', async ($, on) => {
  const { seen, start, edit, stop } = engine(on)
  await start($)
  await edit($, '/r/src/parser.ts')
  expect((await stop($)).block).toBeDefined()
  // Claude answers without running tests and edits more: the turn still ends.
  await edit($, '/r/src/lexer.ts')
  expect((await stop($, { stop_hook_active: true })).block).toBeUndefined()
  expect((await stop($)).block).toBeUndefined()
  expect(seen.asked.length).toBe(1)
  // A continuation with no text is the same turn.
  await start($, '')
  expect((await stop($)).block).toBeUndefined()
  await start($, 'Now the other bug')
  await edit($, '/r/src/other.ts')
  expect((await stop($)).block).toBeDefined()
  expect(seen.asked.length).toBe(2)
})

test('a Stop after another hook blocked is let through', async ($, on) => {
  const { seen, start, edit, stop } = engine(on)
  await start($)
  await edit($, '/r/src/parser.ts')
  expect((await stop($, { stop_hook_active: true })).block).toBeUndefined()
  expect(seen.asked.length).toBe(0)
})

test('subagents are ignored: their edits do not count and their Stop is let through', async ($, on) => {
  const { seen, start, edit, stop } = engine(on)
  await start($)
  await $.turn.start({ text: 'Refactor the lexer', turnId: 'sub', agentId: 'a1' })
  await edit($, '/r/src/lexer.ts', { agentId: 'a1' })
  expect((await stop($, { agent_id: 'a1' })).block).toBeUndefined()
  expect((await stop($)).block).toBeUndefined()
  expect(seen.asked.length).toBe(0)
  // The subagent's turn.start did not replace the main loop's prompt.
  await edit($, '/r/src/parser.ts')
  await stop($)
  expect(seen.asked[0]!.prompt).toContain('Fix the parser bug')
})

/** A mod of its own that edits a file when a turn starts, as another plugin may. */
const editor: { name: string; register: Register } = {
  name: 'editor',
  register: on => {
    on('turn.start', async ($, e, next) => {
      const started = await next(e)
      await $.tool.call({ tool: 'Edit', file_path: '/r/src/x.ts', old_string: 'a', new_string: 'b', tool_use_id: 'toolu_plugin' } as never)
      return started
    })
  },
}

test("a failed edit, or a plugin's own tool call, does not count", { plugins: [editor] }, async ($, on) => {
  const { seen, start, edit, stop } = engine(on)
  await start($)
  await edit($, '/r/src/parser.ts', { fail: true })
  expect((await stop($)).block).toBeUndefined()
  expect(seen.asked.length).toBe(0)
})

test('off: no hook at all', { options: { enabled: false } }, async ($, on) => {
  const { seen, start, edit, stop } = engine(on)
  await start($)
  await edit($, '/r/src/parser.ts')
  expect((await stop($)).block).toBeUndefined()
  expect(seen.asked.length).toBe(0)
})

test('the model and timeout options are used', { options: { model: 'haiku', timeoutSeconds: 3 } }, async ($, on) => {
  const { seen, start, edit, stop } = engine(on)
  await start($)
  await edit($, '/r/src/parser.ts')
  await stop($)
  expect(seen.asked[0]!.model).toBe('haiku')
  expect(seen.asked[0]!.timeoutMs).toBe(3000)
})
