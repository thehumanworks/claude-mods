import { expect, test } from 'claude-code/testing'
import { crossedBand, limitOf, note, parseBands, short, statusLine } from '../hooks/gauge.js'
import { compact, compactionRow, engine, prompt, toolCall } from './helpers.js'

// The engine of these tests compacts at 160k: the bands 50, 75 and 90 sit at 80k, 120k and 144k.

test('the bands option is parsed, and what cannot be used is reported', async () => {
  expect(parseBands(undefined)).toEqual({ bands: [50, 75, 90], problems: [] })
  expect(parseBands('')).toEqual({ bands: [50, 75, 90], problems: [] })
  expect(parseBands('90, 60,60 30%')).toEqual({ bands: [30, 60, 90], problems: [] })
  expect(parseBands(80)).toEqual({ bands: [80], problems: [] })
  expect(parseBands([70, '85'])).toEqual({ bands: [70, 85], problems: [] })
  expect(parseBands('off').bands).toEqual([])
  expect(parseBands('None').bands).toEqual([])

  const some = parseBands('50, 100, 0, 7.5, lots')
  expect(some.bands).toEqual([50])
  expect(some.problems.length).toBe(4)
  expect(some.problems[0]).toContain('"100" is not a whole percentage from 1 to 99')

  const none = parseBands('120')
  expect(none.bands).toEqual([50, 75, 90])
  expect(none.problems.at(-1)).toContain('nothing usable; using 50, 75, 90')
})

test('a bad bands option is logged once at start and the rest still works', { options: { bands: '60, 200' } }, async ($, on) => {
  const world = { tokens: 100_000 }
  const { seen } = engine(on, world)
  await $.session.start({ cwd: '/work' } as never)
  expect(seen.logs).toEqual(['context-gauge: bands: "200" is not a whole percentage from 1 to 99; left out'])
  const [text] = await prompt($)
  expect(text).toContain('Context past 60%')
})

test('the limit is read as async-compaction reads it', async () => {
  const breakdown = { autoCompactThreshold: 267_000, rawMaxTokens: 300_000, isAutoCompactEnabled: true }
  expect(limitOf({ window: 1_000_000, breakdown })).toEqual({ tokens: 267_000, isAuto: true, window: 300_000 })
  // CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: a share of the threshold plus the engine's buffer, never above the threshold.
  expect(limitOf({ window: 1_000_000, breakdown }, 50).tokens).toBe(140_000)
  expect(limitOf({ window: 1_000_000, breakdown }, 100).tokens).toBe(267_000)
  expect(limitOf({ window: 1_000_000, breakdown }, NaN).tokens).toBe(267_000)
  // Auto-compact off: the window.
  expect(limitOf({ window: 200_000, breakdown: { rawMaxTokens: 180_000, isAutoCompactEnabled: false } })).toEqual({ tokens: 180_000, isAuto: false, window: 180_000 })
})

test('the status line shows used, limit and percent', async () => {
  const limit = { tokens: 267_000, isAuto: true, window: 300_000 }
  expect(statusLine(134_000, limit)).toBe('ctx 134k/267k · 50%')
  expect(statusLine(undefined, limit)).toBe('ctx –/267k')
  expect(statusLine(900, { tokens: 967_000, isAuto: false, window: 1_000_000 })).toBe('ctx 900/967k · 0% · auto-compact off')
  expect(short(1_234_000)).toBe('1.2M')
  expect(short(999_700)).toBe('1M')
})

test('the highest band crossed is the one told, above every band already told', async () => {
  const bands = [50, 75, 90]
  expect(crossedBand(79_999, 160_000, bands, 0)).toBeUndefined()
  expect(crossedBand(80_000, 160_000, bands, 0)).toBe(50)
  expect(crossedBand(150_000, 160_000, bands, 0)).toBe(90)
  expect(crossedBand(130_000, 160_000, bands, 50)).toBe(75)
  expect(crossedBand(130_000, 160_000, bands, 75)).toBeUndefined()
  expect(crossedBand(170_000, 160_000, bands, 90)).toBeUndefined()
})

test('each band has a note with the tokens, the limit and a suggestion of its own', async () => {
  const limit = { tokens: 267_000, isAuto: true, window: 300_000 }
  const half = note(50, 134_000, limit)
  expect(half).toBe(
    '[context-gauge] Context past 50%: 134,000 tokens used of 267,000, where Claude Code compacts automatically. There is room left, but read large files in parts (Grep, line ranges) rather than whole.',
  )
  expect(note(75, 201_000, limit)).toContain('Finish the current step before starting a new one')
  expect(note(90, 241_000, limit)).toContain('Compaction is close: finish or checkpoint the current step now')
  expect(note(90, 170_000, { tokens: 180_000, isAuto: false, window: 180_000 })).toContain(
    'of the 180,000-token window (auto-compact is off). The context window is nearly full',
  )
})

