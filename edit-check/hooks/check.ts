// The logic of edit-check, free of the engine: settings, which files count,
// and what of a check's output Claude is handed.

export type Config = {
  /** The check command, run through the shell. Empty: the mod is off. */
  command: string
  /** Globs of the edited files that start a check. Empty: every file. */
  globs: string[]
  timeoutSeconds: number
  maxChars: number
}

export const DEFAULTS: Config = { command: '', globs: [], timeoutSeconds: 60, maxChars: 4000 }
export const TIMEOUT_MIN = 1
export const TIMEOUT_MAX = 600
export const MAX_CHARS_MIN = 200
export const MAX_CHARS_MAX = 50_000
/** With no line naming a file Claude touched, this many lines of the output are handed over. */
export const FALLBACK_LINES = 30

/**
 * The settings from the plugin's options. A value that cannot be used keeps
 * the default and is reported in `problems`.
 */
export function resolveConfig(options: Readonly<Record<string, unknown>>): { config: Config; problems: string[] } {
  const config: Config = { ...DEFAULTS, globs: [] }
  const problems: string[] = []
  if (typeof options.command === 'string') config.command = options.command.trim()
  if (typeof options.globs === 'string') config.globs = splitGlobs(options.globs)
  const number = (key: 'timeoutSeconds' | 'maxChars', min: number, max: number) => {
    const raw = options[key]
    if (raw === undefined || raw === '') return
    const value = typeof raw === 'string' ? Number(raw) : raw
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
      problems.push(`${key}: ${JSON.stringify(raw)} is not a number from ${min} to ${max}; using ${DEFAULTS[key]}`)
    } else config[key] = Math.round(value)
  }
  number('timeoutSeconds', TIMEOUT_MIN, TIMEOUT_MAX)
  number('maxChars', MAX_CHARS_MIN, MAX_CHARS_MAX)
  return { config, problems }
}

/** Splits on commas outside braces, so `**\/*.{ts,tsx}` stays one glob. */
export function splitGlobs(text: string): string[] {
  const globs: string[] = []
  let depth = 0
  let current = ''
  for (const ch of text) {
    if (ch === '{') depth++
    if (ch === '}') depth = Math.max(0, depth - 1)
    if (ch === ',' && depth === 0) {
      globs.push(current)
      current = ''
    } else current += ch
  }
  globs.push(current)
  return globs.map(g => g.trim()).filter(g => g !== '')
}

