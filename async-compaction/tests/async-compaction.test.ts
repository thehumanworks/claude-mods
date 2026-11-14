import type { SessionMessage } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { LEVELS, resolveConfig } from '../hooks/config.js'
import { PART_CHARS, type Prepared } from '../hooks/register.js'
import { isSummaryLike, SUMMARY_MAX_TOKENS } from '../hooks/summary.js'
import { cleanReply } from '../hooks/transcript.js'
import { assistant, calls, compact, conversation, endTurn, engine, parallelReply, recall, result, resume, toolCall, user } from './helpers.js'

// The engine of these tests compacts at 160k, so the default trigger (75%) is 120k.

test('a trigger at or past the auto-compact limit is refused', async () => {
  for (const triggerAt of [100, 120, '100%']) {
    const { config, problems } = resolveConfig({ triggerAt })
    expect(config.triggerAt).toBe(75)
    expect(problems[0]).toContain('must be below the auto-compact limit')
  }
  expect(resolveConfig({ triggerAt: 60 }).config.triggerAt).toBe(60)
  expect(resolveConfig({ triggerAt: '85%' }).config.triggerAt).toBe(85)
  expect(resolveConfig({ triggerAt: 5 }).problems.length).toBe(1)
  expect(resolveConfig({ level: 'brutal' }).problems.length).toBe(1)
  expect(resolveConfig({}).config).toEqual({ enabled: true, model: 'haiku', triggerAt: 75, level: 'balanced', prompt: '', recall: true })
})

test('below the trigger nothing is summarized', async ($, on) => {
  const { seen, clock } = engine(on, { tokens: 119_000, messages: conversation(119) })
  await endTurn($, clock)
  await toolCall($, clock)
  expect(seen.completions.length).toBe(0)
})

test('at the trigger the compaction model summarizes the conversation so far in the background', async ($, on) => {
  const { seen, clock } = engine(on, { tokens: 120_000, messages: conversation(120) })
  await endTurn($, clock)

  expect(seen.completions.length).toBe(1)
  const request = seen.completions[0]!
  expect(request.model).toBe('haiku')
  expect(request.effort).toBe('low')
  expect(request.system).toContain('at most 1200 words')
  expect(request.system).toContain('like [m412]')
  // Nothing is said of an earlier summary when there is none: told of one, the model writes about it.
  expect(request.system).not.toContain('earlier_summary')
  expect(request.prompt).toContain('[m0] USER: turn 1:')
  expect(request.prompt).toContain('[m239] ASSISTANT: reply 120:')
  const prepared = seen.store.get('prepared:session-1') as Prepared
  expect(prepared.cut).toBe(240)
  expect(prepared.summary).toContain('SUMMARY 1 [m0]')

  // One summary per cycle: later turns and tool calls start no other.
  await endTurn($, clock)
  await clock.advance(60_000)
  await toolCall($, clock)
  expect(seen.completions.length).toBe(1)
})

test('at the limit the ready summary is swapped in and what came after the trigger stays raw', async ($, on) => {
  const world = { tokens: 120_000, messages: conversation(120) }
  const { seen, clock } = engine(on, world)
  await endTurn($, clock)
  await clock.advance(300_000)

  const later = conversation(40, 121)
  world.messages = [...world.messages, ...later]
  world.tokens = 160_000
  const compacted = await compact($, world.messages)

  expect(seen.completions.length).toBe(1) // no model call at compaction
  expect(seen.core.length).toBe(0)
  const messages = compacted.messages!
  expect(messages.length).toBe(1 + later.length)
  expect(messages[0]!.text).toContain('This session is being continued from a previous conversation')
  expect(messages[0]!.text).toContain('SUMMARY 1 [m0]')
  expect(messages[0]!.text).toContain('mcp__async-compaction__recall')
  expect(messages[0]!.text).toContain('kept verbatim')
  expect(messages[0]!.handle).toBeUndefined()
  expect(messages[1]!.text).toContain('turn 121:')
  expect(messages[1]!.handle).toBe('h240')
  expect(messages.at(-1)!.text).toContain('reply 160:')
  expect(seen.toasts.join('\n')).toContain('5m ago')
  expect(seen.store.has('prepared:session-1')).toBe(false)
})

