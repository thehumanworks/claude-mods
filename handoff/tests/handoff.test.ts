import type { Register } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { CAPS, commandText, contextFor, emptyWork, MAX_INPUT_CHARS, MAX_NOTE_CHARS, mergeWork, parseNote, questionText, readNotes, resolveConfig, withNote } from '../hooks/note.js'
import { engine, fiveReads } from './helpers.js'

const ROOT = '/work/app'
const NOTE = 'Work: the parser.\nDone: fixed a bug.\nNext: tests.\nOpen problems: none'

test('settings: the defaults, and a value out of range keeps its default', async () => {
  const { config, problems } = resolveConfig({})
  expect(config).toEqual({ enabled: true, model: 'claude-haiku-5-5', minTools: 5, minSecondsBetween: 120, timeoutSeconds: 15 })
  expect(problems).toEqual([])
  const bad = resolveConfig({ model: ' haiku ', minTools: 0, minSecondsBetween: '30', timeoutSeconds: 600 })
  expect(bad.config.model).toBe('haiku')
  expect(bad.config.minTools).toBe(5)
  expect(bad.config.minSecondsBetween).toBe(30)
  expect(bad.config.timeoutSeconds).toBe(15)
  expect(bad.problems.length).toBe(2)
})

test('the question is capped part by part, and the total is bounded', async () => {
  const huge = 'x'.repeat(50_000)
  const work = { ...emptyWork(), prompts: [huge], edited: Array.from({ length: 100 }, (_, i) => `/r/${'d'.repeat(40)}/${i}.ts`), commands: Array.from({ length: 30 }, () => 'y'.repeat(200)), tools: 99, answer: huge }
  const text = questionText(ROOT, huge, work)
  expect(text.length).toBeLessThanOrEqual(MAX_INPUT_CHARS)
  expect(text).toContain('Previous note:\n' + 'x'.repeat(CAPS.previous - 1) + '…')
  // The latest of a list is kept: the last edited path is there.
  expect(text).toContain('/99.ts')
  expect(questionText(ROOT, undefined, emptyWork())).toContain('Previous note:\n(none)')
})

test('the reply is read as a note: trimmed, unfenced, capped', async () => {
  expect(parseNote('  \n')).toBeUndefined()
  expect(parseNote('```\nWork: x\n```')).toBe('Work: x')
  expect(parseNote(` ${NOTE} `)).toBe(NOTE)
  expect(parseNote('z'.repeat(5_000))!.length).toBe(MAX_NOTE_CHARS)
})

test('notes per repository: the oldest goes past the cap, and junk is dropped', async () => {
  let notes = readNotes({ bad: { note: 1 }, '/a': { note: 'A', writtenAt: 1, model: 'm', sessionId: 's' } })
  expect(Object.keys(notes)).toEqual(['/a'])
  notes = withNote(notes, '/b', { note: 'B', writtenAt: 2, model: 'm', sessionId: 's' }, 2)
  notes = withNote(notes, '/c', { note: 'C', writtenAt: 3, model: 'm', sessionId: 's' }, 2)
  expect(Object.keys(notes).sort()).toEqual(['/b', '/c'])
  // Rewriting a kept one makes it the newest.
  notes = withNote(notes, '/b', { note: 'B2', writtenAt: 4, model: 'm', sessionId: 's' }, 2)
  notes = withNote(notes, '/d', { note: 'D', writtenAt: 5, model: 'm', sessionId: 's' }, 2)
  expect(Object.keys(notes).sort()).toEqual(['/b', '/d'])
  expect(readNotes('nonsense')).toEqual({})
})

test('work merges with the latest kept', async () => {
  const a = { ...emptyWork(), prompts: ['p1', 'p2'], edited: ['/x'], tools: 2, answer: 'first', turns: 1 }
  const b = { ...emptyWork(), prompts: ['p3', 'p4'], edited: ['/x', '/y'], tools: 3, answer: '', turns: 1 }
  expect(mergeWork(a, b)).toEqual({ prompts: ['p2', 'p3', 'p4'], edited: ['/x', '/y'], commands: [], tools: 5, answer: 'first', turns: 2 })
})

