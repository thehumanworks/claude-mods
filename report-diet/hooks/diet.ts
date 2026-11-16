// The report diet's logic, free of the engine: settings, which answers are
// held, and the note the subagent reads when its stop is held.

export const $name = 'report-diet'

export type Config = {
  enabled: boolean
  /** A final answer longer than this is held once. */
  maxChars: number
  /** The most the summary asked for may be. */
  summaryChars: number
  /** Subagent types never held, compared without case. */
  exclude: string[]
}

/**
 * Explore and Plan are read-only: they have no Write tool, so they could not write the file, and
 * what they find is meant to be read in full by the agent that asked.
 */
export const DEFAULT_EXCLUDE = ['Explore', 'Plan']
export const DEFAULTS: Config = { enabled: true, maxChars: 2000, summaryChars: 1500, exclude: DEFAULT_EXCLUDE }
export const MAX_CHARS = { min: 200, max: 100_000 } as const
export const SUMMARY_CHARS = { min: 100, max: 100_000 } as const

function numberOption(raw: unknown): number | undefined {
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw
  return typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : undefined
}

/** The settings from the plugin's options; a value that cannot be used keeps the default and is reported. */
export function resolveConfig(options: Readonly<Record<string, unknown>>): { config: Config; problems: string[] } {
  const config: Config = { ...DEFAULTS }
  const problems: string[] = []
  if (typeof options.enabled === 'boolean') config.enabled = options.enabled
  for (const [key, range] of [['maxChars', MAX_CHARS], ['summaryChars', SUMMARY_CHARS]] as const) {
    const raw = options[key]
    if (raw === undefined || raw === '') continue
    const n = numberOption(raw)
    if (n !== undefined && n >= range.min && n <= range.max) config[key] = n
    else problems.push(`${key}: ${JSON.stringify(raw)} is not ${range.min} to ${range.max}; using ${DEFAULTS[key]}`)
  }
  if (config.summaryChars > config.maxChars) {
    problems.push(`summaryChars: ${config.summaryChars} is more than maxChars ${config.maxChars}; using ${config.maxChars}`)
    config.summaryChars = config.maxChars
  }
  if (typeof options.exclude === 'string') config.exclude = splitList(options.exclude)
  return { config, problems }
}

export function splitList(text: string): string[] {
  return text.split(',').map(s => s.trim()).filter(s => s !== '')
}

export function isExcluded(agentType: string | undefined, exclude: readonly string[]): boolean {
  if (agentType === undefined || agentType === '') return false
  const t = agentType.toLowerCase()
  return exclude.some(x => x.toLowerCase() === t)
}

// An answer that is an error or an interruption, not a report: never held.
const NOT_A_REPORT = [
  /^API Error\b/i,
  /^\[?Request interrupted\b/i,
  /^Error:/,
  /^(?:Prompt is too long|Credit balance is too low|Invalid API key)\b/i,
]

/** Whether the answer reads as an error or an interruption rather than a report. */
export function isErrorAnswer(answer: string): boolean {
  const head = answer.trimStart().slice(0, 200)
  return NOT_A_REPORT.some(re => re.test(head))
}

/**
 * A file name safe on every platform, from the agent's id. It must not start with REPORT, SUMMARY,
 * FINDINGS or ANALYSIS and end in .md: Claude Code's Write tool refuses such a name from a subagent.
 */
export function fileNameFor(agentId: string): string {
  const safe = agentId.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
  return `subagent-${safe === '' ? 'agent' : safe}-full.md`
}

/** The note the subagent reads when its stop is held. */
export function noteFor(agentId: string, length: number, config: Config): string {
  const file = fileNameFor(agentId)
  return [
    `${$name}: Your final answer is ${length.toLocaleString('en-US')} characters, over the ${config.maxChars.toLocaleString('en-US')} the agent that started you takes in full.`,
    `1. Write your full report, unchanged, to a file named \`${file}\`: in your scratchpad directory if your instructions name one, otherwise in the system temp directory (\`$TMPDIR\` or \`/tmp\`; \`%TEMP%\` on Windows). Use an absolute path.`,
    `2. Then reply with a summary of at most ${config.summaryChars.toLocaleString('en-US')} characters: start with the conclusion, keep only what the caller needs to act, and end with the file's absolute path on its own line.`,
    'Do not do any other work. If you cannot write the file, reply with the summary alone.',
  ].join('\n')
}
