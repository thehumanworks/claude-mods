// The report diet's logic, free of the engine: settings, how a long report is
// cut, and where its whole text is saved.

export const $name = 'report-diet'

export type Config = {
  enabled: boolean
  /** A report longer than this is cut. */
  maxChars: number
  /** Characters kept from the start of a cut report. */
  headChars: number
  /** Characters kept from the end of a cut report. */
  tailChars: number
  /** Subagent types never cut, compared without case. */
  exclude: string[]
}

/** Explore and Plan answers are search results and plans the parent is meant to read in full. */
export const DEFAULT_EXCLUDE = ['Explore', 'Plan']
/**
 * 4,000: in the session that prompted this mod, 21 reports averaged 6,000 characters (8,800 at most),
 * so most of them are over it, while a short answer is never touched. A cut report comes to about
 * 3,500 characters (2,500 head, 800 tail, the marker), roughly half of an average one.
 */
export const DEFAULTS: Config = { enabled: true, maxChars: 4000, headChars: 2500, tailChars: 800, exclude: DEFAULT_EXCLUDE }
export const RANGES = {
  maxChars: { min: 1000, max: 100_000 },
  headChars: { min: 200, max: 100_000 },
  tailChars: { min: 0, max: 100_000 },
} as const

/** Files kept in the save folder at most, and for how long. */
export const FILES_MAX = 200
export const FILE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
export const FILE_RE = /^agent-[A-Za-z0-9_-]+\.md$/

function numberOption(raw: unknown): number | undefined {
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw
  return typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : undefined
}

/** The settings from the plugin's options; a value that cannot be used keeps the default and is reported. */
export function resolveConfig(options: Readonly<Record<string, unknown>>): { config: Config; problems: string[] } {
  const config: Config = { ...DEFAULTS }
  const problems: string[] = []
  if (typeof options.enabled === 'boolean') config.enabled = options.enabled
  for (const key of ['maxChars', 'headChars', 'tailChars'] as const) {
    const raw = options[key]
    if (raw === undefined || raw === '') continue
    const n = numberOption(raw)
    const range = RANGES[key]
    if (n !== undefined && n >= range.min && n <= range.max) config[key] = n
    else problems.push(`${key}: ${JSON.stringify(raw)} is not ${range.min} to ${range.max}; using ${DEFAULTS[key]}`)
  }
  // What is kept must be well under the limit, or cutting saves nothing.
  if (config.headChars + config.tailChars > config.maxChars * 0.9) {
    const head = Math.round(config.maxChars * 0.6)
    const tail = Math.round(config.maxChars * 0.2)
    problems.push(`headChars ${config.headChars} + tailChars ${config.tailChars} is over 90% of maxChars ${config.maxChars}; using ${head} and ${tail}`)
    config.headChars = head
    config.tailChars = tail
  }
  if (typeof options.exclude === 'string') config.exclude = splitList(options.exclude)
  return { config, problems }
}

export function splitList(text: string): string[] {
  return text.split(',').map(s => s.trim()).filter(s => s !== '')
}

/** Whether a subagent type is excluded. No type given means general-purpose. */
export function isExcluded(agentType: string | undefined, exclude: readonly string[]): boolean {
  const t = (agentType === undefined || agentType === '' ? 'general-purpose' : agentType).toLowerCase()
  return exclude.some(x => x.toLowerCase() === t)
}

/** The saved file's name, from the tool_use_id: safe on every platform. */
export function fileNameFor(toolUseId: string): string {
  const safe = toolUseId.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 80)
  return `agent-${safe === '' ? 'call' : safe}.md`
}

/** The start of a report, ended at a line break when one is near the cut. */
function headOf(text: string, n: number): string {
  const head = text.slice(0, n)
  const nl = head.lastIndexOf('\n')
  return nl >= n * 0.8 ? head.slice(0, nl) : head
}

/** The end of a report, started at a line break when one is near the cut. */
function tailOf(text: string, n: number): string {
  if (n <= 0) return ''
  const tail = text.slice(text.length - n)
  const nl = tail.indexOf('\n')
  return nl >= 0 && nl <= n * 0.2 ? tail.slice(nl + 1) : tail
}

/** The report as the parent reads it: the head, a marker with the file's path, the tail. */
export function cut(text: string, path: string, config: Pick<Config, 'headChars' | 'tailChars'>): string {
  const head = headOf(text, config.headChars)
  const tail = tailOf(text, config.tailChars)
  const left = text.length - head.length - tail.length
  const marker = `[${$name}: ${left.toLocaleString('en-US')} of ${text.length.toLocaleString('en-US')} characters cut here. The whole report is in ${path}; Read it if you need the part cut out.]`
  return tail === '' ? `${head}\n\n${marker}` : `${head}\n\n${marker}\n\n${tail}`
}

/** A file's text with the report, and where it came from, for whoever opens it. */
export function fileText(report: string, about: { description?: string; agentType?: string }): string {
  const what = [about.agentType, about.description].filter(s => s !== undefined && s !== '').join(': ')
  return `<!-- ${$name}: the whole report of a subagent${what === '' ? '' : ` (${what.replace(/--+/g, '-')})`} -->\n\n${report}`
}

/** The whole report in an Agent tool record: its text blocks, joined. Undefined when there is none. */
export function reportOf(record: unknown): string | undefined {
  if (record === null || typeof record !== 'object') return undefined
  const r = record as { status?: unknown; content?: unknown }
  if (r.status !== 'completed' || !Array.isArray(r.content) || r.content.length === 0) return undefined
  const texts: string[] = []
  for (const block of r.content as unknown[]) {
    if (block === null || typeof block !== 'object' || (block as { type?: unknown }).type !== 'text') return undefined
    const t = (block as { text?: unknown }).text
    if (typeof t !== 'string') return undefined
    texts.push(t)
  }
  return texts.join('\n')
}

/** A background agent's notification, as the parent reads it: the call it reports on, its status, its result. */
export type Notification = { toolUseId: string; status: string; result: string; start: number; end: number }

/** Reads a `<task-notification>` text; undefined when it has no tool-use id or no result. */
export function parseNotification(text: string): Notification | undefined {
  if (!text.includes('<task-notification>')) return undefined
  const id = /<tool-use-id>([^<\s]+)<\/tool-use-id>/.exec(text)?.[1]
  const status = /<status>([^<]*)<\/status>/.exec(text)?.[1]?.trim() ?? ''
  const open = text.indexOf('<result>')
  const close = text.lastIndexOf('</result>')
  if (id === undefined || open < 0 || close < open) return undefined
  const start = open + '<result>'.length
  return { toolUseId: id, status, result: text.slice(start, close), start, end: close }
}