test('an edit makes a note due: one call after the turn, stored under the git root', async ($, on) => {
  const h = engine(on, { gitRoot: ROOT })
  await h.turn($, 'Fix the parser bug', async () => {
    await h.edit($, '/work/app/src/parser.ts')
    await h.bash($, 'npm test')
  }, 'Fixed the off-by-one; tests pass.')
  expect(h.seen.asked.length).toBe(1)
  const asked = h.seen.asked[0]!
  expect(asked.model).toBe('claude-haiku-5-5')
  expect(asked.timeoutMs).toBe(15_000)
  expect(asked.maxTokens).toBe(600)
  expect(asked.prompt).toContain('Fix the parser bug')
  expect(asked.prompt).toContain('/work/app/src/parser.ts')
  expect(asked.prompt).toContain('npm test')
  expect(asked.prompt).toContain('Fixed the off-by-one; tests pass.')
  const notes = await h.notes($)
  expect(Object.keys(notes)).toEqual([ROOT])
  expect(notes[ROOT]!.note).toBe(NOTE)
})

test('outside a git repository the working directory is the root', async ($, on) => {
  const h = engine(on, { cwd: '/tmp/scratch' })
  await h.turn($, 'Write a script', () => h.edit($, '/tmp/scratch/a.sh'))
  expect(Object.keys(await h.notes($))).toEqual(['/tmp/scratch'])
})

test('no edit: a note only from the tool-call threshold up', async ($, on) => {
  const h = engine(on, { gitRoot: ROOT })
  await h.turn($, 'Look around', async () => {
    for (let i = 0; i < 4; i++) await h.read($, `/work/app/f${i}`)
  })
  expect(h.seen.asked.length).toBe(0)
  await h.turn($, 'Look further', fiveReads(h, $))
  expect(h.seen.asked.length).toBe(1)
  // The turn below the threshold went in too.
  expect(h.seen.asked[0]!.prompt).toContain('Look around')
  expect(h.seen.asked[0]!.prompt).toContain('(9 tool calls in all)')
})

test('the threshold is a setting', { options: { minTools: 2 } }, async ($, on) => {
  const h = engine(on, { gitRoot: ROOT })
  await h.turn($, 'Look', async () => {
    await h.read($, '/a')
    await h.read($, '/b')
  })
  expect(h.seen.asked.length).toBe(1)
})

test("a subagent's work and a refused edit do not count", async ($, on) => {
  const h = engine(on, { gitRoot: ROOT })
  await h.turn($, 'Delegate', async () => {
    await h.edit($, '/work/app/a.ts', { agentId: 'a1' })
    await h.edit($, '/work/app/b.ts', { fail: true })
  })
  expect(h.seen.asked.length).toBe(0)
  // A subagent's own turn end never writes either.
  await h.turn($, 'sub', () => h.edit($, '/work/app/d.ts', { agentId: 'a1' }), 'report', 'a1')
  expect(h.seen.asked.length).toBe(0)
})

test('debounced: one call per window, the skipped turns go into the next', async ($, on) => {
  const h = engine(on, { gitRoot: ROOT })
  await h.turn($, 'First change', () => h.edit($, '/work/app/one.ts'))
  expect(h.seen.asked.length).toBe(1)
  await h.clock.advance(30_000)
  await h.turn($, 'Second change', () => h.edit($, '/work/app/two.ts'))
  await h.turn($, 'Third change', () => h.edit($, '/work/app/three.ts'))
  expect(h.seen.asked.length).toBe(1)
  // Once the window has passed the waiting work is written, in one call.
  await h.clock.advance(89_000)
  expect(h.seen.asked.length).toBe(1)
  await h.clock.advance(1_000)
  expect(h.seen.asked.length).toBe(2)
  const second = h.seen.asked[1]!.prompt
  expect(second).toContain('Second change')
  expect(second).toContain('Third change')
  expect(second).toContain('/work/app/two.ts')
  expect(second).toContain('/work/app/three.ts')
  expect(second).not.toContain('one.ts')
  // The previous note is part of the question.
  expect(second).toContain(`Previous note:\n${NOTE}`)
  // Nothing more is due: no further call.
  await h.clock.advance(600_000)
  expect(h.seen.asked.length).toBe(2)
})

