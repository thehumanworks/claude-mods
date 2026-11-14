// The mod's settings, and what each compaction level comes to in numbers.

export type LevelName = 'aggressive' | 'balanced' | 'soft'

/** What a compaction level means, concretely. */
export type Level = {
  /** The summary's length limit, in words. */
  maxWords: number
  /**
   * How much of the conversation from before the background trigger also stays
   * raw, as a percentage of Claude Code's auto-compact limit. At 0 the summary
   * covers everything up to the trigger, and only what came after stays raw.
   */
  keepPercent: number
  /** Each tool input and tool result is cut to this many characters before the compaction model reads it. */
  toolChars: number
  /** Each of the user's own messages quoted after the summary is cut to this many characters. */
  quoteChars: number
  /** All quoted user messages together come to at most this many characters; the oldest go first. */
  quoteTotalChars: number
}

export const LEVELS: Record<LevelName, Level> = {
  aggressive: { maxWords: 500, keepPercent: 0, toolChars: 1000, quoteChars: 300, quoteTotalChars: 2000 },
  balanced: { maxWords: 1200, keepPercent: 0, toolChars: 1500, quoteChars: 800, quoteTotalChars: 6000 },
  soft: { maxWords: 2500, keepPercent: 15, toolChars: 2500, quoteChars: 2000, quoteTotalChars: 16000 },
}

export type Config = {
  enabled: boolean
  /** Model that writes the summary: an alias or a full id. */
  model: string
  /** The background trigger, as a percentage of the auto-compact limit: always below 100. */
  triggerAt: number
  level: LevelName
  /** Replaces the built-in compaction prompt when not empty. */
  prompt: string
  /** A file whose text replaces the compaction prompt; wins over `prompt`. */
  promptFile?: string
  /** Archive what is summarized, cite it in the summary, and offer the recall tool. */
  recall: boolean
}

export const TRIGGER_MIN = 10
export const TRIGGER_MAX = 95

export const DEFAULTS: Config = {
  enabled: true,
  model: 'haiku',
  triggerAt: 75,
  level: 'balanced',
  prompt: '',
  recall: true,
}

/**
 * The settings from the plugin's options, as /config stores them. A value that
 * cannot be used keeps the default and is reported in `problems`: above all a
 * trigger at or past 100%, which would start the summary only once Claude Code
 * is already compacting.
 */
export function resolveConfig(options: Readonly<Record<string, unknown>>): { config: Config; problems: string[] } {
  const config: Config = { ...DEFAULTS }
  const problems: string[] = []
  const bad = (key: string, why: string) => problems.push(`${key}: ${JSON.stringify(options[key])} ${why}`)

  if (typeof options.enabled === 'boolean') config.enabled = options.enabled
  if (typeof options.recall === 'boolean') config.recall = options.recall
  if (typeof options.model === 'string' && options.model.trim() !== '') config.model = options.model.trim()
  if (typeof options.prompt === 'string') config.prompt = options.prompt
  if (typeof options.promptFile === 'string' && options.promptFile.trim() !== '') config.promptFile = options.promptFile.trim()

  if (options.level !== undefined && options.level !== '') {
    if (typeof options.level === 'string' && options.level in LEVELS) config.level = options.level as LevelName
    else bad('level', `is not a level (aggressive, balanced, soft); using ${DEFAULTS.level}`)
  }

  if (options.triggerAt !== undefined && options.triggerAt !== '') {
    const raw = typeof options.triggerAt === 'string' ? Number(options.triggerAt.replace(/%\s*$/, '')) : options.triggerAt
    if (typeof raw !== 'number' || !Number.isFinite(raw)) bad('triggerAt', `is not a percentage; using ${DEFAULTS.triggerAt}`)
    else if (raw >= 100) bad('triggerAt', `must be below the auto-compact limit (100); using ${DEFAULTS.triggerAt}`)
    else if (raw < TRIGGER_MIN || raw > TRIGGER_MAX) bad('triggerAt', `is outside ${TRIGGER_MIN} to ${TRIGGER_MAX}; using ${DEFAULTS.triggerAt}`)
    else config.triggerAt = raw
  }
  return { config, problems }
}