test('inside one long turn the summary starts at a tool call, and no tool result is kept without its call', async ($, on) => {
  // One prompt, then tool calls only: the last call is still waiting for its result.
  const steps = Array.from({ length: 60 }, (_, i) => [calls('Bash', { command: `step ${i}` }, `tu${i}`), result('x'.repeat(8000), `tu${i}`)]).flat()
  const world = { tokens: 121_000, messages: [user('do the whole migration'), ...steps, calls('Bash', { command: 'in flight' }, 'tu-in-flight')] }
  const { seen, clock } = engine(on, world)
  await toolCall($, clock)

  expect(seen.completions.length).toBe(1)
  const prepared = seen.store.get('prepared:session-1') as Prepared
  // The call in flight is left out of the summary: the cut falls before it.
  expect(prepared.cut).toBe(world.messages.length - 1)
  expect(seen.completions[0]!.prompt).not.toContain('in flight')

  world.messages = [...world.messages, result('done', 'tu-in-flight'), calls('Bash', { command: 'next' }, 'tu-next'), result('ok', 'tu-next')]
  const compacted = await compact($, world.messages)
  const kept = compacted.messages!.slice(1)
  expect(kept[0]!.role).toBe('assistant')
  expect(kept[0]!.toolUses[0]!.tool_use_id).toBe('tu-in-flight')
  expect(kept[1]!.toolResults![0]!.tool_use_id).toBe('tu-in-flight')
  // Every kept tool result follows the call it answers.
  const called = new Set<string>()
  for (const m of kept) {
    for (const use of m.toolUses) called.add(use.tool_use_id)
    for (const r of m.toolResults ?? []) expect(called.has(r.tool_use_id)).toBe(true)
  }
})

test('tool calls inside a turn measure the context at most every ten seconds, and a subagent never does', async ($, on) => {
  const world = { tokens: 100_000, messages: conversation(100) }
  const { seen, clock } = engine(on, world)
  await toolCall($, clock)
  world.tokens = 125_000
  await toolCall($, clock)
  expect(seen.completions.length).toBe(0)
  await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'a1' } as never)
  await clock.advance(11_000)
  expect(seen.completions.length).toBe(0)
  await toolCall($, clock)
  expect(seen.completions.length).toBe(1)
})

test('a conversation larger than one request holds is summarized in parts and merged', async ($, on) => {
  // About 1.8M characters of conversation, as a 1M-token window can hold at its trigger.
  const big = Array.from({ length: 600 }, (_, i) => [user(`ask ${i} ${'q'.repeat(1490)}`), assistant(`answer ${i} ${'a'.repeat(1490)}`)]).flat()
  const world = { tokens: 700_000, limit: 900_000, messages: big }
  const { seen, clock } = engine(on, world)
  await endTurn($, clock)

  const parts = Math.ceil(1_810_000 / PART_CHARS)
  expect(seen.completions.length).toBe(parts + 1)
  for (const request of seen.completions.slice(0, parts)) {
    expect(request.prompt.length).toBeLessThan(PART_CHARS + 1_000)
    expect(request.prompt).toContain(`of ${parts} of the earlier conversation`)
  }
  const merge = seen.completions.at(-1)!
  expect(merge.prompt).toContain('<part_summary index="1">')
  expect(merge.prompt).toContain(`<part_summary index="${parts}">`)
  expect((seen.store.get('prepared:session-1') as Prepared).summary).toContain(`SUMMARY ${parts + 1}`)
})

test('a request refused as too long is tried again in smaller parts', async ($, on) => {
  const world = { tokens: 120_000, messages: conversation(120), refusesOver: 200_000 }
  const { seen, clock } = engine(on, world)
  await endTurn($, clock)
  // One request refused, then four parts and their merge.
  expect(seen.completions.length).toBe(1 + Math.ceil(484_000 / (PART_CHARS / 4)) + 1)
  expect((seen.store.get('prepared:session-1') as Prepared).summary).toContain('SUMMARY 6')
})