test('the debounce window is a setting', { options: { minSecondsBetween: 0 } }, async ($, on) => {
  const h = engine(on, { gitRoot: ROOT })
  await h.turn($, 'One', () => h.edit($, '/work/app/one.ts'))
  await h.turn($, 'Two', () => h.edit($, '/work/app/two.ts'))
  expect(h.seen.asked.length).toBe(2)
})

test('the call runs off the turn: the turn ends at once while the model is still writing', async ($, on) => {
  const h = engine(on, { gitRoot: ROOT, delayMs: 10_000 })
  const turnId = 't-slow'
  await $.turn.start({ text: 'Change', turnId } as never)
  await h.edit($, '/work/app/a.ts')
  const before = h.clock.now()
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId, reason: 'answer' } as never)
  // turn.complete resolved without the clock moving: nothing waited on the model.
  expect(h.clock.now()).toBe(before)
  await h.clock.settle()
  expect(h.seen.asked.length).toBe(1)
  expect(await h.notes($)).toEqual({})
  // A turn that counts while the call runs is held for the next window.
  await h.turn($, 'More', () => h.edit($, '/work/app/b.ts'))
  expect(h.seen.asked.length).toBe(1)
  await h.clock.advance(10_000)
  expect((await h.notes($))[ROOT]).toBeDefined()
  await h.clock.advance(110_000)
  expect(h.seen.asked.length).toBe(2)
  expect(h.seen.asked[1]!.prompt).toContain('/work/app/b.ts')
})

for (const failure of [{ fail: 'aborted' }, { fail: 'api-error' }, { fail: 'empty-reply' }, 'throw', '   '] as const) {
  test(`model failure (${typeof failure === 'string' ? JSON.stringify(failure) : failure.fail}): the old note stays, and the work goes into the next`, async ($, on) => {
    const old = { note: 'OLD NOTE', writtenAt: 1_600_000_000_000, model: 'claude-haiku-5-5', sessionId: 'earlier' }
    const h = engine(on, { gitRoot: ROOT, store: { notes: { [ROOT]: old } }, answer: n => (n === 0 ? failure : NOTE) })
    await h.turn($, 'Change A', () => h.edit($, '/work/app/a.ts'))
    expect(h.seen.asked.length).toBe(1)
    expect((await h.notes($))[ROOT]).toEqual(old)
    expect(await h.command($)).toContain('The last attempt to update it failed')
    // Never retried on its own.
    await h.clock.advance(600_000)
    expect(h.seen.asked.length).toBe(1)
    await h.turn($, 'Change B', () => h.edit($, '/work/app/b.ts'))
    expect(h.seen.asked.length).toBe(2)
    expect(h.seen.asked[1]!.prompt).toContain('/work/app/a.ts')
    expect(h.seen.asked[1]!.prompt).toContain('/work/app/b.ts')
    expect(h.seen.asked[1]!.prompt).toContain('OLD NOTE')
    expect((await h.notes($))[ROOT]!.note).toBe(NOTE)
    expect(await h.command($)).not.toContain('failed')
  })
}

test('the model and timeout settings are used', { options: { model: 'haiku', timeoutSeconds: 3 } }, async ($, on) => {
  const h = engine(on, { gitRoot: ROOT })
  await h.turn($, 'Change', () => h.edit($, '/work/app/a.ts'))
  expect(h.seen.asked[0]!.model).toBe('haiku')
  expect(h.seen.asked[0]!.timeoutMs).toBe(3_000)
  expect((await h.notes($))[ROOT]!.model).toBe('haiku')
})

test('session end: the work the debounce held is written once', async ($, on) => {
  const h = engine(on, { gitRoot: ROOT })
  await h.turn($, 'First', () => h.edit($, '/work/app/one.ts'))
  await h.turn($, 'Second', () => h.edit($, '/work/app/two.ts'))
  expect(h.seen.asked.length).toBe(1)
  await h.end($)
  expect(h.seen.asked.length).toBe(2)
  expect(h.seen.asked[1]!.prompt).toContain('/work/app/two.ts')
  // The debounce's own call was cancelled with the session.
  await h.clock.advance(600_000)
  expect(h.seen.asked.length).toBe(2)
})

