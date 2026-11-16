import { expect, test } from 'claude-code/testing'
import { DEFAULT_EXCLUDE, fileNameFor, isErrorAnswer, isExcluded, noteFor, resolveConfig } from '../hooks/diet.js'
import { engine, long } from './helpers.js'

test('settings: the defaults', async () => {
  const { config, problems } = resolveConfig({})
  expect(config).toEqual({ enabled: true, maxChars: 2000, summaryChars: 1500, exclude: DEFAULT_EXCLUDE })
  expect(problems).toEqual([])
})

test('settings: values given as numbers or strings, out of range kept at the default and reported', async () => {
  const ok = resolveConfig({ maxChars: '4000', summaryChars: 800, exclude: ' Explore , my-agent ,, ' })
  expect(ok.config.maxChars).toBe(4000)
  expect(ok.config.summaryChars).toBe(800)
  expect(ok.config.exclude).toEqual(['Explore', 'my-agent'])
  expect(ok.problems).toEqual([])
  const bad = resolveConfig({ maxChars: 50, summaryChars: 'lots' })
  expect(bad.config.maxChars).toBe(2000)
  expect(bad.config.summaryChars).toBe(1500)
  expect(bad.problems.length).toBe(2)
  // A summary longer than the limit is cut to the limit.
  const over = resolveConfig({ maxChars: 1000, summaryChars: 3000 })
  expect(over.config.summaryChars).toBe(1000)
  expect(over.problems.length).toBe(1)
  expect(resolveConfig({ exclude: '' }).config.exclude).toEqual([])
  expect(resolveConfig({ enabled: false }).config.enabled).toBe(false)
})

test('helpers: exclusion without case, error answers, a safe file name, the note', async () => {
  expect(isExcluded('explore', DEFAULT_EXCLUDE)).toBe(true)
  expect(isExcluded('general-purpose', DEFAULT_EXCLUDE)).toBe(false)
  expect(isExcluded(undefined, DEFAULT_EXCLUDE)).toBe(false)
  for (const a of ['API Error: 529 overloaded', '[Request interrupted by user]', 'Error: tool failed', 'Prompt is too long']) expect([a, isErrorAnswer(a)]).toEqual([a, true])
  expect(isErrorAnswer(long())).toBe(false)
  expect(fileNameFor('a/../b c')).toBe('subagent-a-b-c-full.md')
  // Claude Code's Write tool refuses a subagent's file named like this.
  expect(/^(REPORT|SUMMARY|FINDINGS|ANALYSIS).*\.md$/i.test(fileNameFor('a1b2c3'))).toBe(false)
  expect(fileNameFor('///')).toBe('subagent-agent-full.md')
  const note = noteFor('a1b2c3', 6010, resolveConfig({}).config)
  expect(note).toContain('report-diet:')
  expect(note).toContain('6,010 characters')
  expect(note).toContain('`subagent-a1b2c3-full.md`')
  expect(note).toContain('scratchpad directory')
  expect(note).toContain('/tmp')
  expect(note).toContain('at most 1,500 characters')
  expect(note).toContain('start with the conclusion')
  expect(note).toContain("end with the file's absolute path")
})

test('a long answer is held once, with the note', async ($, on) => {
  const { subStop } = engine(on)
  const held = await subStop($, long())
  expect(held.block).toContain('report-diet: Your final answer is 6,010 characters')
  expect(held.block).toContain('subagent-a1b2c3-full.md')
})

test('a short answer is not held', async ($, on) => {
  const { subStop } = engine(on)
  expect((await subStop($, 'Done: the bug is in parse().')).block).toBeUndefined()
  // Exactly at the limit is let through.
  expect((await subStop($, 'y'.repeat(2000))).block).toBeUndefined()
})

test('a second long answer passes, whether or not stop_hook_active is set', async ($, on) => {
  const { subStop } = engine(on)
  expect((await subStop($, long())).block).toBeDefined()
  expect((await subStop($, long(), { stop_hook_active: true })).block).toBeUndefined()
  expect((await subStop($, long())).block).toBeUndefined()
  // Another subagent is held once too.
  expect((await subStop($, long(), { agent_id: 'other' })).block).toContain('subagent-other-full.md')
})

test('a stop that follows any hook block is let through', async ($, on) => {
  const { subStop } = engine(on)
  expect((await subStop($, long(), { stop_hook_active: true })).block).toBeUndefined()
})

test('the main loop is untouched', async ($, on) => {
  const { stop, subStop } = engine(on)
  expect((await stop($, long(20_000))).block).toBeUndefined()
  // A SubagentStop with no agent id is not a subagent's.
  expect((await subStop($, long(), { agent_id: '' })).block).toBeUndefined()
})

test('an error or interrupted answer is never held', async ($, on) => {
  const { subStop } = engine(on)
  expect((await subStop($, `API Error: 500 ${'x'.repeat(5000)}`)).block).toBeUndefined()
  expect((await subStop($, `[Request interrupted by user]\n${'x'.repeat(5000)}`, { agent_id: 'b' })).block).toBeUndefined()
  expect((await subStop($, `Error: ${'x'.repeat(5000)}`, { agent_id: 'c' })).block).toBeUndefined()
  // An error does not use up the one hold.
  expect((await subStop($, long())).block).toBeDefined()
})

test('excluded subagent types are let through', async ($, on) => {
  const { subStop } = engine(on)
  expect((await subStop($, long(), { agent_type: 'Explore' })).block).toBeUndefined()
  expect((await subStop($, long(), { agent_type: 'Plan', agent_id: 'p' })).block).toBeUndefined()
})

test('a block from a hook beneath is kept, not replaced', async ($, on) => {
  const { subStop } = engine(on, { block: 'keep going' })
  expect((await subStop($, long())).block).toBe('keep going')
})

test('off: nothing is held', { options: { enabled: false } }, async ($, on) => {
  const { subStop } = engine(on)
  expect((await subStop($, long())).block).toBeUndefined()
})

test('the options are used', { options: { maxChars: 500, summaryChars: 300, exclude: 'reviewer' } }, async ($, on) => {
  const { subStop } = engine(on)
  expect((await subStop($, 'z'.repeat(400))).block).toBeUndefined()
  const held = await subStop($, 'z'.repeat(600))
  expect(held.block).toContain('over the 500')
  expect(held.block).toContain('at most 300 characters')
  expect((await subStop($, long(), { agent_type: 'reviewer', agent_id: 'r' })).block).toBeUndefined()
  // Explore is no longer excluded once the list is replaced.
  expect((await subStop($, long(), { agent_type: 'Explore', agent_id: 'e' })).block).toBeDefined()
})
