// The recall tool: what the model reads about it, and the pure parts of
// archiving summarized messages and answering from the archive.

import { idsOf, isSummary, type Message } from './transcript.js'

/** One summarized message as the archive keeps it, word for word. */
export type Archived = {
  id: number
  role: 'user' | 'assistant'
  text: string
  toolUses?: { tool: string; input: Record<string, unknown> }[]
  toolResults?: { text: string; isError?: boolean }[]
}

/** One archive file: the messages `from` to `to`, both included. */
export type Segment = { from: number; to: number; file: string }

/** One file stays well under what `$.fs.read` takes (4 MiB). */
export const SEGMENT_CHARS = 1_500_000
/** How much one recall answer holds; the rest is read on with `offset`. */
export const ANSWER_CHARS = 16_000
const MAX_AROUND = 10
const MAX_HITS = 12

export const RECALL = {
  name: 'recall',
  description: [
    'Reads back, word for word, messages of this conversation that compaction replaced with a summary: what the user said, what you said, ' +
      'the tool calls you made and what they returned.',
    '',
    'The summary at the top of your context cites the messages its statements come from as bracketed ids, like [m412]:',
    '- ref: "m412" returns that message; "m412-m420" a range; around: 2 adds the messages either side.',
    '- query: "words" searches every summarized message and lists the ones that hold all the words, each with its id, to read with ref.',
    '',
    'The summary is meant to be enough to carry on. Use this only when the task in front of you depends on an exact detail the summary ' +
      'does not give: exact wording, a number, a path, code as it was written, the output of a command. Do not use it to re-read what the ' +
      'summary already tells you, or before you know which detail you are missing.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      ref: { type: 'string', description: 'A message id as the summary cites it, "m412", or a range, "m412-m420".' },
      around: { type: 'integer', minimum: 0, maximum: MAX_AROUND, description: 'With ref: messages either side to read as well. Default 0.' },
      query: { type: 'string', description: 'In place of ref: words to find; a message must hold all of them. Case does not matter.' },
      offset: { type: 'integer', minimum: 0, description: 'Where to read on from, in characters, as a long answer said.' },
    },
    additionalProperties: false,
  },
} as const

/** The archive entries for `messages`, ids counted from `base`; a summary takes none. */
export function toArchive(messages: readonly Message[], base: number): Archived[] {
  const ids = idsOf(messages, base)
  const entries: Archived[] = []
  messages.forEach((m, i) => {
    if (isSummary(m)) return
    const entry: Archived = { id: ids[i]!, role: m.role, text: m.text }
    if (m.toolUses?.length) entry.toolUses = m.toolUses.map(use => ({ tool: use.tool, input: use.input }))
    if (m.toolResults?.length) entry.toolResults = m.toolResults.map(r => ({ text: r.text ?? '', ...(r.isError ? { isError: true } : {}) }))
    entries.push(entry)
  })
  return entries
}

/** Splits entries into files of at most about `maxChars` of JSON each, in order. */
export function toSegments(entries: readonly Archived[], maxChars = SEGMENT_CHARS): { from: number; to: number; json: string }[] {
  const segments: { from: number; to: number; json: string }[] = []
  let current: string[] = []
  let size = 0
  let from = entries[0]?.id ?? 0
  const flush = (to: number) => {
    if (current.length > 0) segments.push({ from, to, json: `[${current.join(',\n')}]` })
    current = []
    size = 0
  }
  for (const entry of entries) {
    const json = JSON.stringify(entry)
    if (current.length > 0 && size + json.length > maxChars) {
      flush(entry.id - 1)
      from = entry.id
    }
    current.push(json)
    size += json.length + 2
  }
  flush(entries.at(-1)?.id ?? from)
  return segments
}

