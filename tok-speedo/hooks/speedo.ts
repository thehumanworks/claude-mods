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
const GAUGE = 13 // odd: the middle cell is the average
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

function gauge(rate: number, mean: number): string {
  const mid = (GAUGE - 1) / 2
  const pos = Math.max(0, Math.min(GAUGE - 1, Math.round((rate / mean) * mid)))
  let out = ''
  for (let i = 0; i < GAUGE; i++) {
    out += i === pos ? '◉' : i === mid ? '┿' : '━'
  }
  return `╺${out}╸`
}

function spark(values: number[]): string {
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  const span = hi - lo || 1
  return values
    .map(v => SPARK[Math.round(((v - lo) / span) * (SPARK.length - 1))])
    .join('')
}

export function line(model: string, rate: number, s: ModelStats): string {
  const r = rate.toFixed(rate < 100 ? 1 : 0)
  const head = `⚡ ${r} tok/s`
  const pct = Math.round(((rate - s.mean) / s.mean) * 100)
  const vs = pct > 0 ? `▲${pct}%` : pct < 0 ? `▼${-pct}%` : '±0%'
  return [
    head,
    gauge(rate, s.mean),
    vs,
    `avg ${s.mean.toFixed(0)}`,
    spark(s.recent),
    shortModel(model),
  ].join('  ')
}
