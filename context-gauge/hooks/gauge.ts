// The gauge's logic, free of the engine: the limit, the status line, the bands
// and the note Claude reads when one is crossed.

export const DEFAULT_BANDS: readonly number[] = [50, 75, 90]

/** What Claude Code keeps free between its auto-compact threshold and the window less the reply's room (as async-compaction). */
export const AUTOCOMPACT_BUFFER = 13_000

/** The figures `$.session.usage({ breakdown })` answers that the limit is read from. */
export type ContextFigures = {
  window: number
  breakdown?: { autoCompactThreshold?: number; rawMaxTokens: number; isAutoCompactEnabled: boolean }
}

/** Where the context runs out: Claude Code's auto-compact limit, or with auto-compact off, its window. */
export type Limit = { tokens: number; isAuto: boolean; window: number }

/**
 * The limit as Claude Code applies it, read the way async-compaction reads it:
 * the reported auto-compact threshold, moved by CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
 * when that is set (a share of the threshold plus the engine's buffer).
 */
export function limitOf(context: ContextFigures, overridePercent?: number): Limit {
  const { breakdown } = context
  let tokens = breakdown?.autoCompactThreshold ?? breakdown?.rawMaxTokens ?? context.window
  const percent = Number(overridePercent)
  if (breakdown?.autoCompactThreshold !== undefined && percent > 0 && percent <= 100) {
    tokens = Math.min(tokens, Math.floor(((breakdown.autoCompactThreshold + AUTOCOMPACT_BUFFER) * percent) / 100))
  }
  return { tokens, isAuto: breakdown?.isAutoCompactEnabled !== false, window: breakdown?.rawMaxTokens ?? context.window }
}

/** The `bands` option: whole percentages from 1 to 99, sorted. A value that cannot be used is reported in `problems`. */
export function parseBands(value: unknown): { bands: number[]; problems: string[] } {
  if (value === undefined || value === null) return { bands: [...DEFAULT_BANDS], problems: [] }
  const parts = Array.isArray(value) ? value : typeof value === 'number' ? [value] : String(value).split(/[\s,;]+/)
  const words = parts.map(p => String(p).trim()).filter(p => p !== '')
  if (words.length === 0) return { bands: [...DEFAULT_BANDS], problems: [] }
  if (words.length === 1 && /^(off|none)$/i.test(words[0]!)) return { bands: [], problems: [] }
  const bands = new Set<number>()
  const problems: string[] = []
  for (const word of words) {
    const n = Number(word.replace(/%$/, ''))
    if (Number.isInteger(n) && n >= 1 && n <= 99) bands.add(n)
    else problems.push(`bands: ${JSON.stringify(word)} is not a whole percentage from 1 to 99; left out`)
  }
  if (bands.size === 0) {
    problems.push(`bands: nothing usable; using ${DEFAULT_BANDS.join(', ')}`)
    return { bands: [...DEFAULT_BANDS], problems }
  }
  return { bands: [...bands].sort((a, b) => a - b), problems }
}

/** 134000 -> 134k, 1200000 -> 1.2M, 800 -> 800. */
export function short(n: number): string {
  if (n < 1000) return String(Math.round(n))
  const k = Math.round(n / 1000)
  if (k < 1000) return `${k}k`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

const full = (n: number) => Math.round(n).toLocaleString('en-US')

/** The share of the limit used, as a whole percentage, rounded down so the line never reads a band before it is crossed. */
export const percentOf = (tokens: number, limit: number) => (limit > 0 ? Math.floor((tokens * 100) / limit) : 0)

/** The status line: `ctx 134k/267k · 50%`; `–` for the size before a response has reported one (a fresh or just compacted window). */
export function statusLine(tokens: number | undefined, limit: Limit): string {
  const off = limit.isAuto ? '' : ' · auto-compact off'
  if (tokens === undefined) return `ctx –/${short(limit.tokens)}${off}`
  return `ctx ${short(tokens)}/${short(limit.tokens)} · ${percentOf(tokens, limit.tokens)}%${off}`
}

/**
 * The band to tell Claude of now: the highest band the context has reached and
 * that is above every band noted since the last compaction. Undefined when
 * there is none, so several bands crossed in one step give one note.
 */
export function crossedBand(tokens: number, limit: number, bands: readonly number[], noted: number): number | undefined {
  if (limit <= 0) return undefined
  let band: number | undefined
  for (const b of bands) if (b > noted && tokens * 100 >= b * limit) band = Math.max(band ?? 0, b)
  return band
}

/** One line fitting the band. */
export function suggestion(band: number, isAuto: boolean): string {
  if (band >= 90) {
    return `${isAuto ? 'Compaction is close' : 'The context window is nearly full'}: finish or checkpoint the current step now, write down what you will need afterwards, and avoid large reads.`
  }
  if (band >= 70) {
    return 'Finish the current step before starting a new one, and keep decisions and next steps in a notes file or the todo list, where they survive compaction.'
  }
  return 'There is room left, but read large files in parts (Grep, line ranges) rather than whole.'
}

/** The note Claude reads with its next request. */
export function note(band: number, tokens: number, limit: Limit): string {
  const where = limit.isAuto
    ? `of ${full(limit.tokens)}, where Claude Code compacts automatically`
    : `of the ${full(limit.tokens)}-token window (auto-compact is off)`
  return `[context-gauge] Context past ${band}%: ${full(tokens)} tokens used ${where}. ${suggestion(band, limit.isAuto)}`
}
