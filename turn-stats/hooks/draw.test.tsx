import { expect, test } from 'claude-code/testing'

const USAGE = {
  model: 'claude-opus-5-5',
  output_tokens: 467,
  input_tokens: 2,
  cache_read_input_tokens: 48_000,
  cache_creation_input_tokens: 605,
}

const message = (requestId: string) =>
  ({
    plugin: 'turn-stats',
    component: 'AssistantMessage',
    requestId,
    props: { text: 'Done.', isFirstOfReply: true },
  }) as const

test('the stats line is drawn under the turn last message, on every surface', async ($, on) => {
  const store = new Map<string, unknown>()
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => (store.set(e.key, e.value), { value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'tps' } }))
  on('turn.start', (_, e) => e)
  on('turn.complete', (_, e) => ({ text: e.answer, usage: USAGE }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  const rows: [string, string][] = [
    ['row-1', 'Looking.'],
    ['row-2', 'Done.'],
  ]
  for (const [uuid, text] of rows) {
    await $.session.append({
      message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] },
      door: 'response',
      origin: { kind: 'model', model: 'claude-opus-5-5' },
      uuid,
    })
  }
  const out = await $.turn.complete({
    answer: 'Done.',
    durationMs: 4200,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
    usage: USAGE,
  })
  // The answer itself is left alone: no note with the mod's name.
  expect(out.text).toBe('Done.')

  for (const surface of ['terminal', 'desktop'] as const) {
    const last = await $.ui.mount({ ...message('row-2'), surface })
    expect((await last.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
    expect((await last.find({ type: 'Text', text: /^TPS/ }))?.text).toBe(
      'TPS –, out 467, in 2, cache r/w 98.8%/1.2%, total 49,074, 4.2s',
    )
    await last.unmount()

    const earlier = await $.ui.mount({ ...message('row-1'), surface })
    expect(await earlier.find({ type: 'Text', text: /^TPS/ })).toBeUndefined()
    await earlier.unmount()
  }
})
