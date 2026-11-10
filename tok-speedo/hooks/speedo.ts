// Pure math and drawing for the speedometer, kept apart so tests can reach it.

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

function spark(values: number[]): string {
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  const span = hi - lo || 1
  return values
    .map(v => SPARK[Math.round(((v - lo) / span) * (SPARK.length - 1))])
    .join('')
}

export function line(model: string, rate: number): string {
  const r = rate.toFixed(rate < 100 ? 1 : 0)
  return `⚡ ${r} tok/s  ${shortModel(model)}`
}

export function report(stats: Stats): string {
  const entries = Object.entries(stats.byModel)
  if (!entries.length) return 'No turns measured yet.'
  const rows = entries.map(([m, s]) => {
    const last = s.recent.at(-1)
    const pct = last !== undefined && s.mean > 0 ? Math.round(((last - s.mean) / s.mean) * 100) : 0
    const vs = pct > 0 ? `▲${pct}%` : pct < 0 ? `▼${-pct}%` : '±0%'
    const lastStr = last !== undefined ? `${last.toFixed(1)} (${vs})` : '–'
    const trend = s.recent.length
      ? `${spark(s.recent)} [${s.recent.map(r => r.toFixed(0)).join(', ')}]`
      : '–'
    return `- ${shortModel(m)}: last ${lastStr}, avg ${s.mean.toFixed(1)} tok/s (${s.n} turns), best ${s.best.toFixed(1)}  ${trend}`
  })
  return `Token speed (output tokens ÷ generation time, per turn):\n${rows.join('\n')}`
}
