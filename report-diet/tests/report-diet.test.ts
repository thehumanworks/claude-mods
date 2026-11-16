import { expect, test } from 'claude-code/testing'
import { cut, DEFAULT_EXCLUDE, DEFAULTS, fileNameFor, FILE_RE, isExcluded, parseNotification, reportOf, resolveConfig } from '../hooks/diet.js'
import { DIR, engine, long, textOf } from './helpers.js'

test('settings: the defaults', async () => {
  const { config, problems } = resolveConfig({})
  expect(config).toEqual({ enabled: true, maxChars: 4000, headChars: 2500, tailChars: 800, exclude: DEFAULT_EXCLUDE })
  expect(problems).toEqual([])
})

test('settings: numbers or strings; out of range kept at the default; head and tail kept under the limit', async () => {
  const ok = resolveConfig({ maxChars: '8000', headChars: 3000, tailChars: '0', exclude: ' Explore , reviewer ,, ' })
  expect([ok.config.maxChars, ok.config.headChars, ok.config.tailChars]).toEqual([8000, 3000, 0])
  expect(ok.config.exclude).toEqual(['Explore', 'reviewer'])
  expect(ok.problems).toEqual([])
  const bad = resolveConfig({ maxChars: 10, headChars: 'lots' })
  expect([bad.config.maxChars, bad.config.headChars]).toEqual([4000, 2500])
  expect(bad.problems.length).toBe(2)
  const over = resolveConfig({ maxChars: 2000 })
  expect([over.config.headChars, over.config.tailChars]).toEqual([1200, 400])
  expect(over.problems.length).toBe(1)
  expect(resolveConfig({ exclude: '' }).config.exclude).toEqual([])
})

test('helpers: exclusion, file names, the cut, reading records and notifications', async () => {
  expect(isExcluded('explore', DEFAULT_EXCLUDE)).toBe(true)
  expect(isExcluded(undefined, DEFAULT_EXCLUDE)).toBe(false)
  expect(isExcluded(undefined, ['general-purpose'])).toBe(true)
  expect(fileNameFor('toolu_01AB')).toBe('agent-toolu_01AB.md')
  expect(fileNameFor('../x y')).toBe('agent-_x_y.md')
  expect(FILE_RE.test(fileNameFor('toolu_01AB'))).toBe(true)
  const report = long()
  const c = cut(report, '/t/agent-x.md', DEFAULTS)
  expect(c.startsWith('Conclusion: the bug is in parse().')).toBe(true)
  expect(c.endsWith('Files: src/parse.ts')).toBe(true)
  expect(c).toContain('characters cut here. The whole report is in /t/agent-x.md; Read it')
  expect(c.length < 3600).toBe(true)
  expect(cut(report, '/p', { headChars: 500, tailChars: 0 })).not.toContain('Files:')
  expect(reportOf({ status: 'completed', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] })).toBe('a\nb')
  expect(reportOf({ status: 'async_launched' })).toBeUndefined()
  expect(reportOf({ status: 'completed', content: [{ type: 'image' }] })).toBeUndefined()
  expect(parseNotification('<task-notification><tool-use-id>t1</tool-use-id><status>completed</status><result>R</result></task-notification>'))
    .toEqual({ toolUseId: 't1', status: 'completed', result: 'R', start: 82, end: 83 })
  expect(parseNotification('<task-notification><status>completed</status></task-notification>')).toBeUndefined()
})

test('a long foreground report is cut, and the whole text saved by tool_use_id', async ($, on) => {
  const { agent, files } = engine(on)
  const r = await agent($, { tool_use_id: 'toolu_A', subagent_type: 'general-purpose' })
  const text = textOf(r)
  const path = `${DIR}/agent-toolu_A.md`
  expect(text).toContain(`The whole report is in ${path}`)
  expect(text.startsWith('Conclusion:')).toBe(true)
  expect(text.endsWith('Files: src/parse.ts')).toBe(true)
  expect(text.length < 3600).toBe(true)
  expect(files.get(path)!).toContain(long())
  expect(files.get(path)!).toContain('general-purpose: Research')
})

test('a short report is left whole', async ($, on) => {
  const { agent, files } = engine(on, () => ({ status: 'completed', text: 'Done: the bug is in parse().' }))
  const r = await agent($)
  expect(textOf(r)).toBe('Done: the bug is in parse().')
  expect(r.text).toBe('Done: the bug is in parse().')
  expect(files.size).toBe(0)
})

test('an error result is never shaped', async ($, on) => {
  const { agent, files } = engine(on, () => ({ isError: true, text: `Agent failed: ${'x'.repeat(9000)}` }))
  const r = await agent($)
  expect(r.isError).toBe(true)
  expect(r.text!.length > 9000).toBe(true)
  expect(files.size).toBe(0)
})