test('the levels: aggressive is shorter, soft is longer and keeps more raw', async () => {
  expect(LEVELS.aggressive.maxWords).toBeLessThan(LEVELS.balanced.maxWords)
  expect(LEVELS.balanced.maxWords).toBeLessThan(LEVELS.soft.maxWords)
  expect(LEVELS.soft.keepPercent).toBeGreaterThan(LEVELS.balanced.keepPercent)
  expect(LEVELS.aggressive.toolChars).toBeLessThan(LEVELS.soft.toolChars)
})

test('aggressive asks for the short summary', { options: { level: 'aggressive' } }, async ($, on) => {
  const { seen, clock } = engine(on, { tokens: 120_000, messages: conversation(120) })
  await endTurn($, clock)
  expect(seen.completions[0]!.system).toContain(`at most ${LEVELS.aggressive.maxWords} words`)
  expect((seen.store.get('prepared:session-1') as Prepared).cut).toBe(240)
})

test('soft asks for the long summary and keeps 15% of the limit raw before the trigger too', { options: { level: 'soft' } }, async ($, on) => {
  const { seen, clock } = engine(on, { tokens: 120_000, messages: conversation(120) })
  await endTurn($, clock)
  expect(seen.completions[0]!.system).toContain(`at most ${LEVELS.soft.maxWords} words`)
  // 15% of 160k is 24k: the last 24 turns (and the turn the cut falls in) stay raw.
  const cut = (seen.store.get('prepared:session-1') as Prepared).cut
  expect(cut).toBeLessThanOrEqual(240 - 48)
  expect(cut).toBeGreaterThanOrEqual(240 - 52)
})

test('a custom prompt replaces the built-in one and still gets the length limit and the ids', { options: { prompt: 'Summarize as a ship log.' } }, async ($, on) => {
  const { seen, clock } = engine(on, { tokens: 120_000, messages: conversation(120) })
  await endTurn($, clock)
  const { system } = seen.completions[0]!
  expect(system.startsWith('Summarize as a ship log.')).toBe(true)
  expect(system).not.toContain('Write from the assistant')
  expect(system).toContain('at most 1200 words')
  expect(system).toContain('like [m412]')
})

test('a prompt file wins over the prompt setting', { options: { prompt: 'From the setting.', promptFile: '~/compaction.md' } }, async ($, on) => {
  const { seen, clock } = engine(on, { tokens: 120_000, messages: conversation(120), files: { '/home/me/compaction.md': 'From the file.' } })
  await endTurn($, clock)
  expect(seen.completions[0]!.system.startsWith('From the file.')).toBe(true)
})

test('recall reads back what was summarized, word for word', async ($, on) => {
  const tooled = [
    user('find the port'),
    calls('Bash', { command: 'grep -n PORT config/server.env' }),
    result('14:PORT=48213\n15:HOST=0.0.0.0'),
    assistant('The port is set in config/server.env.'),
  ]
  const world = { tokens: 120_000, messages: [...tooled, ...conversation(118)] }
  const { seen, clock } = engine(on, world)
  expect(await recall($, { ref: 'm2' })).toContain('Nothing of this conversation has been compacted yet')

  await endTurn($, clock)
  // Written with the summary, but nothing counts until the summary is swapped in.
  expect([...seen.files.keys()]).toEqual(['/home/me/.claude/async-compaction/session-1/m0-m239.json'])
  expect(await recall($, { ref: 'm2' })).toContain('Nothing of this conversation has been compacted yet')

  world.messages = [...world.messages, ...conversation(2, 500)]
  await compact($, world.messages)

  expect(await recall($, { ref: 'm2' })).toBe('[m2] TOOL RESULT: 14:PORT=48213\n15:HOST=0.0.0.0')
  expect(await recall($, { ref: '[m1]' })).toContain('[m1] ASSISTANT CALLED Bash: {"command":"grep -n PORT config/server.env"}')
  const range = await recall($, { ref: 'm2', around: 1 })
  expect(range).toContain('[m1] ASSISTANT CALLED Bash')
  expect(range).toContain('[m3] ASSISTANT: The port is set')
  expect(await recall($, { ref: 'm0-m1' })).toContain('[m0] USER: find the port')

  const found = await recall($, { query: 'port=48213' })
  expect(found).toContain('1 summarized message matches')
  expect(found).toContain('[m2]')
  expect(await recall($, { query: 'zebra crossing' })).toContain('No summarized message holds all of')

  // The turns after the trigger were kept raw: they are not in the archive.
  expect(await recall($, { ref: 'm240' })).toContain('still in your context')
  expect(await recall($, { ref: 'nonsense' })).toContain('is not a message id')
  expect(await recall($, {})).toContain('Give ref')
})

