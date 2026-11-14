import type { EngineInterface, Register } from 'claude-code'

import { empty, record, report, summary, type Stats } from './stats'

const KEY = 'stats-v1'
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
  const turns = new Map<string, Acc>()

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'tps',
      description: 'Token speed averages per model (/tps reset clears them)',
      argumentHint: '[reset]',
    })
    // Clear anything an earlier version left on the status line.
    $.ui.status(undefined)
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

  // Returning a different `text` draws it beneath the turn's answer.
  on('turn.complete', async ($, e, next) => {
    const out = await next(e)
    if (e.agentId !== undefined) return out
    const acc = turns.get(e.turnId)
    turns.delete(e.turnId)
    const usage = out.usage ?? e.usage
    if (!usage) return out

    const measured = acc && acc.tokens >= MIN_TOKENS && acc.ms >= MIN_MS
    const rate = measured ? acc.tokens / (acc.ms / 1000) : undefined
    if (rate !== undefined && acc && !e.isAborted) {
      const stats = await load($)
      stats.byModel[acc.model] = record(stats.byModel[acc.model] ?? empty(), rate)
      await $.store.set(KEY, stats)
    }
    return { ...out, text: summary(rate, usage, e.durationMs) }
  })

  on('command.run', { command: 'tps' }, async ($, e) => {
    if (e.args.trim() === 'reset') {
      await $.store.delete(KEY)
      return { text: 'Token speed averages cleared.' }
    }
    return { text: report(await load($)) }
  })
}