test('a failure to save leaves the result whole', async ($, on) => {
  const { agent } = engine(on, undefined, { failWrite: true })
  const r = await agent($)
  expect(textOf(r)).toBe(long())
})

test('a save folder that is a link is not used', async ($, on) => {
  const { agent, files } = engine(on, undefined, { dirIsLink: true })
  expect(textOf(await agent($))).toBe(long())
  expect(files.size).toBe(0)
})

test('excluded subagent types, other tools and a plugin call are left alone', async ($, on) => {
  const { agent, files } = engine(on)
  expect(textOf(await agent($, { subagent_type: 'Explore' }))).toBe(long())
  expect(textOf(await agent($, { subagent_type: 'plan' }))).toBe(long())
  expect(textOf(await agent($, { tool: 'Read', file_path: '/x' }))).toBe(long())
  expect(textOf(await agent($, { tool_use_id: '' }))).toBe(long())
  expect(files.size).toBe(0)
  // The legacy name is cut too.
  expect(textOf(await agent($, { tool: 'Task' }))).toContain('characters cut here')
})

test('a background report is cut in its notification, for a call seen launched', async ($, on) => {
  const { agent, notify, files } = engine(on, () => ({ status: 'async_launched' }))
  const launched = await agent($, { tool_use_id: 'toolu_BG', run_in_background: true })
  expect(launched.text).toBe('Async agent launched')
  const text = await notify($, 'toolu_BG', long())
  expect(text).toContain('<tool-use-id>toolu_BG</tool-use-id>')
  expect(text).toContain(`The whole report is in ${DIR}/agent-toolu_BG.md`)
  expect(text).toContain('<result>\nConclusion:')
  expect(text).toContain('Files: src/parse.ts\n</result>')
  expect(text.length < 4000).toBe(true)
  expect(files.get(`${DIR}/agent-toolu_BG.md`)!).toContain(long())
  // Once only: the same notification again is left whole.
  expect(await notify($, 'toolu_BG', long())).toContain('Detail line 100')
})

test('notifications left whole: unknown calls, failed agents, short results, other origins', async ($, on) => {
  const { agent, notify, files } = engine(on, () => ({ status: 'async_launched' }))
  expect(await notify($, 'toolu_unknown', long())).toContain('Detail line 100')
  await agent($, { tool_use_id: 'toolu_F' })
  expect(await notify($, 'toolu_F', long(), 'failed')).toContain('Detail line 100')
  await agent($, { tool_use_id: 'toolu_S' })
  expect(await notify($, 'toolu_S', 'short')).toContain('<result>\nshort\n</result>')
  await agent($, { tool_use_id: 'toolu_P' })
  expect(await notify($, 'toolu_P', long(), 'completed', 'peer')).toContain('Detail line 100')
  await agent($, { tool_use_id: 'toolu_X', subagent_type: 'Explore' })
  expect(await notify($, 'toolu_X', long())).toContain('Detail line 100')
  expect(files.size).toBe(0)
})

test('the temp folder comes from TMPDIR, and old files are cleaned', async ($, on) => {
  const { agent, seen, files } = engine(on, undefined, { tmp: '/var/tmp/x/' })
  for (let i = 0; i < 3; i++) files.set(`/var/tmp/x/claude-report-diet/agent-old${i}.md`, 'old')
  files.set('/var/tmp/x/claude-report-diet/keep.txt', 'not ours')
  await agent($, { tool_use_id: 'toolu_T' })
  expect(files.has('/var/tmp/x/claude-report-diet/agent-toolu_T.md')).toBe(true)
  const rm = seen.runs.find(a => a[0] === 'rm')!
  // Files listed with mtime 0 are past the age limit: ours are removed, other files never.
  expect(rm.slice(0, 3)).toEqual(['rm', '-f', '--'])
  expect(rm).toContain('/var/tmp/x/claude-report-diet/agent-old0.md')
  expect(rm.some(p => p.endsWith('keep.txt'))).toBe(false)
})

test('off: nothing is cut', { options: { enabled: false } }, async ($, on) => {
  const { agent, files } = engine(on)
  expect(textOf(await agent($))).toBe(long())
  expect(files.size).toBe(0)
})

test('the options are used', { options: { maxChars: 20000, headChars: 1000, tailChars: 0, exclude: 'reviewer' } }, async ($, on) => {
  const { agent } = engine(on, p => ({ status: 'completed', text: p === 'big' ? long(600) : long() }))
  // 9,000 characters is under 20,000.
  expect(textOf(await agent($))).toBe(long())
  const big = textOf(await agent($, { prompt: 'big' }))
  expect(big).toContain('characters cut here')
  expect(big.endsWith('Read it if you need the part cut out.]')).toBe(true)
  expect(textOf(await agent($, { prompt: 'big', subagent_type: 'reviewer' }))).toBe(long(600))
  expect(textOf(await agent($, { prompt: 'big', subagent_type: 'Explore' }))).toContain('characters cut here')
})