test('a long recall answer is read on with offset', async ($, on) => {
  const world = { tokens: 120_000, messages: [user('start'), calls('Bash', { command: 'cat big.log' }), result(`HEAD ${'z'.repeat(40_000)} TAIL`), ...conversation(120)] }
  const { clock } = engine(on, world)
  await endTurn($, clock)
  await compact($, world.messages)
  const first = await recall($, { ref: 'm2' })
  expect(first).toContain('HEAD')
  expect(first).not.toContain('TAIL')
  const offset = Number(/offset: (\d+)\]/.exec(first)![1])
  let rest = await recall($, { ref: 'm2', offset })
  while (/offset: (\d+)\]/.test(rest)) rest = await recall($, { ref: 'm2', offset: Number(/offset: (\d+)\]/.exec(rest)![1]) })
  expect(rest).toContain('TAIL')
})

test('ids the compaction model made up are dropped from the summary', async ($, on) => {
  const world = { tokens: 120_000, messages: conversation(120), answer: () => 'The port is 48213 [m3][m99999]. Done [m240].' }
  const { seen, clock } = engine(on, world)
  await endTurn($, clock)
  expect((seen.store.get('prepared:session-1') as Prepared).summary).toContain('The port is 48213 [m3]. Done.')
})

test('the next compaction folds the earlier summary in and its ids carry on', async ($, on) => {
  const world = { tokens: 120_000, messages: conversation(120) }
  const { seen, clock } = engine(on, world)
  await endTurn($, clock)
  world.messages = [...world.messages, ...conversation(40, 121)]
  const first = await compact($, world.messages)

  // The conversation now opens with the summary; 320 messages are archived... of which 240 were summarized.
  world.messages = [...first.messages!.map(({ handle, ...m }) => m), ...conversation(80, 161)]
  world.tokens = 121_000
  await clock.advance(60_000)
  await endTurn($, clock)

  expect(seen.completions.length).toBe(2)
  const request = seen.completions[1]!
  expect(request.prompt).toContain('<earlier_summary>\nSUMMARY 1 [m0]')
  expect(request.system).toContain('starts with an <earlier_summary>, fold it in')
  expect(request.system).toContain('keep the ids an <earlier_summary> already has')
  expect(request.prompt).not.toContain('If you need specific details from before compaction')
  // The first kept message takes the id after the last archived one.
  expect(request.prompt).toContain('[m240] USER: turn 121:')
  const second = await compact($, world.messages)
  expect(second.messages!.length).toBe(1)
  expect(await recall($, { ref: 'm240' })).toContain('[m240] USER: turn 121:')
  expect(await recall($, { ref: 'm0' })).toContain('[m0] USER: turn 1:')
  expect(await recall($, { query: 'turn 200:' })).toContain('1 summarized message matches')
})

test("Claude Code's own ahead-of-time compaction is skipped", async ($, on) => {
  const { seen } = engine(on, { tokens: 10_000, messages: conversation(10) })
  const compacted = await compact($, conversation(10), { trigger: 'precompute' })
  expect(compacted.skip).toContain('writes its own summary ahead of time')
  expect(seen.core.length).toBe(0)
  expect(seen.completions.length).toBe(0)
})

test('with nothing ready at the limit, the summary is written then, leaving raw what a timely one would have', async ($, on) => {
  const world = { tokens: 160_000, messages: conversation(160) }
  const { seen } = engine(on, world)
  const compacted = await compact($, world.messages)
  expect(seen.completions.length).toBe(1)
  expect(seen.core.length).toBe(0)
  // 25% of the 160k limit stays raw: 40 turns, give or take the turn the cut falls in.
  const kept = compacted.messages!.length - 1
  expect(kept).toBeGreaterThanOrEqual(80)
  expect(kept).toBeLessThanOrEqual(84)
  expect(compacted.messages![0]!.text).toContain('SUMMARY 1')
})

