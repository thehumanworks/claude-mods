// The test gate's logic, free of the engine: settings, what counts as a test
// run, what counts as code, the question put to the model and how its answer
// is read, and the note Claude is given.

export const $name = 'test-gate'

export const DEFAULT_MODEL = 'claude-haiku-5-5'

/**
 * Commands that count as a test or check run. Each matches a command that starts with it. A package
 * manager pattern (`npm test`, `npm run lint`) covers the same script run by npm, pnpm, yarn or bun,
 * with or without `run`.
 */
export const DEFAULT_PATTERNS = [
  'npm test', 'npm t', 'npm run check', 'npm run lint', 'npm run typecheck', 'npm run type-check',
  'deno test', 'node --test', 'vitest', 'jest', 'mocha', 'playwright test', 'tsc', 'eslint',
  'pytest', 'tox', 'nox', 'mypy', 'ruff check', 'unittest',
  'cargo test', 'cargo check', 'cargo clippy', 'cargo nextest',
  'go test', 'go vet',
  'make test', 'make check', 'make lint',
  'mvn test', 'mvn verify', 'gradle test', './gradlew test', 'dotnet test',
  'mix test', 'rspec', 'rake test', 'phpunit', 'swift test',
  'claude plugin test', 'claude plugin validate',
]

export type Config = {
  enabled: boolean
  /** The model asked whether the edits need a test run: an alias or a full id. */
  model: string
  /** The model call is given up after this long, and the code-only rule decides. */
  timeoutSeconds: number
  /** Command prefixes that count as a test or check run. */
  patterns: string[]
}

export const DEFAULTS: Config = { enabled: true, model: DEFAULT_MODEL, timeoutSeconds: 10, patterns: DEFAULT_PATTERNS }
export const TIMEOUT_MIN = 2
export const TIMEOUT_MAX = 60

/** The settings from the plugin's options; a value that cannot be used keeps the default and is reported. */
export function resolveConfig(options: Readonly<Record<string, unknown>>): { config: Config; problems: string[] } {
  const config: Config = { ...DEFAULTS }
  const problems: string[] = []
  if (typeof options.enabled === 'boolean') config.enabled = options.enabled
  if (typeof options.model === 'string' && options.model.trim() !== '') config.model = options.model.trim()
  if (options.timeoutSeconds !== undefined && options.timeoutSeconds !== '') {
    const raw = typeof options.timeoutSeconds === 'string' ? Number(options.timeoutSeconds) : options.timeoutSeconds
    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= TIMEOUT_MIN && raw <= TIMEOUT_MAX) config.timeoutSeconds = raw
    else problems.push(`timeoutSeconds: ${JSON.stringify(options.timeoutSeconds)} is not ${TIMEOUT_MIN} to ${TIMEOUT_MAX}; using ${DEFAULTS.timeoutSeconds}`)
  }
  if (typeof options.testPatterns === 'string' && options.testPatterns.trim() !== '') {
    const patterns = splitPatterns(options.testPatterns)
    if (patterns.length > 0) config.patterns = patterns
  }
  return { config, problems }
}

export function splitPatterns(text: string): string[] {
  return text.split(',').map(p => p.trim().replace(/\s+/g, ' ')).filter(p => p !== '')
}

