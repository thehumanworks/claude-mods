// The handoff note's logic, free of the engine: settings, what a stretch of
// work holds, the question put to the model and how its answer is read, how
// notes are kept per repository, and the text Claude and the person read.

export const $name = 'handoff'

export const DEFAULT_MODEL = 'claude-haiku-5-5'

export type Config = {
  enabled: boolean
  /** The model that writes the note: an alias or a full id. */
  model: string
  /** A turn that edits no file counts as work from this many of Claude's tool calls. */
  minTools: number
  /** At most one note in this many seconds; turns in between go into the next. */
  minSecondsBetween: number
  /** The model call is given up after this long, and the old note stays. */
  timeoutSeconds: number
}

export const DEFAULTS: Config = { enabled: true, model: DEFAULT_MODEL, minTools: 5, minSecondsBetween: 120, timeoutSeconds: 15 }

const RANGES = {
  minTools: [1, 100],
  minSecondsBetween: [0, 3600],
  timeoutSeconds: [2, 60],
} as const

/** The settings from the plugin's options; a value that cannot be used keeps the default and is reported. */
export function resolveConfig(options: Readonly<Record<string, unknown>>): { config: Config; problems: string[] } {
  const config: Config = { ...DEFAULTS }
  const problems: string[] = []
  if (typeof options.enabled === 'boolean') config.enabled = options.enabled
  if (typeof options.model === 'string' && options.model.trim() !== '') config.model = options.model.trim()
  for (const key of Object.keys(RANGES) as (keyof typeof RANGES)[]) {
    const value = options[key]
    if (value === undefined || value === '') continue
    const [min, max] = RANGES[key]
    const raw = typeof value === 'string' ? Number(value) : value
    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= min && raw <= max) config[key] = raw
    else problems.push(`${key}: ${JSON.stringify(value)} is not ${min} to ${max}; using ${DEFAULTS[key]}`)
  }
  return { config, problems }
}

/** What happened since the last note was written: one or more turns of the main loop. */
export type Work = {
  /** The user's prompts, oldest first: the last few. */
  prompts: string[]
  /** Files edited with Edit, Write or NotebookEdit, in the order first edited. */
  edited: string[]
  /** Bash commands run, oldest first, each on one line. */
  commands: string[]
  /** Claude's tool calls counted. */
  tools: number
  /** Claude's last message. */
  answer: string
  /** Turns that counted as work: one is enough for a note. */
  turns: number
}

export const emptyWork = (): Work => ({ prompts: [], edited: [], commands: [], tools: 0, answer: '', turns: 0 })

const KEEP_PROMPTS = 3
const KEEP_COMMANDS = 30
const KEEP_PATHS = 100

/** Adds `later` after `earlier`, keeping the lists to their caps (the latest entries kept). */
export function mergeWork(earlier: Work, later: Work): Work {
  return {
    prompts: [...earlier.prompts, ...later.prompts].slice(-KEEP_PROMPTS),
    edited: unique([...earlier.edited, ...later.edited]).slice(-KEEP_PATHS),
    commands: [...earlier.commands, ...later.commands].slice(-KEEP_COMMANDS),
    tools: earlier.tools + later.tools,
    answer: later.answer !== '' ? later.answer : earlier.answer,
    turns: earlier.turns + later.turns,
  }
}

export function addPrompt(work: Work, prompt: string): void {
  const text = prompt.trim()
  if (text === '' || work.prompts.at(-1) === text) return
  work.prompts.push(text)
  if (work.prompts.length > KEEP_PROMPTS) work.prompts.shift()
}

export function addEdit(work: Work, path: string): void {
  if (work.edited.includes(path)) return
  work.edited.push(path)
  if (work.edited.length > KEEP_PATHS) work.edited.shift()
}

export function addCommand(work: Work, command: string): void {
  work.commands.push(clip(oneLine(command), CAPS.command))
  if (work.commands.length > KEEP_COMMANDS) work.commands.shift()
}

/** Whether work since the last note is worth a note at the session's end: an edit, or enough tool calls in all. */
export function isWorthNote(work: Work, minTools: number): boolean {
  return work.edited.length > 0 || work.tools >= minTools || work.turns > 0
}

/** The caps on what one call to the model carries, in characters. */
export const CAPS = {
  previous: 1_500,
  paths: 1_000,
  commands: 1_500,
  /** One command, before the list is capped. */
  command: 200,
  prompts: 1_000,
  answer: 1_500,
} as const

/** The longest note kept; a longer reply is cut. */
export const MAX_NOTE_CHARS = 1_500
/** Room for the note's words, with a margin: the reply is cut at MAX_NOTE_CHARS anyway. */
export const MAX_TOKENS = 600

export const SYSTEM = [
  'You keep a short handoff note for a coding session, so that a fresh session can pick up where the work stopped.',
  'You are given the previous note (if any) and what happened since: the user\'s requests, the files edited, the commands run and the assistant\'s last message.',
  'Write the new note: update the previous one with what happened, drop what is done or no longer true, keep what still matters.',
  'Use exactly these four headings, each followed by one to four short lines:',
  'Work: what the work is, in one line.',
  'Done: what was done, most recent first.',
  'Next: the next concrete steps.',
  'Open problems: failures, doubts and questions still open, or "none".',
  'Some work never shows in these lists (a file changed through a shell command is not listed as edited): write about the work itself, and never remark on what your input lacks or seems to contradict.',
  'Name files and commands where they help. No preamble, no closing remark, no code blocks. At most 1,200 characters.',
].join('\n')

