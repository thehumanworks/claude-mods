// Pure math and formatting, kept apart so tests can reach it.

export type ModelStats = {
  /** Turns measured. */
  n: number
  /** Running mean of tokens/sec across all measured turns. */
  mean: number
  /** The last turns' rates, newest last. */
  recent: number[]
  /** Fastest turn seen. */
  best: number
}

export type Stats = { byModel: Record<string, ModelStats> }

export type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

export const RECENT = 12
const SPARK = '▁▂▃▄▅▆▇█'

export const empty = (): ModelStats => ({ n: 0, mean: 0, recent: [], best: 0 })

export function record(s: ModelStats, rate: number): ModelStats {
  const n = s.n + 1
  return {
    n,
    mean: s.mean + (rate - s.mean) / n,
    recent: [...s.recent, rate].slice(-RECENT),
    best: Math.max(s.best, rate),
  }
}

/** Short model label: claude-opus-5-5 -> opus-5-5. */
export const shortModel = (m: string) => m.replace(/^claude-/, '').replace(/-\d{8}$/, '')

const num = (n: number) => Math.round(n).toLocaleString('en-US')
const pct = (part: number, whole: number) => `${whole > 0 ? ((part / whole) * 100).toFixed(1) : '0.0'}%`

function spark(values: number[]): string {
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  const span = hi - lo || 1
  return values
    .map(v => SPARK[Math.round(((v - lo) / span) * (SPARK.length - 1))])
    .join('')
}

/**
 * The line drawn under a turn's last message. Cache r/w is the share of all
 * input tokens (uncached + read + written) served from / written to the cache.
 */
export function summary(rate: number | undefined, u: Usage, durationMs: number): string {
  const read = u.cache_read_input_tokens
  const write = u.cache_creation_input_tokens
  const allIn = u.input_tokens + read + write
  const tps = rate === undefined ? 'TPS –' : `TPS ${rate.toFixed(1)} tok/s`
  return [
    tps,
    `out ${num(u.output_tokens)}`,
    `in ${num(u.input_tokens)}`,
    `cache r/w ${pct(read, allIn)}/${pct(write, allIn)}`,
    `total ${num(allIn + u.output_tokens)}`,
    `${(durationMs / 1000).toFixed(1)}s`,
  ].join(', ')
}

export function report(stats: Stats): string {
  const entries = Object.entries(stats.byModel)
  if (!entries.length) return 'No turns measured yet.'
  const rows = entries.map(([m, s]) => {
    const last = s.recent.at(-1)
    const p = last !== undefined && s.mean > 0 ? Math.round(((last - s.mean) / s.mean) * 100) : 0
    const vs = p > 0 ? `▲${p}%` : p < 0 ? `▼${-p}%` : '±0%'
    const lastStr = last !== undefined ? `${last.toFixed(1)} (${vs})` : '–'
    const trend = s.recent.length
      ? `${spark(s.recent)} [${s.recent.map(r => r.toFixed(0)).join(', ')}]`
      : '–'
    return `- ${shortModel(m)}: last ${lastStr}, avg ${s.mean.toFixed(1)} tok/s (${s.n} turns), best ${s.best.toFixed(1)}  ${trend}`
  })
  return `Token speed (output tokens ÷ generation time, per turn):\n${rows.join('\n')}`
}
