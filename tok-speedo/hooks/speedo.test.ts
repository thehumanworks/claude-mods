import { expect, test } from 'claude-code/testing'

import { empty, line, record, report } from './speedo'

test('status line shows only tok/s speed and short model name', async () => {
  expect(line('claude-opus-5-5', 42.34)).toBe('⚡ 42.3 tok/s  opus-5-5')
  expect(line('claude-haiku-5-5-20251001', 130.4)).toBe('⚡ 130 tok/s  haiku-5-5')
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

  s = record(s, 20)
  const down = report({ byModel: { 'claude-opus-5-5': s } })
  expect(down).toContain('last 20.0 (▼67%), avg 60.0 tok/s (5 turns), best 130.0')
})
