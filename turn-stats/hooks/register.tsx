import type { EngineInterface, Register } from 'claude-code'

import { empty, record, report, summary, type Stats } from './stats'

const KEY = 'stats-v1'
// Lines already drawn, by the transcript row they sit under, so a reload or a
// resumed session still shows them.
const LINES = 'lines-v1'
const MAX_LINES = 200
// Too little output gives a noisy rate (tokens arrive in bursts).
const MIN_TOKENS = 20
const MIN_MS = 250

type Acc = { tokens: number; ms: number; model: string }
type Lines = Record<string, string>

async function load($: EngineInterface): Promise<Stats> {
  const v = (await $.store.get(KEY)) as Stats | undefined
  return v && typeof v === 'object' && v.byModel ? v : { byModel: {} }
}

// The lines, read from the store once per load.
const cache: { lines?: Lines } = {}

async function getLines($: EngineInterface): Promise<Lines> {
  if (!cache.lines) {
    const v = (await $.store.get(LINES)) as Lines | undefined
    cache.lines = v && typeof v === 'object' ? v : {}
  }
  return cache.lines
}

const hasText =(content: readonly { type: string; text?: string }[]) =>
  content.some(b => b.type === 'text' && !!b.text?.trim())

export const register: Register = on => {
  // Generation time and output tokens per main-loop turn, summed over its steps.
  const turns = new Map<string, Acc>()
  // The main loop's latest assistant row with visible text: the turn's last message.
  let lastTextRow: string | undefined
  cache.lines = undefined

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

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) lastTextRow = undefined
    return next(e)
  })

  on('session.append', ($, e, next) => {
    if (
      e.agentId === undefined &&
      e.door === 'response' &&
      e.message.type === 'assistant' &&
      hasText(e.message.content)
    ) {
      lastTextRow = e.uuid
    }
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
    const row = lastTextRow
    lastTextRow = undefined
    const usage = out.usage ?? e.usage
    if (!usage || !row) return out

    const measured = acc && acc.tokens >= MIN_TOKENS && acc.ms >= MIN_MS
    const rate = measured ? acc.tokens / (acc.ms / 1000) : undefined
    if (rate !== undefined && acc && !e.isAborted) {
      const stats = await load($)
      stats.byModel[acc.model] = record(stats.byModel[acc.model] ?? empty(), rate)
      await $.store.set(KEY, stats)
    }

    const all = await getLines($)
    all[row] = summary(rate, usage, e.durationMs)
    const keys = Object.keys(all)
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_LINES))) delete all[k]
    await $.store.set(LINES, all)
    $.ui.invalidate('ui.render')
    return out
  })

  // The line, dim, under the turn's last message, on every surface.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const line = (await getLines($))[e.requestId]
    if (!line) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const indent = e.surface === 'terminal' ? 2 : 0
    return (
      <Box flexDirection="column">
        {await next(e)}
        <Box marginTop={1} marginLeft={indent}>
          <Text dimColor>{line}</Text>
        </Box>
      </Box>
    )
  })

  on('command.run', { command: 'tps' }, async ($, e) => {
    if (e.args.trim() === 'reset') {
      await $.store.delete(KEY)
      return { text: 'Token speed averages cleared.' }
    }
    return { text: report(await load($)) }
  })
}