test('below the first band Claude is told nothing, and the status line still shows the fill', async ($, on) => {
  const { seen } = engine(on, { tokens: 79_000 })
  expect(await prompt($)).toEqual([])
  expect(await toolCall($)).toEqual([])
  expect(seen.status.at(-1)).toBe('ctx 79k/160k · 49%')
})

test('crossing a band adds one note to the next request, after a tool result or beside a prompt', async ($, on) => {
  const world = { tokens: 60_000 }
  const { seen } = engine(on, world)
  expect(await toolCall($)).toEqual([])

  world.tokens = 85_000
  const [inTurn, ...more] = await toolCall($)
  expect(more).toEqual([])
  expect(inTurn).toContain('Context past 50%: 85,000 tokens used of 160,000')
  expect(seen.status.at(-1)).toBe('ctx 85k/160k · 53%')

  // The last response of a turn crossed 75: the user's next prompt carries it.
  world.tokens = 125_000
  const [beside] = await prompt($)
  expect(beside).toContain('Context past 75%: 125,000 tokens used')
})

test('several bands crossed in one step give one note, for the highest', async ($, on) => {
  const world = { tokens: 10_000 }
  engine(on, world)
  await prompt($)
  world.tokens = 150_000
  const context = await toolCall($)
  expect(context.length).toBe(1)
  expect(context[0]).toContain('Context past 90%')
  // 50 and 75 are passed with it, never told after.
  world.tokens = 151_000
  expect(await toolCall($)).toEqual([])
  expect(await prompt($)).toEqual([])
})

test('a band is told once: no repeat at later steps, prompts or parallel calls', async ($, on) => {
  const world = { tokens: 90_000 }
  engine(on, world)
  const first = await Promise.all([toolCall($), toolCall($), toolCall($)])
  expect(first.flat().length).toBe(1)
  world.tokens = 100_000
  expect(await toolCall($)).toEqual([])
  expect(await prompt($)).toEqual([])
  world.tokens = 95_000
  expect(await prompt($)).toEqual([])
})

test('after a compaction the bands start over', async ($, on) => {
  const world: { tokens?: number } = { tokens: 130_000 }
  const { seen } = engine(on, world)
  expect((await prompt($))[0]).toContain('75%')

  await compact($)
  world.tokens = undefined
  await $.session.measure({ context: { window: 200_000 }, rateLimits: [], changed: ['context'] } as never)
  expect(seen.status.at(-1)).toBe('ctx –/160k')
  expect(await prompt($)).toEqual([])

  world.tokens = 82_000
  expect((await toolCall($))[0]).toContain('Context past 50%')
  world.tokens = 130_000
  expect((await toolCall($))[0]).toContain('Context past 75%')
})

test('a compaction another mod answers resets too, through the row Claude Code appends', async ($, on) => {
  const world = { tokens: 130_000 }
  engine(on, world)
  expect((await prompt($))[0]).toContain('75%')
  expect(await prompt($)).toEqual([])
  await compactionRow($)
  expect((await prompt($))[0]).toContain('75%')
})

test('a summary written ahead of time, or a skipped compaction, resets nothing', async ($, on) => {
  const world = { tokens: 130_000, isCompactSkipped: false }
  engine(on, world)
  await prompt($)
  await compact($, 'precompute')
  expect(await prompt($)).toEqual([])
  world.isCompactSkipped = true
  await compact($, 'manual')
  expect(await prompt($)).toEqual([])
})

test('the limit is read at each use, so an /autocompact change applies at once', async ($, on) => {
  const world = { tokens: 100_000, limit: 300_000 }
  const { seen } = engine(on, world)
  expect(await prompt($)).toEqual([]) // 33%
  expect(seen.status.at(-1)).toBe('ctx 100k/300k · 33%')

  world.limit = 160_000
  expect((await prompt($))[0]).toContain('Context past 50%: 100,000 tokens used of 160,000')
  expect(seen.status.at(-1)).toBe('ctx 100k/160k · 62%')
})

test('subagents are skipped: their tool calls carry no note and use no band', async ($, on) => {
  const world = { tokens: 130_000 }
  engine(on, world)
  expect(await toolCall($, 'agent-1')).toEqual([])
  expect((await toolCall($))[0]).toContain('Context past 75%')
})

test('a new session starts the bands over', async ($, on) => {
  const world = { tokens: 130_000, sessionId: 'a' }
  engine(on, world)
  expect((await prompt($)).length).toBe(1)
  world.sessionId = 'b'
  expect((await prompt($)).length).toBe(1)
})

test('bands off: the status line only', { options: { bands: 'off' } }, async ($, on) => {
  const { seen } = engine(on, { tokens: 150_000 })
  expect(await prompt($)).toEqual([])
  expect(await toolCall($)).toEqual([])
  expect(seen.status.at(-1)).toBe('ctx 150k/160k · 93%')
})