test('/compact with nothing ready summarizes the whole conversation', async ($, on) => {
  const world = { tokens: 50_000, messages: conversation(50) }
  const { seen } = engine(on, world)
  const compacted = await compact($, world.messages, { trigger: 'manual' })
  expect(seen.completions.length).toBe(1)
  expect(compacted.messages!.length).toBe(1)
  expect(compacted.messages![0]!.text).not.toContain('kept verbatim')
})

test('/compact with instructions writes a summary of its own that stresses them', async ($, on) => {
  const world = { tokens: 120_000, messages: conversation(120) }
  const { seen, clock } = engine(on, world)
  await endTurn($, clock)
  await compact($, world.messages, { trigger: 'manual', instructions: 'the database schema' })
  expect(seen.completions.length).toBe(2)
  expect(seen.completions[1]!.prompt).toContain('focus on: the database schema')
})

test('when the compaction model fails, Claude Code compacts as it always does', async ($, on) => {
  const world = { tokens: 160_000, messages: conversation(160), isFailing: true }
  const { seen } = engine(on, world)
  const compacted = await compact($, world.messages)
  expect(seen.core).toEqual(['auto'])
  expect(compacted.messages![0]!.text).toBe('CORE SUMMARY')
})

const REFUSAL = "I'm sorry, but I can't write that summary. Tell me which part you need and I'll summarise that section for you."

test('a reply that is not a summary is asked for again', async ($, on) => {
  const world = { tokens: 120_000, messages: conversation(120), answer: (_: unknown, n: number) => (n === 1 ? REFUSAL : 'The port is 48213 [m3].') }
  const { seen, clock } = engine(on, world)
  await endTurn($, clock)
  expect(seen.completions.length).toBe(2)
  expect(seen.completions[1]!.prompt).toBe(seen.completions[0]!.prompt)
  expect((seen.store.get('prepared:session-1') as Prepared).summary).toContain('The port is 48213 [m3].')
})

test('when the compaction model will not write a summary, Claude Code compacts as it always does', async ($, on) => {
  // The second reply carries the conversation on in place of summarizing it: it cites nothing.
  const world = { tokens: 160_000, messages: conversation(160), answer: (_: unknown, n: number) => (n === 1 ? REFUSAL : "I'm picking up at the search service. Next, I'll write its config.") }
  const { seen } = engine(on, world)
  const compacted = await compact($, world.messages)
  expect(seen.completions.length).toBe(2)
  expect(seen.core).toEqual(['auto'])
  expect(compacted.messages![0]!.text).toBe('CORE SUMMARY')
})

test('a reply cut off at the token cap is not used', async ($, on) => {
  const world = { tokens: 160_000, messages: conversation(160), outputTokens: SUMMARY_MAX_TOKENS }
  const { seen } = engine(on, world)
  const compacted = await compact($, world.messages)
  expect(seen.completions[0]!.maxTokens).toBe(SUMMARY_MAX_TOKENS)
  expect(seen.core).toEqual(['auto'])
  expect(compacted.messages![0]!.text).toBe('CORE SUMMARY')
})

