import type { EngineInterface, Register } from 'claude-code'

import { empty, line, record, report, type Stats } from './speedo'

const KEY = 'stats-v1'
const LAST = 'last-reading-v1'
const OLD_LAST = 'last-line'
// Too little output gives a noisy rate (tokens arrive in bursts).
const MIN_TOKENS = 20
const MIN_MS = 250

type Acc = { tokens: number; ms: number; model: string }

async function load($: EngineInterface): Promise<Stats> {
  const v = (await $.store.get(KEY)) as Stats | undefined
  return v && typeof v === 'object' && v.byModel ? v : { byModel: {} }
}

export const register: Register = on => {
  // Generation time and output tokens per main-loop turn, summed over its steps.
  // Stats are kept per model (the id each response reports), since a
  // bigger model is naturally slower than a smaller one.
  const turns = new Map<string, Acc>()
  let currentLine: string | undefined

  on('ui.render', { component: 'SessionMode' }, ($, e, next) =>
    next(currentLine ? { ...e, props: { modes: [...e.props.modes, currentLine] } } : e),
  )

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'tps',
      description: 'Token speed stats (/tps reset clears the averages)',
      argumentHint: '[reset]',
    })
    // Redraw from the saved reading so the line always uses the current code.
    await $.store.delete(OLD_LAST)
    let last = (await $.store.get(LAST)) as { model: string; rate: number } | undefined
    if (!last) {
      // No saved reading yet: fall back to the most-measured model's last turn.
      const stats = await load($)
      const [model, s] =
        Object.entries(stats.byModel).sort((x, y) => y[1].n - x[1].n)[0] ?? []
      const rate = s?.recent.at(-1)
      last = model && rate !== undefined ? { model, rate } : undefined
    }
    currentLine = last ? line(last.model, last.rate) : undefined
    $.ui.status(undefined)
    $.ui.invalidate('ui.render')
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)

    let first: number | undefined
    let end: number | undefined
    let tokens = 0
    let model = e.model
    const stream = next(e)
    for await (const chunk of stream) {
      if (first === undefined && chunk.kind !== 'engine' && chunk.kind !== 'stop') {
        first = await $.clock.now()
      }
      if (chunk.kind === 'stop') {
        end = await $.clock.now()
        if (chunk.usage) {
          tokens = chunk.usage.output_tokens
          model = chunk.usage.model || model
        }
      }
      yield chunk
    }
    const result = await stream.result
    if (first !== undefined && end !== undefined && tokens > 0) {
      const acc = turns.get(e.turnId) ?? { tokens: 0, ms: 0, model }
      acc.tokens += tokens
      acc.ms += end - first
      acc.model = model
      turns.set(e.turnId, acc)
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const out = await next(e)
    if (e.agentId !== undefined) return out
    const acc = turns.get(e.turnId)
    turns.delete(e.turnId)
    if (!acc || e.isAborted || acc.tokens < MIN_TOKENS || acc.ms < MIN_MS) return out

    const rate = acc.tokens / (acc.ms / 1000)
    const stats = await load($)
    const s = record(stats.byModel[acc.model] ?? empty(), rate)
    stats.byModel[acc.model] = s
    currentLine = line(acc.model, rate)
    $.ui.invalidate('ui.render')
    await $.store.set(KEY, stats)
    await $.store.set(LAST, { model: acc.model, rate })
    return out
  })

  on('command.run', { command: 'tps' }, async ($, e) => {
    if (e.args.trim() === 'reset') {
      await $.store.delete(KEY)
      await $.store.delete(LAST)
      currentLine = undefined
      $.ui.status(undefined)
      $.ui.invalidate('ui.render')
      return { text: 'Token speed averages cleared.' }
    }
    const stats = await load($)
    return { text: report(stats) }
  })
}