export function globToRegExp(glob: string): RegExp {
  let source = ''
  let inBraces = false
  const g = glob.replace(/\\/g, '/').replace(/^\.\//, '')
  for (let i = 0; i < g.length; i++) {
    const ch = g[i]!
    if (ch === '*' && g[i + 1] === '*') {
      if (g[i + 2] === '/') {
        source += '(?:.*/)?'
        i += 2
      } else {
        source += '.*'
        i += 1
      }
    } else if (ch === '*') source += '[^/]*'
    else if (ch === '?') source += '[^/]'
    else if (ch === '{') {
      source += '(?:'
      inBraces = true
    } else if (ch === '}' && inBraces) {
      source += ')'
      inBraces = false
    } else if (ch === ',' && inBraces) source += '|'
    else source += ch.replace(/[.+^$()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${source}$`)
}

/** Forward slashes, no trailing slash. */
export function normalize(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
}

/** The path relative to `cwd` when it lies inside it, else the path itself. */
export function relativeTo(cwd: string, path: string): string {
  const p = normalize(path)
  const base = normalize(cwd)
  return p.startsWith(`${base}/`) ? p.slice(base.length + 1) : p
}

/**
 * Whether an edited file starts a check: every file with no globs; otherwise a
 * glob with a slash is matched against the path relative to `cwd`, one without
 * against the file name.
 */
export function isWatched(globs: readonly string[], cwd: string, path: string): boolean {
  if (globs.length === 0) return true
  const rel = relativeTo(cwd, path)
  const name = rel.slice(rel.lastIndexOf('/') + 1)
  return globs.some(glob => globToRegExp(glob).test(glob.replace(/^\.\//, '').includes('/') ? rel : name))
}

/** The output as lines, colour codes and carriage returns removed. */
export function linesOf(output: string): string[] {
  // eslint-disable-next-line no-control-regex
  const plain = output.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r\n?/g, '\n')
  const lines = plain.split('\n')
  while (lines.length > 0 && lines.at(-1)!.trim() === '') lines.pop()
  return lines
}

/**
 * The output cut into blocks: a line that starts at the margin and the
 * indented lines under it. That keeps a compiler's error together with its
 * notes (tsc, rustc's `-->` line) and a linter's file heading with the errors
 * listed under it (eslint). A blank line ends a block.
 */
export function blocksOf(output: string): string[][] {
  const blocks: string[][] = []
  let current: string[] | undefined
  for (const line of linesOf(output)) {
    if (line.trim() === '') {
      current = undefined
      continue
    }
    if (current === undefined || !/^\s/.test(line)) {
      current = [line]
      blocks.push(current)
    } else current.push(line)
  }
  return blocks
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * A test of whether a line names one of the files: by its absolute path or its
 * path relative to `cwd`, as a whole path (`src/a.ts` is not `lib/src/a.ts`,
 * nor `src/a.tsx`).
 */
export function mentionTest(cwd: string, files: Iterable<string>): (line: string) => boolean {
  const forms = new Set<string>()
  for (const file of files) {
    forms.add(normalize(file))
    forms.add(relativeTo(cwd, file))
  }
  if (forms.size === 0) return () => false
  const pattern = new RegExp(`(?:^|[^\\w./-])(?:\\./)?(?:${[...forms].map(escape).join('|')})(?![\\w-]|\\.\\w)`)
  return line => pattern.test(line.replace(/\\/g, '/'))
}

const keyOf = (block: readonly string[]) => block.map(l => l.trim()).join('\n')

export type Outcome =
  /** Nothing to tell Claude. */
  | { kind: 'silent' }
  /** Errors to hand over. */
  | { kind: 'errors'; text: string }
  /** The check passes again after a failure Claude was told of. */
  | { kind: 'passes'; text: string }
  /** The files Claude touched are clean again, but the check still fails, on errors it had before. */
  | { kind: 'cleared'; text: string }

export type Run = {
  command: string
  exitCode: number
  output: string
  cwd: string
  /** The files edited since the run before, absolute. */
  touched: readonly string[]
  /** The blocks of the run before, to tell new errors from old ones; undefined on the first run. */
  previous?: ReadonlySet<string>
  /** Claude was told of a failure, and not yet that it passes again. */
  wasReported: boolean
  maxChars: number
}

/**
 * What to tell Claude of one run, and the blocks to compare the next run with.
 *
 * A passing run says nothing, unless Claude was told of a failure: then one
 * short note. A failing run hands over the blocks that name a file touched
 * since the run before; with none, the first lines of the blocks the run before
 * did not have (all of them on the first run), so errors met at every check
 * are not handed over again and again.
 */
export function judge(run: Run): { outcome: Outcome; blocks: Set<string> } {
  const all = blocksOf(run.output)
  const blocks = new Set(all.map(keyOf))
  const cmd = `\`${run.command}\``
  if (run.exitCode === 0) {
    return { outcome: run.wasReported ? { kind: 'passes', text: `edit-check: ${cmd} passes again.` } : { kind: 'silent' }, blocks }
  }
  const touched = run.touched.map(f => relativeTo(run.cwd, f))
  const mentions = mentionTest(run.cwd, run.touched)
  const matched = all.filter(block => block.some(mentions))
  if (matched.length > 0) {
    const head = `edit-check: ${cmd} failed (exit code ${run.exitCode}) after your edits. Errors in the files you touched (${touched.join(', ')}):`
    return { outcome: { kind: 'errors', text: `${head}\n${clip(matched.flat().join('\n'), run.maxChars)}` }, blocks }
  }
  const fresh = run.previous === undefined ? all : all.filter(block => !run.previous!.has(keyOf(block)))
  if (fresh.length === 0) {
    const outcome: Outcome = run.wasReported
      ? { kind: 'cleared', text: `edit-check: no errors left in the files you touched; ${cmd} still fails (exit code ${run.exitCode}) on errors it had before.` }
      : { kind: 'silent' }
    return { outcome, blocks }
  }
  const lines = fresh.flat()
  const shown = lines.slice(0, FALLBACK_LINES)
  const more = lines.length - shown.length
  const head = `edit-check: ${cmd} failed (exit code ${run.exitCode}) after your edits to ${touched.join(', ')}. No line names those files; its first lines:`
  const body = clip(shown.join('\n'), run.maxChars) + (more > 0 ? `\n[${more} more line${more === 1 ? '' : 's'}]` : '')
  return { outcome: { kind: 'errors', text: `${head}\n${body}` }, blocks }
}

/** Cuts the text to `max` characters, at a line end where one is near, and says how much is left out. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text
  let cut = text.lastIndexOf('\n', max)
  if (cut < max * 0.5) cut = max
  return `${text.slice(0, cut)}\n[${text.length - cut} more characters cut]`
}

/** The argument vector that runs the command through the platform's shell. */
export function shellArgv(command: string, isWindows: boolean): string[] {
  return isWindows ? ['cmd.exe', '/d', '/s', '/c', command] : ['sh', '-c', command]
}