test('what counts as a summary: one that cites, or without ids one long enough', () => {
  const long = Array.from({ length: 40 }, (_, i) => `[m${i}] USER: ${'lorem '.repeat(900)}`).join('\n')
  const short = '[m0] USER: fix the port\n[m1] ASSISTANT: done, it is 48213'
  const balanced = { refs: true, maxWords: 1200 }
  expect(isSummaryLike('The port is 48213 [m3].', { request: long, ...balanced })).toBe(true)
  expect(isSummaryLike('The port is 48213.', { request: long, ...balanced })).toBe(false)
  expect(isSummaryLike(REFUSAL, { request: long, ...balanced })).toBe(false)
  // A short conversation gets a short summary, with or without ids.
  expect(isSummaryLike('The user asked for the port to be fixed; it is 48213 now.', { request: short, ...balanced })).toBe(true)
  expect(isSummaryLike('Port fixed: 48213.', { request: short, refs: false, maxWords: 1200 })).toBe(true)
  // Without ids a long conversation needs a fifth of the level's length at most.
  const plain = long.replace(/\[m\d+\] /g, '')
  expect(isSummaryLike('The port is 48213.', { request: plain, refs: false, maxWords: 1200 })).toBe(false)
  expect(isSummaryLike('The port is 48213. '.repeat(30), { request: plain, refs: false, maxWords: 500 })).toBe(true)
  expect(isSummaryLike(REFUSAL, { request: short, refs: false, maxWords: 1200 })).toBe(false)
})

test('what the model put around its summary is taken off', async ($, on) => {
  // The input's own tag used as a wrapper, or filled with "none", or remarked on.
  expect(cleanReply('<earlier_summary>\n## Task 1\n- Port is 48213 [m3].\n</earlier_summary>')).toBe('## Task 1\n- Port is 48213 [m3].')
  expect(cleanReply('<earlier_summary>none</earlier_summary>\n\n## Task 1\n- Port is 48213 [m3].')).toBe('## Task 1\n- Port is 48213 [m3].')
  expect(cleanReply('<earlier_summary>\n(No earlier summary.)\n</earlier_summary>\n\n## Task 1')).toBe('## Task 1')
  expect(cleanReply('<earlier_summary> is absent, so this is the first summary. Writing it now.\n\n**Task 1**\n- Port [m3].')).toBe('**Task 1**\n- Port [m3].')
  expect(cleanReply('<earlier_summary>\n## Task 1\n- Port is 48213 [m3].')).toBe('## Task 1\n- Port is 48213 [m3].')
  // The conversation carried on after the summary, in the format it was shown in.
  expect(cleanReply('## Task 1\n- Port [m3].\n</earlier_summary>\n\n[m532] USER: Carry on with search.\n\n[m533] ASSISTANT CALLED Read: {}')).toBe('## Task 1\n- Port [m3].')
  expect(cleanReply('## Task 1\n- Port [m3].\n\n<system-reminder>\nAs you answer the user')).toBe('## Task 1\n- Port [m3].')
  expect(cleanReply('## Task 1\n- The user: wants the port fixed [m3].')).toBe('## Task 1\n- The user: wants the port fixed [m3].')

  const world = { tokens: 120_000, messages: conversation(120), answer: () => '<earlier_summary>none</earlier_summary>\n\nThe port is 48213 [m3].\n\n[m240] USER: turn 121' }
  const { seen, clock } = engine(on, world)
  await endTurn($, clock)
  expect((seen.store.get('prepared:session-1') as Prepared).summary.startsWith('The port is 48213 [m3].\n\n## The user')).toBe(true)
})

// `$.session.messages()`, which the summary is written from, and compaction list one reply's parallel tool calls in different orders.
test('a summary written while tool results stood between the calls they answer is still swapped in', async ($, on) => {
  const replies = (order: 'compact' | 'early' | 'late', from: number, to: number) =>
    Array.from({ length: to - from }, (_, i) => parallelReply(from + i, order === 'compact' ? 'compact' : (from + i) % 2 === 0 ? 'early' : 'late')).flat()
  const prompt = user('work through all forty parts')
  const world = { tokens: 121_000, messages: [prompt, ...replies('early', 0, 40)] }
  const { seen, clock } = engine(on, world)
  await toolCall($, clock)
  const prepared = seen.store.get('prepared:session-1') as Prepared
  expect(prepared.cut).toBe(world.messages.length)

  const later = replies('compact', 40, 50)
  const compacted = await compact($, [prompt, ...replies('compact', 0, 40), ...later])
  expect(seen.completions.length).toBe(1) // no model call at compaction
  const kept = compacted.messages!.slice(1)
  expect(kept.length).toBe(later.length)
  expect(kept[1]!.toolUses[0]!.tool_use_id).toBe('tu40a')
})