// What runs a command without being it: stripped before matching.
const RUNNERS = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+|(?:npx|bunx|sudo|pnpm dlx|pnpm exec|yarn dlx|uv run|poetry run|pipenv run|bundle exec|time|nice|exec|env|command)(?:\s+-\S+)*\s+|timeout\s+\S+\s+|python3?\s+-m\s+)/
const PACKAGE_MANAGER = /^(?:npm|pnpm|yarn|bun)\b\s*/
// A package manager's options that pick a folder or a workspace, with their values: stripped too.
const PM_OPTIONS = /^(?:(?:-C|--prefix|--dir|--cwd|--filter|-F|--workspace)(?:=|\s+)\S+|workspace\s+\S+|-w|-r|-s|--recursive|--silent|--if-present)\s*/
// A command the shell runs from a string: `bash -c "npm test"`.
const SHELL_C = /\b(?:ba|z)?sh\s+-c\s+(["'])(.*?)\1/g
// A heredoc's body is text, not commands: a commit message that mentions `npm test` runs nothing.
const HEREDOC = /<<-?\s*(["']?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2[ \t]*(?=\n|$)/g

/**
 * The command a part comes to once runners and folder options are stripped. A package manager's
 * scripts come out as `pm:<script>`, whichever manager ran them and whether `run` was said, so
 * `pnpm -C pkg lint` and `npm run lint` meet; `also` is the rest run as a tool (`pnpm vitest run`).
 */
function canonical(part: string): { cmd: string; also?: string } {
  let cmd = part.trim().replace(/^\(+\s*/, '').replace(/\s*\)+$/, '').replace(/\s+/g, ' ')
  for (let prev = ''; prev !== cmd; ) {
    prev = cmd
    cmd = cmd.replace(RUNNERS, '')
  }
  if (!PACKAGE_MANAGER.test(cmd)) return { cmd }
  let rest = cmd.replace(PACKAGE_MANAGER, '')
  for (let prev = ''; prev !== rest; ) {
    prev = rest
    rest = rest.replace(PM_OPTIONS, '')
  }
  rest = rest.replace(/^(?:run|run-script)\s+/, '')
  for (let prev = ''; prev !== rest; ) {
    prev = rest
    rest = rest.replace(PM_OPTIONS, '')
  }
  return { cmd: `pm:${rest}`, also: rest }
}

/**
 * Whether a Bash command runs a test or check: any of its `&&`, `;`, `|` parts (and the string of a
 * `bash -c`) starts with a pattern. Quoted text and heredoc bodies are not commands, and a part that
 * only asks for a version or help runs nothing.
 */
export function isTestCommand(command: string, patterns: readonly string[]): boolean {
  const wanted = patterns.map(p => canonical(p).cmd)
  const text = command
    .replace(HEREDOC, '')
    .replace(SHELL_C, (_, _q: string, inner: string) => `; ${inner} ;`)
    .replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""')
  for (const raw of text.split(/&&|\|\||[;|\n]/)) {
    const { cmd, also } = canonical(raw)
    if (/\s--(?:version|help)\b/.test(` ${cmd}`)) continue
    const starts = (c: string, p: string) => c === p || c.startsWith(`${p} `) || c.startsWith(`${p}:`)
    if (wanted.some(p => starts(cmd, p) || (also !== undefined && starts(also, p)))) return true
  }
  return false
}

const NO_TESTS = [
  /\b(?:don'?t|do not|dont|no need to|never|without)\s+(?:run(?:ning)?\s+|writ(?:e|ing)\s+|add(?:ing)?\s+)?(?:any\s+|the\s+)?(?:tests?|testing|checks?)\b/i,
  // "skip the tests", but not "don't skip the tests".
  /(?<!\b(?:don'?t|do not|dont|never|not)\s+)\bskip(?:ping)?\s+(?:any\s+|the\s+)?(?:tests?|testing|checks?)\b/i,
  // "no tests", but not a report of a run: "no tests ran", "no tests found".
  /\bno\s+(?:tests?|testing)\b(?!\s+(?:ran|run|were|was|are|is|found|exist|existed|matched|match|collected|selected|passed|failed|executed))/i,
  /\b(?:tests?|testing)\s+(?:are\s+|is\s+)?not\s+needed\b/i,
]

/** Whether the user's prompt said not to run tests ("don't run tests", "no tests", "skip the tests"). */
export function saysNoTests(prompt: string): boolean {
  return NO_TESTS.some(re => re.test(prompt.replace(/[’‘]/g, "'")))
}

const NOT_CODE_EXT = new Set([
  'md', 'mdx', 'markdown', 'txt', 'rst', 'adoc', 'org', 'tex',
  'json', 'jsonc', 'json5', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'properties', 'xml', 'plist',
  'lock', 'csv', 'tsv', 'log', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'pdf',
])
const NOT_CODE_NAMES = new Set(['license', 'licence', 'notice', 'authors', 'codeowners', 'readme', 'changelog', '.gitignore', '.gitattributes', '.editorconfig', '.npmrc', '.nvmrc', '.prettierrc', '.dockerignore'])

/** Whether a file is code by the code-only rule: anything that is not docs, config, data or an image. */
export function isCodeFile(path: string): boolean {
  const name = path.split(/[/\\]/).pop()!.toLowerCase()
  if (NOT_CODE_NAMES.has(name)) return false
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return true
  return !NOT_CODE_EXT.has(name.slice(dot + 1))
}

export type Edit = { tool: string; path: string; summary: string }

/** One edit as the model reads it: the tool and the change, cut to `max` characters. */
export function describeEdit(tool: string, input: Readonly<Record<string, unknown>>, max = 300): Edit | undefined {
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')
  const path = str('file_path') || str('notebook_path')
  if (path === '') return undefined
  let change: string
  if (tool === 'Edit') change = `- ${oneLine(str('old_string'))}\n+ ${oneLine(str('new_string'))}`
  else if (tool === 'Write') change = `(whole file) ${oneLine(str('content'))}`
  else change = `(cell ${str('edit_mode') || 'replace'}) ${oneLine(str('new_source'))}`
  return { tool, path, summary: clip(`${tool} ${path}\n${change}`, max) }
}

/** The caps on what one question to the model carries, in characters. */
export const CAPS = { paths: 1_000, edits: 3_000, prompt: 1_000, answer: 1_000 } as const
/** The most the question can come to, the instructions included. */
export const MAX_INPUT_CHARS = CAPS.paths + CAPS.edits + CAPS.prompt + CAPS.answer + 1_200

export const SYSTEM = [
  'You decide whether a coding assistant must run tests before it ends its turn.',
  'The assistant edited files this turn and ran no test, type check, linter or build.',
  'Answer yes when the edits change code whose behaviour a test or check could catch breaking.',
  'Answer no when the edits are docs, comments, config, data or text only, when the change is trivial and cannot break anything, when the project plainly has nothing to run, or when the assistant already explained why it did not test.',
  'Reply with exactly three lines and nothing else:',
  'ANSWER: yes or no',
  'REASON: one short line',
  'COMMAND: exactly one shell command to run (no && chains, no alternatives), or none',
].join('\n')

export type Question = { paths: readonly string[]; edits: readonly Edit[]; prompt: string; answer: string }

/** The user message for the model: the edited paths, the edits, the user's prompt and Claude's last message, each capped. */
export function questionText(q: Question): string {
  return [
    `Edited files:\n${clip(q.paths.join('\n'), CAPS.paths)}`,
    `The edits:\n${clip(q.edits.map(e => e.summary).join('\n\n'), CAPS.edits)}`,
    `The user's request:\n${clip(q.prompt.trim() || '(none)', CAPS.prompt)}`,
    `The assistant's last message:\n${clip(q.answer.trim() || '(none)', CAPS.answer)}`,
  ].join('\n\n')
}

export type Verdict = { needsTests: boolean; reason: string; command: string }

/** The model's reply read strictly: a yes or a no on its ANSWER line (or first line), else undefined. */
export function parseVerdict(text: string): Verdict | undefined {
  const lines = text.split(/\r?\n/).map(l => l.trim().replace(/^[*_`#>\s-]+/, '').replace(/[*_`]+(?=\s*:)/, '')).filter(l => l !== '')
  if (lines.length === 0) return undefined
  const field = (key: string) => lines.find(l => new RegExp(`^${key}\\s*:`, 'i').test(l))?.replace(/^[^:]*:\s*/, '')
  const answer = (field('answer') ?? lines[0]!).toLowerCase().replace(/[*_`"'.!]/g, '').trim()
  const yesNo = /^(yes|no)\b/.exec(answer)?.[1]
  if (yesNo === undefined) return undefined
  const command = cleanCommand(field('command') ?? '')
  return { needsTests: yesNo === 'yes', reason: clip(oneLine(field('reason') ?? ''), 200), command }
}

function cleanCommand(text: string): string {
  const c = oneLine(text).replace(/`/g, '').trim()
  return /^(none|n\/a|-|)$/i.test(c) ? '' : clip(c, 160)
}

export type Decision =
  | { nudge: false; why: string }
  | { nudge: true; why: string; reason: string; command: string; byModel: boolean }

/** The code-only rule, used when the model gives no usable answer: code edited and no test run, nudge. */
export function fallback(paths: readonly string[], why: string): Decision {
  return paths.some(isCodeFile)
    ? { nudge: true, why: `${why}; code-only rule: code edited`, reason: '', command: '', byModel: false }
    : { nudge: false, why: `${why}; code-only rule: no code edited` }
}

/** The note Claude reads when its turn is kept going. */
export function noteFor(paths: readonly string[], d: Extract<Decision, { nudge: true }>): string {
  const shown = paths.slice(0, 5).map(p => p.split(/[/\\]/).pop()).join(', ')
  const more = paths.length > 5 ? ` and ${paths.length - 5} more` : ''
  const files = `${paths.length === 1 ? 'a file' : `${paths.length} files`} (${shown}${more})`
  const run = d.command !== '' ? `Run the relevant tests or checks (for example \`${d.command}\`)` : 'Run the relevant tests or checks'
  const why = d.reason !== '' ? ` Why: ${d.reason}` : ''
  return `${$name}: You edited ${files} this turn and ran no test or check. ${run}, or say in one line why they are not needed, then finish.${why}`
}

export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}