test('session end with nothing new writes nothing', async ($, on) => {
  const h = engine(on, { gitRoot: ROOT })
  await h.end($)
  expect(h.seen.asked.length).toBe(0)
  await h.turn($, 'First', () => h.edit($, '/work/app/one.ts'))
  await h.end($)
  expect(h.seen.asked.length).toBe(1)
})

test('session end after work below the per-turn threshold still writes when it adds up', async ($, on) => {
  const h = engine(on, { gitRoot: ROOT })
  for (const name of ['a', 'b']) {
    await h.turn($, `Look at ${name}`, async () => {
      for (let i = 0; i < 3; i++) await h.read($, `/work/app/${name}${i}`)
    })
  }
  expect(h.seen.asked.length).toBe(0)
  await h.end($)
  expect(h.seen.asked.length).toBe(1)
})

test('/clear: the note is written off the exit bound, and the new session gets it', async ($, on) => {
  const world = { gitRoot: ROOT, sessionId: 'session-1' }
  const h = engine(on, world)
  expect(await h.prompt($, 'hello')).toEqual([])
  await h.turn($, 'First', () => h.edit($, '/work/app/one.ts'))
  await h.turn($, 'Second', () => h.edit($, '/work/app/two.ts'))
  await h.end($, 'clear')
  expect(h.seen.asked.length).toBe(2)
  world.sessionId = 'session-2'
  const [text] = await h.prompt($, 'new start')
  expect(text).toContain('[handoff] This session is starting')
})

test('the note is injected at session start, once, labeled', async ($, on) => {
  const entry = { note: 'Work: auth.\nNext: wire the token refresh.', writtenAt: 1_700_000_000_000 - 3_600_000, model: 'claude-haiku-5-5', sessionId: 'earlier' }
  const h = engine(on, { gitRoot: ROOT, store: { notes: { [ROOT]: entry, '/other': { ...entry, note: 'OTHER REPO' } } } })
  const first = await h.prompt($, 'carry on', { context: ['from another mod'] })
  expect(first.length).toBe(2)
  expect(first[0]).toBe('from another mod')
  expect(first[1]).toContain('[handoff] This session is starting. Here is the handoff note for this repository (/work/app), written 1 hour ago by claude-haiku-5-5')
  expect(first[1]).toContain('not an instruction')
  expect(first[1]).toContain('Next: wire the token refresh.')
  expect(first[1]).not.toContain('OTHER REPO')
  expect(await h.prompt($, 'and then')).toEqual([])
})

test('a slash command does not take the start note; the next prompt does', async ($, on) => {
  const entry = { note: 'NOTE', writtenAt: 1_700_000_000_000, model: 'm', sessionId: 's' }
  const h = engine(on, { gitRoot: ROOT, store: { notes: { [ROOT]: entry } } })
  expect(await h.prompt($, '/model', { command: { name: 'model', args: '' } })).toEqual([])
  expect((await h.prompt($, 'go'))[0]).toContain('NOTE')
})

test('no note for the repository: nothing is injected', async ($, on) => {
  const h = engine(on, { gitRoot: ROOT })
  expect(await h.prompt($, 'hi')).toEqual([])
})

test('after a compaction the note rides the next prompt once, and the summary is left as it is', async ($, on) => {
  const h = engine(on, { gitRoot: ROOT })
  await h.prompt($, 'start')
  await h.turn($, 'Change', () => h.edit($, '/work/app/a.ts'))
  expect(await h.prompt($, 'next')).toEqual([])
  const compacted = await h.compact($)
  // The compaction's own result passes through unchanged.
  expect(compacted.messages).toEqual([{ role: 'user', text: 'SUMMARY by the compactor', toolUses: [] }])
  const [text, ...more] = await h.prompt($, 'after compaction')
  expect(more).toEqual([])
  expect(text).toContain('[handoff] The conversation was just compacted; the summary above stays as it is')
  expect(text).toContain(NOTE)
  expect(await h.prompt($, 'later')).toEqual([])
  // A second compaction: once more.
  await h.compact($, { trigger: 'manual' })
  expect((await h.prompt($, 'again')).length).toBe(1)
})