test('a reply that ran across the cut of the summary stays raw as a whole', async ($, on) => {
  // The summary starts while the second call of reply 40 is waiting for its result: the first call and its result are summarized.
  const [thinking, a, ra, b, c, rb, rc] = parallelReply(40, 'early') as [SessionMessage, SessionMessage, SessionMessage, SessionMessage, SessionMessage, SessionMessage, SessionMessage]
  const before = (order: 'compact' | 'early') => [user('work through all forty parts'), ...Array.from({ length: 40 }, (_, i) => parallelReply(i, order)).flat()]
  const world = { tokens: 121_000, messages: [...before('early'), thinking, a, ra, b] }
  const { seen, clock } = engine(on, world)
  await toolCall($, clock)
  const prepared = seen.store.get('prepared:session-1') as Prepared
  expect(prepared.cut).toBe(world.messages.length - 1)
  expect(seen.completions[0]!.prompt).toContain('step 40a')

  const compacted = await compact($, [...before('compact'), thinking, a, b, c, ra, rb, rc])
  expect(seen.completions.length).toBe(1)
  const kept = compacted.messages!.slice(1)
  // From the reply's first row on, in the order compaction has them.
  expect(kept.map(m => m.toolUses[0]?.tool_use_id ?? m.toolResults?.[0]?.tool_use_id ?? '')).toEqual(['', 'tu40a', 'tu40b', 'tu40c', 'tu40a', 'tu40b', 'tu40c'])
  expect(kept[0]!.handle).toBe(`h${before('compact').length}`)
})

test('a summary is not used once one of the messages it covers has changed', async ($, on) => {
  const world = { tokens: 120_000, messages: conversation(120) }
  const { seen, clock } = engine(on, world)
  await endTurn($, clock)
  const changed = [...world.messages, ...conversation(10, 121)]
  changed[101] = assistant('another reply altogether')
  const compacted = await compact($, changed)
  expect(seen.completions.length).toBe(2)
  expect(compacted.messages![0]!.text).toContain('SUMMARY 2')
})

test('a summary of a conversation that has since changed is not used', async ($, on) => {
  const world = { tokens: 120_000, messages: conversation(120) }
  const { seen, clock } = engine(on, world)
  await endTurn($, clock)
  // Rewound and gone another way.
  world.messages = conversation(130, 1000)
  const compacted = await compact($, world.messages)
  expect(seen.completions.length).toBe(2)
  expect(compacted.messages![0]!.text).toContain('SUMMARY 2')
})

test('a compaction that comes while the summary is being written waits for it', async ($, on) => {
  const world = { tokens: 120_000, messages: conversation(120), summarySeconds: 5 }
  const { seen, clock } = engine(on, world)
  await endTurn($, clock)
  world.messages = [...world.messages, ...conversation(2, 121)]
  const pending = compact($, world.messages)
  await clock.advance(6_000)
  const compacted = await pending
  expect(seen.completions.length).toBe(1)
  expect(compacted.messages!.length).toBe(1 + 4)
})

test('a summary that takes longer than a compaction can wait is replaced by one written then', async ($, on) => {
  const world = { tokens: 120_000, messages: conversation(120), summarySeconds: 60 }
  const { seen, clock } = engine(on, world)
  await endTurn($, clock)
  const pending = compact($, world.messages)
  await clock.advance(9_000)
  await clock.advance(61_000)
  const compacted = await pending
  expect(seen.completions.length).toBe(2)
  expect(compacted.messages![0]!.text).toContain('SUMMARY 2')
  // The late one is not kept for a conversation it no longer opens.
  await clock.advance(120_000)
  expect(seen.store.has('prepared:session-1')).toBe(false)
})

test('a ready summary is written again once the raw part would outgrow half the limit', { options: { triggerAt: 30 } }, async ($, on) => {
  // The limit is 100k here: the trigger is 30k, and half the limit is 50k.
  const world = { limit: 100_000, tokens: 30_000, messages: conversation(30) }
  const { seen, clock } = engine(on, world)
  await endTurn($, clock)
  expect(seen.completions.length).toBe(1)
  world.tokens = 79_000
  world.messages = conversation(79)
  await endTurn($, clock)
  expect(seen.completions.length).toBe(1)
  world.tokens = 81_000
  world.messages = conversation(81)
  await endTurn($, clock)
  expect(seen.completions.length).toBe(2)
  expect((seen.store.get('prepared:session-1') as Prepared).cut).toBe(162)
})

