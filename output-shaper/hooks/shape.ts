// The logic of output-shaper, free of the engine: settings, the cut into
// first and last lines, and the words Claude reads.

export type Config = {
  /** Output longer than this, in characters, is shaped. */
  threshold: number
  headLines: number
  tailLines: number
  /** Where output Claude Code did not save is saved; empty: DEFAULT_SAVE_DIR in the session's folder. */
  saveDir: string
}

export const DEFAULTS: Config = { threshold: 12_000, headLines: 40, tailLines: 60, saveDir: '' }
export const DEFAULT_SAVE_DIR = '.claude/output-shaper'
/** A kept line longer than this is cut. */
export const MAX_LINE_CHARS = 500
/** stderr shorter than this stays whole beside shaped stdout. */
export const STDERR_WHOLE_CHARS = 2_000

const RANGES = {
  threshold: [2_000, 200_000],
  headLines: [0, 500],
  tailLines: [1, 1_000],
} as const

export function resolveConfig(options: Readonly<Record<string, unknown>>): { config: Config; problems: string[] } {
  const config: Config = { ...DEFAULTS }
  const problems: string[] = []
  for (const key of ['threshold', 'headLines', 'tailLines'] as const) {
    const raw = options[key]
    if (raw === undefined || raw === '') continue
    const value = typeof raw === 'string' ? Number(raw) : raw
    const [min, max] = RANGES[key]
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
      problems.push(`${key}: ${JSON.stringify(raw)} is not a number from ${min} to ${max}; using ${DEFAULTS[key]}`)
    } else config[key] = Math.round(value)
  }
  if (typeof options.saveDir === 'string') config.saveDir = options.saveDir.trim()
  return { config, problems }
}

/** The text's lines, a final newline closing the last one rather than opening another. */
export function linesOf(text: string): string[] {
  if (text === '') return []
  const lines = text.split(/\r?\n/)
  if (lines.at(-1) === '') lines.pop()
  return lines
}

/** Cuts a line over MAX_LINE_CHARS, saying how much is left out. */
export function clipLine(line: string): string {
  if (line.length <= MAX_LINE_CHARS) return line
  return `${line.slice(0, MAX_LINE_CHARS)} … [${fmt(line.length - MAX_LINE_CHARS)} more characters on this line]`
}

export type Excerpt = {
  head: string[]
  tail: string[]
  /** Line number (1-based) of the first line left out; meaningful when `omitted` > 0. */
  firstOmitted: number
  omitted: number
  /** Some kept line was cut at MAX_LINE_CHARS. */
  isClipped: boolean
}

/**
 * The first `headN` and last `tailN` lines, each cut at MAX_LINE_CHARS, within
 * `budget` characters in all: 40% for the start, the rest for the end, so the
 * end (where errors and summaries sit) always keeps at least one line.
 */
export function excerpt(lines: readonly string[], headN: number, tailN: number, budget: number): Excerpt {
  const take = (from: readonly string[], n: number, room: number, atLeastOne: boolean): string[] => {
    const kept: string[] = []
    let used = 0
    for (const line of from) {
      if (kept.length >= n) break
      const clipped = clipLine(line)
      if (used + clipped.length + 1 > room && !(atLeastOne && kept.length === 0)) break
      kept.push(clipped)
      used += clipped.length + 1
    }
    return kept
  }
  const head = take(lines, Math.min(headN, lines.length), Math.floor(budget * 0.4), false)
  const rest = lines.slice(head.length)
  const tail = take([...rest].reverse(), Math.min(tailN, rest.length), budget - head.reduce((n, l) => n + l.length + 1, 0), true).reverse()
  const omitted = lines.length - head.length - tail.length
  const isClipped = [...head, ...tail].some(l => l.length > MAX_LINE_CHARS)
  return { head, tail, firstOmitted: head.length + 1, omitted, isClipped }
}

export type Whole = {
  path: string
  lines: number
  /** The size: characters when the whole text was read, else bytes. */
  size: number
  unit: 'characters' | 'bytes'
}

/** What Claude reads in place of stdout: the start, a marker with the counts, the end, the path and a hint. */
export function render(ex: Excerpt, whole: Whole): string {
  const inAll = `${fmt(whole.lines)} lines, ${fmt(whole.size)} ${whole.unit} in all`
  const parts: string[] = []
  if (ex.head.length > 0) parts.push(ex.head.join('\n'))
  if (ex.omitted > 0) {
    const last = ex.firstOmitted + ex.omitted - 1
    parts.push(`[output-shaper: lines ${fmt(ex.firstOmitted)} to ${fmt(last)} (${fmt(ex.omitted)} lines) left out here; ${inAll}]`)
  } else {
    parts.push(`[output-shaper: every line is here, long lines cut at ${MAX_LINE_CHARS} characters; ${inAll}]`)
  }
  if (ex.tail.length > 0) parts.push(ex.tail.join('\n'))
  parts.push(hint(whole.path))
  return parts.join('\n')
}

export function hint(path: string): string {
  return `[output-shaper: the whole output is in ${path}. To see more, Grep that file for a pattern or Read it with offset and limit (the line numbers above); do not run the command again for it.]`
}

/** stderr beside shaped stdout: whole when short, else its last lines. */
export function keepStderr(stderr: string, tailN: number): string {
  if (stderr.length <= STDERR_WHOLE_CHARS) return stderr
  const lines = linesOf(stderr)
  const ex = excerpt(lines, 0, tailN, STDERR_WHOLE_CHARS * 2)
  return [`[output-shaper: the last ${fmt(ex.tail.length)} of ${fmt(lines.length)} lines of stderr]`, ...ex.tail].join('\n')
}

/**
 * The note added to an error result whose whole output Claude Code saved: its
 * preview shows the start, and the failure is usually at the end.
 */
export function errorNote(ex: Excerpt, whole: Whole): string {
  return [
    `output-shaper: Claude Code saved this command's whole output to ${whole.path} (${fmt(whole.lines)} lines, ${fmt(whole.size)} ${whole.unit}). The preview in the result shows its start; these are its last ${fmt(ex.tail.length)} lines:`,
    ...ex.tail,
    `Grep that file for a pattern or Read it with offset and limit rather than running the command again.`,
  ].join('\n')
}

/** The file Claude Code names in its own notice for output too large to show (`<persisted-output>`). */
export function savedPathIn(text: string): string | undefined {
  if (!text.includes('<persisted-output>')) return undefined
  const m = /(?:Full output saved to|were saved to): (.+)/.exec(text)
  return m?.[1]?.trim() || undefined
}

/** A file name from a tool_use_id: letters, digits, `_` and `-` only. */
export function fileNameFor(toolUseId: string): string {
  return `${toolUseId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100) || 'output'}.txt`
}

export function joinPath(dir: string, name: string): string {
  return `${dir.replace(/[\\/]+$/, '')}/${name}`
}

export function isAbsolute(path: string): boolean {
  return /^([/\\]|[A-Za-z]:[\\/])/.test(path)
}

export const fmt = (n: number): string => n.toLocaleString('en-US')