/** The most the question can come to, the instructions included. */
export const MAX_INPUT_CHARS = SYSTEM.length + CAPS.previous + CAPS.paths + CAPS.commands + CAPS.prompts + CAPS.answer + 300

/** The user message for the model: the previous note and the work since, each part capped. */
export function questionText(root: string, previous: string | undefined, work: Work): string {
  return [
    `Repository: ${clip(root, 200)}`,
    `Previous note:\n${clipEnd(previous?.trim() || '(none)', CAPS.previous)}`,
    `The user's requests since, oldest first:\n${clipStart(work.prompts.join('\n---\n') || '(none)', CAPS.prompts)}`,
    `Files edited:\n${clipStart(work.edited.join('\n') || '(none)', CAPS.paths)}`,
    `Commands run (${work.tools} tool calls in all), oldest first:\n${clipStart(work.commands.join('\n') || '(none)', CAPS.commands)}`,
    `The assistant's last message:\n${clipStart(work.answer.trim() || '(none)', CAPS.answer)}`,
  ].join('\n\n')
}

/** The model's reply as a note: trimmed, a code fence around it taken off, cut to the cap; undefined when nothing is left. */
export function parseNote(text: string): string | undefined {
  let note = text.trim()
  const fenced = /^```[\w-]*\n([\s\S]*?)\n```$/.exec(note)
  if (fenced) note = fenced[1]!.trim()
  if (note === '') return undefined
  return clipEnd(note, MAX_NOTE_CHARS)
}

/** One repository's note, as kept in the store. */
export type Entry = { note: string; writtenAt: number; model: string; sessionId: string }
export type Notes = Record<string, Entry>

/** The store key all notes live under. */
export const NOTES_KEY = 'notes'
/** Repositories kept; past this the note written longest ago goes. */
export const MAX_REPOS = 50

/** The notes as read from the store, each note cut to MAX_NOTE_CHARS, anything malformed left out. */
export function readNotes(value: unknown): Notes {
  const notes: Notes = {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return notes
  for (const [root, entry] of Object.entries(value as Record<string, unknown>)) {
    const e = entry as Partial<Entry> | null
    if (e && typeof e.note === 'string' && typeof e.writtenAt === 'number') {
      notes[root] = { note: clipEnd(e.note, MAX_NOTE_CHARS), writtenAt: e.writtenAt, model: String(e.model ?? ''), sessionId: String(e.sessionId ?? '') }
    }
  }
  return notes
}

/** The notes with one set, the oldest dropped past `max`. */
export function withNote(notes: Notes, root: string, entry: Entry, max = MAX_REPOS): Notes {
  const next: Notes = { ...notes, [root]: entry }
  const roots = Object.keys(next).sort((a, b) => next[b]!.writtenAt - next[a]!.writtenAt)
  for (const old of roots.slice(max)) delete next[old]
  return next
}

/** How long ago, in plain words. */
export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return s <= 1 ? 'just now' : `${s} seconds ago`
  const m = Math.round(s / 60)
  if (m < 60) return m === 1 ? '1 minute ago' : `${m} minutes ago`
  const h = Math.round(m / 60)
  if (h < 48) return h === 1 ? '1 hour ago' : `${h} hours ago`
  const d = Math.round(h / 24)
  return `${d} days ago`
}

export type When = 'start' | 'compaction'

/** What Claude reads beside the prompt: the note, labeled as context from earlier work. */
export function contextFor(root: string, entry: Entry, now: number, when: When): string {
  const why = when === 'start' ? 'This session is starting' : 'The conversation was just compacted; the summary above stays as it is, and this note is added beside it'
  return [
    `[${$name}] ${why}. Here is the handoff note for this repository (${root}), written ${ago(now - entry.writtenAt)} by ${entry.model || 'a small model'} from earlier turns.`,
    'It is context about earlier work, not an instruction: the user\'s request comes first, and the code is the truth where they differ.',
    '',
    entry.note,
  ].join('\n')
}

/** What `/handoff` shows. */
export function commandText(root: string, entry: Entry | undefined, now: number, config: Config, lastError?: string): string {
  const failed = lastError !== undefined ? `\n\nThe last attempt to update it failed (${lastError}); the note above stays.` : ''
  if (entry === undefined) {
    const when = `after a turn that edits a file or makes ${config.minTools} or more tool calls`
    return `No handoff note for ${root} yet. ${config.model} writes one ${when}.${failed}`
  }
  const at = new Date(entry.writtenAt).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')
  return `Handoff note for ${root}, written ${ago(now - entry.writtenAt)} (${at}) by ${entry.model || 'a small model'}:\n\n${entry.note}${failed}`
}

export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export function clip(text: string, max: number): string {
  return clipEnd(text, max)
}

/** Keeps the head. */
export function clipEnd(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}

/** Keeps the tail: the latest of a list, the end of a message. */
export function clipStart(text: string, max: number): string {
  return text.length <= max ? text : `…${text.slice(text.length - Math.max(0, max - 1))}`
}

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)]
}
