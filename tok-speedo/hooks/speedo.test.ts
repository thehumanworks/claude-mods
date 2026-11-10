import { expect, test } from 'claude-code/testing'

import { empty, line, record } from './speedo'

test('per-model average, gauge and diff arrow', async () => {
  let s = empty()
  for (const r of [50, 50, 50]) s = record(s, r)
  expect(s.mean).toBe(50)
  expect(line('claude-opus-5-5', 50, s)).toContain('━━━━━━◉━━━━━━')

  s = record(s, 130)
  const up = line('claude-opus-5-5', 130, s)
  expect(up).toContain('▲86%  avg 70')
  expect(up).not.toContain('trending')

  s = record(s, 20)
  expect(line('claude-opus-5-5', 20, s)).toContain('▼67%  avg 60')
})

test('a first turn sits at its own average', async () => {
  const out = line('claude-haiku-5-5', 42, record(empty(), 42))
  expect(out).toContain('±0%  avg 42')
})
