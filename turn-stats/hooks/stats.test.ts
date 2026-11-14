import { expect, test } from 'claude-code/testing'

import { empty, record, report, summary } from './stats'

test('summary line shows tps, tokens, cache hit percentages, total and duration', async () => {
  const u = {
    output_tokens: 9319,
    input_tokens: 48163,
    cache_read_input_tokens: 660096,
    cache_creation_input_tokens: 0,
  }
  expect(summary(33.42, u, 278_900)).toBe(
    'TPS 33.4 tok/s, out 9,319, in 48,163, cache r/w 93.2%/0.0%, total 717,578, 278.9s',
  )
  expect(summary(undefined, { ...u, cache_read_input_tokens: 0 }, 1000)).toBe(
    'TPS –, out 9,319, in 48,163, cache r/w 0.0%/0.0%, total 57,482, 1.0s',
  )
})

test('report summarizes last diff, average, best and recent trend per model', async () => {
  expect(report({ byModel: {} })).toBe('No turns measured yet.')

  let s = empty()
  for (const r of [50, 50, 50]) s = record(s, r)
  expect(s.mean).toBe(50)

  s = record(s, 130)
  const up = report({ byModel: { 'claude-opus-5-5': s } })
  expect(up).toContain('opus-5-5: last 130.0 (▲86%), avg 70.0 tok/s (4 turns), best 130.0')
  expect(up).toContain('[50, 50, 50, 130]')
})
