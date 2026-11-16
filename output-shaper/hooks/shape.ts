// The logic of output-shaper, free of the engine: settings, the cut into
// first and last lines, and the words Claude reads.

export type Config = {
  /** Output longer than this, in characters, is shaped. */
  threshold: number
  headLines: number
  tailLines: number
  /** Where output Claude Code did not save is saved; empty: DEFAULT_SAVE_DIR in the session's folder. */
  saveDir: string
  /** Wrap Claude's Bash commands so the real end of a failing one's output is kept. */
  keepFailingTail: boolean
}

export const DEFAULTS: Config = { threshold: 20_000, headLines: 40, tailLines: 60, saveDir: '', keepFailingTail: false }
export const DEFAULT_SAVE_DIR = '.claude/output-shaper'
/** A kept line longer than this is cut. */
export const MAX_LINE_CHARS = 500
/**
 * The most the kept lines take, whatever the threshold: Claude Code's own inline
 * limit is 30,000 characters by default, and markers and stderr come on top.
 */
export const EXCERPT_BUDGET_MAX = 24_000
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
  if (typeof options.keepFailingTail === 'boolean') config.keepFailingTail = options.keepFailingTail
  else if (options.keepFailingTail === 'false' || options.keepFailingTail === 'true') config.keepFailingTail = options.keepFailingTail === 'true'
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

const NOTICE = [
  /^Output too large \([^()]+\)\. Full output saved to: (.+)$/,
  /^Output exceeded the [^;]+ persist limit; only the first [^;]+ were saved to: (.+)$/,
]

/**
 * The file Claude Code names in an error result when it saved the output: its
 * notice comes right after the `Exit code N` line, before any of the command's
 * own output. Elsewhere in the text the same words are the command's, and not
 * trusted. A command whose output opens with them still gets past this, so the
 * path must also pass `isSessionToolResult`.
 */
export function savedPathInError(text: string): string | undefined {
  const lines = text.split('\n')
  if (!/^Exit code -?\d+$/.test(lines[0] ?? '')) return undefined
  const at = lines[1] === '<persisted-output>' ? 2 : 1
  for (const re of NOTICE) {
    const m = re.exec(lines[at] ?? '')
    if (m?.[1] !== undefined && m[1].trim() !== '') return m[1].trim()
  }
  return undefined
}

/**
 * Whether a path is a file in this session's own tool-results folder, where
 * Claude Code saves output: `<config>/projects/<project>/<session id>/tool-results/<name>`,
 * with no `.` or `..` segment.
 */
export function isSessionToolResult(path: string, sessionId: string): boolean {
  if (sessionId === '' || !/^[A-Za-z0-9_-]+$/.test(sessionId)) return false
  const p = path.replace(/\\/g, '/')
  if (!isAbsolute(p) || p.split('/').some(seg => seg === '.' || seg === '..')) return false
  return new RegExp(`/projects/[^/]+/${sessionId}/tool-results/[^/]+$`).test(p)
}

/**
 * Whether settings hooks (`{ PreToolUse: [{ matcher, hooks }] }`) hold a
 * PreToolUse hook that can fire for Bash: no matcher, a wildcard, a matcher
 * naming Bash, or one that matches it as a pattern. Such a hook may guard by
 * the command line, which the wrap changes, so the mod then never wraps.
 */
export function hasBashPreToolUse(hooks: unknown): boolean {
  if (hooks === null || typeof hooks !== 'object') return false
  const entries = (hooks as Record<string, unknown>).PreToolUse
  if (!Array.isArray(entries)) return false
  return entries.some(entry => {
    if (entry === null || typeof entry !== 'object') return true
    const matcher = (entry as { matcher?: unknown }).matcher
    if (matcher === undefined || matcher === null || matcher === '') return true
    if (typeof matcher !== 'string') return true
    const m = matcher.trim()
    if (m === '*' || /bash/i.test(m)) return true
    try {
      // Unanchored, as Claude Code tests a matcher that is not a plain name: `B.` and `^B` fire for Bash.
      return new RegExp(m).test('Bash')
    } catch {
      return true
    }
  })
}

/** The most characters the failing tail's note gives the last lines. */
export const TAIL_NOTE_MAX_CHARS = 10_000
/** The folder for the wrap's files under DEFAULT_SAVE_DIR, when no saveDir is set. */
export const TAIL_SUBDIR = 'tails'
/** Wrap files kept at most, newest first, and for how long. */
export const TAIL_FILES_MAX = 20
export const TAIL_FILE_MAX_AGE_MS = 24 * 60 * 60 * 1000

/** The wrap's file name for a tool_use_id; only names of this form are ever cleaned up. */
export function tailFileNameFor(toolUseId: string): string {
  return `tail-${fileNameFor(toolUseId)}`
}
export const TAIL_FILE_RE = /^tail-[A-Za-z0-9_-]{1,100}\.txt$/

/** Claude Code's marker where it cut the middle of an error's output. */
const CUT_MARKER = /\n\n\.\.\. \[\d+ characters truncated\] \.\.\.\n\n/
const ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]/g

/**
 * Whether what Claude read lost the real end of the whole output: the whole is
 * longer than what Claude read, and either Claude Code's cut marker is there or
 * the whole's last line is not at the end of what Claude read. The marker alone
 * proves nothing, as a command can print it.
 */
export function lostTheEnd(read: string, wholeSize: number, wholeLines: readonly string[]): boolean {
  if (wholeSize <= read.length) return false
  if (CUT_MARKER.test(read)) return true
  const last = [...wholeLines].reverse().find(l => l.trim() !== '')
  if (last === undefined) return false
  return !read.slice(-4_000).replace(ANSI, '').includes(last.replace(ANSI, '').trimEnd())
}

/** The note added to a failing command whose output Claude Code cut: the real last lines and the path. */
export function tailNote(ex: Excerpt, whole: Whole): string {
  return [
    `output-shaper: Claude Code cut this command's output, and its real end was not in the result. The whole output (${fmt(whole.lines)} lines, ${fmt(whole.size)} ${whole.unit}) is in ${whole.path}. These are its last ${fmt(ex.tail.length)} lines:`,
    ...ex.tail,
    `Grep that file for a pattern or Read it with offset and limit rather than running the command again.`,
  ].join('\n')
}

/** The note added to a command whose output was cut although it did not fail, when no other copy is kept. */
export function keptNote(whole: Whole): string {
  return `output-shaper: the result above was cut; the whole output (${fmt(whole.lines)} lines, ${fmt(whole.size)} ${whole.unit}) is in ${whole.path}. Grep it or Read it with offset and limit rather than running the command again.`
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