test('a compaction seen only by its row (another mod wrote the summary) counts too, once', async ($, on) => {
  const entry = { note: 'NOTE', writtenAt: 1_700_000_000_000, model: 'm', sessionId: 's' }
  const h = engine(on, { gitRoot: ROOT, store: { notes: { [ROOT]: entry } } })
  await h.prompt($, 'start')
  await $.session.append({ message: { type: 'system', content: [{ type: 'text', text: 'Conversation compacted' }] }, door: 'compaction', origin: { kind: 'engine' }, uuid: 'row-1' } as never)
  await $.classic.SessionStart({ source: 'compact' } as never)
  expect((await h.prompt($, 'after')).length).toBe(1)
  expect(await h.prompt($, 'later')).toEqual([])
})

test("a precompute, a skipped compaction or a subagent's compaction does not count", async ($, on) => {
  const entry = { note: 'NOTE', writtenAt: 1_700_000_000_000, model: 'm', sessionId: 's' }
  const h = engine(on, { gitRoot: ROOT, store: { notes: { [ROOT]: entry } }, skipTrigger: 'manual' })
  await h.prompt($, 'start')
  await h.compact($, { trigger: 'precompute' })
  await h.compact($, { trigger: 'manual' })
  await h.compact($, { agentId: 'a1' })
  expect(await h.prompt($, 'after')).toEqual([])
})

test('/handoff shows the note and when it was written', async ($, on) => {
  const h = engine(on, { gitRoot: ROOT })
  await $.session.start({ cwd: '/work/app/src', surface: 'terminal', isInteractive: true } as never)
  expect(h.seen.registered).toEqual(['handoff'])
  expect(await h.command($)).toBe('No handoff note for /work/app yet. claude-haiku-5-5 writes one after a turn that edits a file or makes 5 or more tool calls.')
  await h.turn($, 'Change', () => h.edit($, '/work/app/a.ts'))
  await h.clock.advance(5 * 60_000)
  const text = await h.command($)
  expect(text).toContain('Handoff note for /work/app, written 5 minutes ago (2023-11-14 22:13:20 UTC) by claude-haiku-5-5:')
  expect(text).toContain(NOTE)
})

test('the texts read as they should', async () => {
  const entry = { note: 'N', writtenAt: 0, model: '', sessionId: '' }
  expect(contextFor('/r', entry, 90_000, 'start')).toContain('written 2 minutes ago by a small model')
  expect(commandText('/r', undefined, 0, resolveConfig({}).config, 'boom')).toContain('failed (boom)')
})

test('off: nothing is written, injected or registered', { options: { enabled: false } }, async ($, on) => {
  const entry = { note: 'NOTE', writtenAt: 1_700_000_000_000, model: 'm', sessionId: 's' }
  const h = engine(on, { gitRoot: ROOT, store: { notes: { [ROOT]: entry } } })
  await $.session.start({ cwd: '/work/app/src', surface: 'terminal', isInteractive: true } as never)
  expect(h.seen.registered).toEqual([])
  expect(await h.prompt($, 'hi')).toEqual([])
  await h.turn($, 'Change', () => h.edit($, '/work/app/a.ts'))
  await h.compact($)
  expect(await h.prompt($, 'after')).toEqual([])
  await h.end($)
  expect(h.seen.asked.length).toBe(0)
})

/** A mod of its own that edits files when a turn starts, as another plugin may. */
const editor: { name: string; register: Register } = {
  name: 'editor',
  register: on => {
    on('turn.start', async ($, e, next) => {
      const started = await next(e)
      for (let i = 0; i < 6; i++) await $.tool.call({ tool: 'Edit', file_path: `/work/app/x${i}.ts`, old_string: 'a', new_string: 'b', tool_use_id: `toolu_plugin_${i}` } as never)
      return started
    })
  },
}

test("a plugin's own tool calls do not count", { plugins: [editor] }, async ($, on) => {
  const h = engine(on, { gitRoot: ROOT })
  await h.turn($, 'Change nothing')
  expect(h.seen.asked.length).toBe(0)
})