/** `m412`, `[m412]`, `412`, `m412-m420`, `m412..420`: the ids named, in order, or undefined. */
export function parseRef(ref: string): { from: number; to: number } | undefined {
  const match = /^\s*\[?m?(\d+)\]?(?:\s*(?:-|\.\.|–|to)\s*\[?m?(\d+)\]?)?\s*$/i.exec(ref)
  if (match === null) return undefined
  const from = Number(match[1])
  const to = match[2] === undefined ? from : Number(match[2])
  return from <= to ? { from, to } : { from: to, to: from }
}

/** A message as recall shows it: everything it held, uncut. */
export function renderArchived(entry: Archived): string {
  const lines: string[] = []
  const tag = `[m${entry.id}]`
  if (entry.role === 'user') {
    if (entry.text.trim() !== '') lines.push(`${tag} USER: ${entry.text}`)
    for (const result of entry.toolResults ?? []) lines.push(`${tag} TOOL RESULT${result.isError ? ' (error)' : ''}: ${result.text}`)
  } else {
    if (entry.text.trim() !== '') lines.push(`${tag} ASSISTANT: ${entry.text}`)
    for (const use of entry.toolUses ?? []) lines.push(`${tag} ASSISTANT CALLED ${use.tool}: ${JSON.stringify(use.input)}`)
  }
  return lines.length > 0 ? lines.join('\n\n') : `${tag} (empty message)`
}

/** The messages `from` to `to` in full, from `offset`, at most ANSWER_CHARS of them with a line saying how to read on. */
export function readAnswer(entries: readonly Archived[], range: { from: number; to: number }, offset = 0): string {
  const wanted = entries.filter(entry => entry.id >= range.from && entry.id <= range.to)
  if (wanted.length === 0) return ''
  const text = wanted.map(renderArchived).join('\n\n')
  if (offset >= text.length) return `Nothing past offset ${offset}: the answer is ${text.length} characters long.`
  const shown = text.slice(offset, offset + ANSWER_CHARS)
  const end = offset + shown.length
  const more = end < text.length ? `\n\n[${text.length - end} more characters: call again with the same ref and offset: ${end}]` : ''
  return `${offset > 0 ? '[continued] ' : ''}${shown}${more}`
}

/** The summarized messages that hold every word of `query`, the most relevant first, one line each. */
export function searchAnswer(entries: readonly Archived[], query: string): string {
  const words = query.toLowerCase().split(/\s+/).filter(word => word !== '')
  if (words.length === 0) return 'Give ref or query.'
  const hits: { entry: Archived; score: number; at: number; text: string }[] = []
  for (const entry of entries) {
    const text = renderArchived(entry)
    const lower = text.toLowerCase()
    let score = 0
    let at = -1
    for (const word of words) {
      const first = lower.indexOf(word)
      if (first === -1) {
        score = 0
        break
      }
      if (at === -1) at = first
      score += lower.split(word).length - 1
    }
    if (score > 0) hits.push({ entry, score, at, text })
  }
  if (hits.length === 0) return `No summarized message holds all of: ${words.join(' ')}. Try fewer or other words.`
  hits.sort((a, b) => b.score - a.score || b.entry.id - a.entry.id)
  const lines = hits.slice(0, MAX_HITS).map(hit => {
    const start = Math.max(0, hit.at - 80)
    const snippet = hit.text.slice(start, start + 240).replace(/\s+/g, ' ')
    return `[m${hit.entry.id}] ${start > 0 ? '…' : ''}${snippet}${start + 240 < hit.text.length ? '…' : ''}`
  })
  const rest = hits.length > MAX_HITS ? ` The ${MAX_HITS} best are shown; add a word to narrow it.` : ''
  return `${hits.length} summarized message${hits.length === 1 ? ' matches' : 's match'}.${rest} Read one in full with ref.\n\n${lines.join('\n')}`
}

/** `around` as given, held to what the tool takes. */
export function aroundOf(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(n) ? Math.min(MAX_AROUND, Math.max(0, Math.floor(n))) : 0
}