test('after two summaries that did not finish, the next is left to compaction', async ($, on) => {
  const world = { tokens: 120_000, messages: conversation(120), isFailing: true }
  const { seen, clock } = engine(on, world)
  await endTurn($, clock)
  await endTurn($, clock)
  await endTurn($, clock)
  expect(seen.completions.length).toBe(2)
})

test('a resumed session past the trigger starts its summary at once', async ($, on) => {
  const { seen, clock } = engine(on, { messages: conversation(121) })
  await resume($, clock, 121_000)
  expect(seen.completions.length).toBe(1)
})

test("a subagent's compaction is left to Claude Code", async ($, on) => {
  const { seen } = engine(on, { tokens: 160_000, messages: conversation(160) })
  await compact($, conversation(20), { agentId: 'a1' })
  expect(seen.core).toEqual(['auto'])
  expect(seen.completions.length).toBe(0)
})

test('with recall off the summary has no ids and points to the transcript', { options: { recall: false } }, async ($, on) => {
  const world = { tokens: 120_000, messages: conversation(120) }
  const { seen, clock } = engine(on, world)
  await $.session.start({ cwd: '/w' } as never)
  await resume($, clock, 120_000)
  expect(seen.tools.length).toBe(0)
  const request = seen.completions[0]!
  expect(request.prompt).toContain('USER: turn 1:')
  expect(request.prompt).not.toContain('[m0]')
  expect(request.system).not.toContain('[m412]')
  const compacted = await compact($, world.messages)
  expect(compacted.messages![0]!.text).toContain('read the full transcript at: /home/me/.claude/projects/p/session-1.jsonl')
  expect(seen.files.size).toBe(0)
})

test('the session offers the recall tool and the /async-compaction command', async ($, on) => {
  const world = { tokens: 60_000, messages: conversation(60) }
  const { seen, clock } = engine(on, world)
  await $.session.start({ cwd: '/w' } as never)
  expect(seen.commands).toEqual(['async-compaction'])
  expect(seen.tools).toEqual([{ name: 'recall', isDeferred: false }])

  const run = async () => ((await $.command.run({ command: 'async-compaction', args: '' } as never)) as { text: string }).text
  let text = await run()
  expect(text).toContain('Model haiku · level balanced (summary of at most 1,200 words)')
  expect(text).toContain('Context: 60,000 tokens. Claude Code compacts at 160,000; the summary starts at 120,000 (75%).')
  expect(text).toContain('Summary: not started')

  world.tokens = 121_000
  world.messages = conversation(121)
  await endTurn($, clock)
  text = await run()
  expect(text).toContain('Summary: ready. haiku wrote it 0s ago at 121,000 tokens: 242 messages')
  expect(text).toContain('swapped in')

  // Rewound and gone another way.
  world.messages = conversation(121, 500)
  expect(await run()).toContain('The conversation has changed under it')
})

test('turned off, Claude Code compacts as it always does', { options: { enabled: false } }, async ($, on) => {
  const world = { tokens: 150_000, messages: conversation(150) }
  const { seen, clock } = engine(on, world)
  await endTurn($, clock)
  await compact($, world.messages)
  expect(seen.completions.length).toBe(0)
  expect(seen.core).toEqual(['auto'])
})

test('the auto-compact percentage override moves the limit and the trigger with it', async ($, on) => {
  // Claude Code reports 160k either way; at 50% it compacts at (160k + 13k) / 2 = 86.5k, so the trigger is 64,875.
  const world = { tokens: 64_000, messages: conversation(64), env: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '50' } }
  const { seen, clock } = engine(on, world)
  await endTurn($, clock)
  expect(seen.completions.length).toBe(0)
  world.tokens = 65_000
  world.messages = conversation(65)
  await endTurn($, clock)
  expect(seen.completions.length).toBe(1)
})
