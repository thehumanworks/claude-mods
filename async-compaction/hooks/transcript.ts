// Pure functions over the conversation as the engine hands it to plugins:
// `$.session.messages()` (the whole transcript) and `session.compact`'s
// `e.messages` (what is in context). Nothing here touches the engine, so the
// evals run the same code.

/** The fields of a SessionMessage this mod reads. */
export type Message = {
  role: 'user' | 'assistant'
  text: string
  toolUses?: readonly { tool_use_id?: string; tool: string; input: Record<string, unknown>; text?: string }[]
  toolResults?: readonly { tool_use_id?: string; text?: string; isError?: boolean }[]
}

/** The recall tool as the model calls it: `mcp__<plugin>__<name>`. */
export const RECALL_TOOL_NAME = 'mcp__async-compaction__recall'

export const SUMMARY_PREFACE =
  'This session is being continued from a previous conversation that ran out of context. ' +
  'The summary below covers the earlier portion of the conversation.'
/** Every pointer opens this way, which `summaryBody` cuts at. */
const POINTER_OPENING = 'If you need specific details from before compaction'
const TRANSCRIPT_POINTER = `${POINTER_OPENING} (exact wording, numbers, or things you wrote), read the full transcript at:`
const RECALL_POINTER =
  `${POINTER_OPENING} (exact wording, a value, code, command output) that this summary does not give, ` +
  `read them back with ${RECALL_TOOL_NAME}: ref: "m412" returns the original message a bracketed id like [m412] cites ` +
  '(around: 2 adds its neighbours, "m412-m420" reads a range), and query: "words" searches everything that was summarized. ' +
  'Work from the summary: recall only when the task in front of you depends on such a detail, never to re-read what the summary already says.'
const KEPT_NOTE =
  'The messages after this summary are the most recent messages from before compaction, kept verbatim. ' +
  'The summary was written without seeing them, so something it says has not happened yet may already have happened in them.'
const QUOTES_HEADING = "## The user's own words in this part of the conversation"

/** A summary this mod or Claude Code itself put at the head of the conversation. */
export function isSummary(m: Message): boolean {
  return m.role === 'user' && m.text.startsWith(SUMMARY_PREFACE)
}

/**
 * The messages from the latest summary on: what is in context, as compaction's
 * `e.messages` has it. `$.session.messages()` is the whole transcript, the
 * messages earlier compactions summarized included.
 */
export function inContext<M extends Message>(messages: readonly M[]): readonly M[] {
  const start = messages.findLastIndex(isSummary)
  return start === -1 ? messages : messages.slice(start)
}

/** True for a user prompt that starts a turn: not a tool result, a summary or a command echo. */
export function isTurnStart(m: Message): boolean {
  if (m.role !== 'user' || isSummary(m) || (m.toolResults?.length ?? 0) > 0) return false
  const text = m.text.trim()
  return text !== '' && !/^<(local-command|command-name)/.test(text)
}

/** Rough token count of a message (about 4 characters per token). */
export function estimateTokens(m: Message): number {
  let chars = m.text.length
  for (const use of m.toolUses ?? []) chars += use.tool.length + JSON.stringify(use.input).length
  for (const result of m.toolResults ?? []) chars += result.text?.length ?? 0
  return Math.ceil(chars / 4)
}

export function estimateTotal(messages: readonly Message[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m), 0)
}

/**
 * For each index, how many tool calls of the messages before it still wait for
 * their result. A call left unanswered is not counted past the user's next
 * prompt: nothing will answer it.
 */
export function openCalls(messages: readonly Message[]): number[] {
  const open = [0]
  let count = 0
  for (const m of messages) {
    if (isTurnStart(m)) count = 0
    count = Math.max(0, count + (m.toolUses?.length ?? 0) - (m.toolResults?.length ?? 0))
    open.push(count)
  }
  return open
}

/**
 * Whether the conversation can be cut before `messages[i]`: the kept part then
 * opens on a user prompt, or on a reply (an assistant message that follows a
 * user one) with no tool call before it still waiting for its result. So each
 * call and its result fall on the same side, and the rows of one reply stay
 * together. A cut inside a turn is allowed: a long autonomous turn may be the
 * whole conversation. `open` is `openCalls(messages)`, for a caller that asks
 * about many indexes.
 */
export function isSafeCut(messages: readonly Message[], i: number, open: readonly number[] = openCalls(messages)): boolean {
  if (i <= 0 || i > messages.length) return false
  // Everything is summarized: only once no call is waiting for its result.
  if (i === messages.length) return open[i] === 0
  const m = messages[i]!
  if (isTurnStart(m)) return true
  return m.role === 'assistant' && messages[i - 1]!.role === 'user' && open[i] === 0
}

/**
 * Index of the first message to keep raw: the latest safe cut that leaves at
 * least `keepTokens` (estimated) after it. With 0, the latest safe cut there is.
 * Undefined when no safe cut leaves anything before it to summarize.
 */
export function chooseCut(messages: readonly Message[], keepTokens: number): number | undefined {
  const open = openCalls(messages)
  let kept = 0
  for (let i = messages.length; i >= 1; i--) {
    if (i < messages.length) kept += estimateTokens(messages[i]!)
    if (kept < keepTokens || !isSafeCut(messages, i, open)) continue
    return messages.slice(0, i).some(m => !isSummary(m)) ? i : undefined
  }
  return undefined
}

/**
 * A short key for what one message says, to recognise it later: the engine
 * gives the messages of `$.session.messages()` no id of their own. Two 32-bit
 * FNV-1a hashes side by side. A tool result counts by the call it answers, not
 * by its text: the engine may trim the text of an old one while it stays in
 * context.
 */
export function keyOf(m: Message): string {
  const parts = [m.role, m.text]
  for (const use of m.toolUses ?? []) parts.push(use.tool_use_id ?? '', use.tool, JSON.stringify(use.input))
  for (const result of m.toolResults ?? []) parts.push(`result ${result.tool_use_id ?? ''}`)
  const text = parts.join('\u0000')
  let a = 0x811c9dc5
  let b = 0x01000193
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    a = Math.imul(a ^ code, 0x01000193)
    b = Math.imul(b ^ code, 0x85ebca6b) + 0x9e3779b9
  }
  return (a >>> 0).toString(36) + '.' + (b >>> 0).toString(36)
}

/** How far a summary's cut may be moved back to fall between two replies, in messages. */
const MAX_MOVED_BACK = 64

export type Fit =
  /** Cut `messages` at `cut`: all before it is summarized. `movedBack` of the summarized messages stay raw as well. */
  | { cut: number; movedBack: number }
  | { cut?: undefined; reason: string }

/**
 * Where to cut `messages`, the conversation as compaction has it, to put in
 * place a summary of the messages with `keys`, taken from
 * `$.session.messages()` when it was written.
 *
 * The two list the same messages in different orders. One reply's parallel
 * tool calls stand before all their results for compaction, and in
 * `$.session.messages()` in the order they came, a result before the next
 * call, so no reordering of one gives the other, and the summarized messages
 * need not open the conversation as compaction has it. So they are matched as
 * a set: the cut is the latest safe one with only summarized messages before
 * it. Where that is short of the summary's own cut, a reply ran across it, and
 * the whole reply stays raw: its summarized messages are then in both.
 */
export function fitSummary(messages: readonly Message[], keys: readonly string[]): Fit {
  if (messages.length < keys.length) return { reason: `the conversation holds ${messages.length} messages, fewer than the ${keys.length} summarized` }
  const left = new Map<string, number>()
  for (const key of keys) left.set(key, (left.get(key) ?? 0) + 1)
  let missing = keys.length
  let first = -1
  for (let i = 0; i < messages.length && missing > 0; i++) {
    const key = keyOf(messages[i]!)
    const count = left.get(key) ?? 0
    if (count > 0) {
      left.set(key, count - 1)
      missing--
    } else if (first === -1) first = i
    // Past the cut by more than a reply's worth: the rest was said after the summary.
    if (first !== -1 && i - first >= MAX_MOVED_BACK) break
  }
  if (missing > 0) return { reason: `${missing} of the ${keys.length} summarized messages are no longer where the conversation starts` }
  if (first === -1) first = keys.length
  const open = openCalls(messages)
  let cut = first
  while (cut > 0 && !isSafeCut(messages, cut, open)) cut--
  if (cut === 0 || !messages.slice(0, cut).some(m => !isSummary(m))) return { reason: 'no safe cut before the first message that was not summarized' }
  if (keys.length - cut > MAX_MOVED_BACK) return { reason: `the nearest safe cut is ${keys.length - cut} messages before the summary's` }
  return { cut, movedBack: keys.length - cut }
}

/** How many of the messages take an id: every one but a summary. */
export function countIds(messages: readonly Message[]): number {
  return messages.reduce((n, m) => n + (isSummary(m) ? 0 : 1), 0)
}

/**
 * The id of each message, `base` being how many messages of this session are
 * archived already; undefined for a summary. Ids run on across compactions, so
 * a message keeps its id from the first time it is rendered to the archive.
 */
export function idsOf(messages: readonly Message[], base: number): (number | undefined)[] {
  let next = base
  return messages.map(m => (isSummary(m) ? undefined : next++))
}

export type RenderOptions = {
  /** Tool inputs and results are cut to this many characters. */
  maxToolChars: number
  /** With `refs`, each line opens with its message's id, `[m412]`, counted from `base`. */
  refs?: boolean
  base?: number
}

/**
 * Plain text for the compaction model, one entry per message ('' for one with
 * nothing to show). An earlier summary is passed on without its framing.
 */
export function renderUnits(messages: readonly Message[], options: RenderOptions): string[] {
  const ids = idsOf(messages, options.base ?? 0)
  return messages.map((m, i) => {
    if (isSummary(m)) return `<earlier_summary>\n${summaryBody(m.text)}\n</earlier_summary>`
    const tag = options.refs ? `[m${ids[i]}] ` : ''
    const lines: string[] = []
    if (m.role === 'user') {
      if (m.text.trim() !== '' && !/^<(local-command|command-name)/.test(m.text.trim())) lines.push(`${tag}USER: ${m.text}`)
      for (const result of m.toolResults ?? []) {
        lines.push(`${tag}TOOL RESULT${result.isError ? ' (error)' : ''}: ${clip(result.text ?? '', options.maxToolChars)}`)
      }
    } else {
      if (m.text.trim() !== '') lines.push(`${tag}ASSISTANT: ${m.text}`)
      for (const use of m.toolUses ?? []) lines.push(`${tag}ASSISTANT CALLED ${use.tool}: ${clip(JSON.stringify(use.input), options.maxToolChars)}`)
    }
    return lines.join('\n\n')
  })
}

export function render(messages: readonly Message[], options: RenderOptions): string {
  return renderUnits(messages, options).filter(unit => unit !== '').join('\n\n')
}

/**
 * The rendered conversation in consecutive parts of at most `maxChars` each,
 * split between messages, for a compaction model whose window is smaller than
 * what is being summarized. A single entry longer than `maxChars` is cut.
 */
export function chunkUnits(units: readonly string[], maxChars: number): string[] {
  const parts: string[] = []
  let current: string[] = []
  let size = 0
  for (const unit of units) {
    if (unit === '') continue
    const text = unit.length > maxChars ? clip(unit, maxChars) : unit
    if (current.length > 0 && size + text.length + 2 > maxChars) {
      parts.push(current.join('\n\n'))
      current = []
      size = 0
    }
    current.push(text)
    size += text.length + 2
  }
  if (current.length > 0) parts.push(current.join('\n\n'))
  return parts
}

/**
 * The user's prompts among `messages`, verbatim, each cut at `maxChars`, as a
 * section to append to a summary; with `refs`, each led by its message's id.
 * Over `totalChars` the oldest are left out: the summary itself covers them.
 * Quotes inside an earlier summary are not repeated. Empty if there are none.
 */
export function quoteUserMessages(
  messages: readonly Message[],
  options: { maxChars: number; totalChars: number; refs?: boolean; base?: number },
): string {
  if (options.maxChars <= 0 || options.totalChars <= 0) return ''
  const ids = idsOf(messages, options.base ?? 0)
  const quotes: string[] = []
  let size = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (!isTurnStart(m)) continue
    const quote = `- ${options.refs ? `[m${ids[i]}] ` : ''}${clip(m.text.trim(), options.maxChars).replaceAll('\n', '\n  ')}`
    if (size + quote.length > options.totalChars && quotes.length > 0) break
    quotes.unshift(quote)
    size += quote.length
  }
  return quotes.length === 0 ? '' : `${QUOTES_HEADING}\n\n${quotes.join('\n')}`
}

/**
 * The text of the message that replaces the summarized part, framed as Claude
 * Code frames its own. `pointer` says where the detail the summary dropped can
 * be read back: the recall tool, or the transcript file.
 */
export function summaryMessage(input: { summary: string; pointer?: 'recall' | { transcriptPath: string }; hasKept: boolean }): string {
  const pointer =
    input.pointer === 'recall' ? RECALL_POINTER : input.pointer !== undefined ? `${TRANSCRIPT_POINTER} ${input.pointer.transcriptPath}` : undefined
  return (
    `${SUMMARY_PREFACE}\n\nSummary:\n${input.summary.trim()}` +
    (pointer !== undefined ? `\n\n${pointer}` : '') +
    (input.hasKept ? `\n\n${KEPT_NOTE}` : '')
  )
}

/** The summary inside a summary message, without the framing around it. */
export function summaryBody(text: string): string {
  const start = text.indexOf('Summary:\n')
  let body = start === -1 ? text : text.slice(start + 'Summary:\n'.length)
  for (const marker of [`\n\n${KEPT_NOTE}`, `\n${POINTER_OPENING}`]) {
    const end = body.indexOf(marker)
    if (end !== -1) body = body.slice(0, end)
  }
  return body.trim()
}

const CLIP_SLACK = 200

/** Cuts long text to about `max` characters, keeping its head and its tail: an error is often at the end of an output. */
export function clip(text: string, max: number): string {
  // A cut that saves less than its own mark takes up is not worth making.
  if (text.length <= max + CLIP_SLACK) return text
  const head = Math.ceil(max * 0.7)
  const tail = max - head
  return `${text.slice(0, head).trimEnd()} … [${text.length - max} characters left out] … ${text.slice(text.length - tail).trimStart()}`
}

/** The highest message id a text cites as `[m412]`, or -1 when it cites none. */
export function maxCitedId(text: string): number {
  let max = -1
  for (const match of text.matchAll(/\[m(\d+)\]/g)) max = Math.max(max, Number(match[1]))
  return max
}

/**
 * The summary without the ids it cites that name no message: one at or past
 * `end`, which the compaction model can only have made up.
 */
export function dropUnknownCites(text: string, end: number): string {
  return text.replace(/ ?\[m(\d+)\]/g, (cite, id) => (Number(id) < end ? cite : ''))
}

const EARLIER_OPEN = /^\s*<earlier_summary>/i
const EARLIER_CLOSE = /<\/earlier_summary>/i
/** A line in the format `renderUnits` gives the conversation, with or without an id. */
const TRANSCRIPT_LINE = /^[ \t]*(?:\[m\d+\][ \t]*)?(?:USER:|ASSISTANT:|ASSISTANT CALLED \w+:|TOOL RESULT(?: \(error\))?:)|^[ \t]*<system-reminder>/m

/**
 * The compaction model's reply without what it now and then puts around a
 * summary, copied from what it was shown: the <earlier_summary> tag as a
 * wrapper for the whole summary, or with "none" in it, or with a remark on it,
 * and after the summary the conversation carried on in the transcript's format.
 */
export function cleanReply(reply: string): string {
  let text = reply.trim()
  if (EARLIER_OPEN.test(text)) {
    text = text.replace(EARLIER_OPEN, '')
    const close = EARLIER_CLOSE.exec(text)
    // "<earlier_summary>none</earlier_summary>" before the summary: a note that there was none.
    if (close !== null && text.slice(0, close.index).trim().length <= 100 && text.slice(close.index + close[0].length).trim() !== '') {
      text = text.slice(close.index + close[0].length)
    }
    // "<earlier_summary> is absent, so …": the rest of that line is the remark.
    else if (close === null && /^[^\n]*\S/.test(text) && !text.startsWith('\n')) text = text.replace(/^[^\n]*\n?/, '')
  }
  text = text.replace(new RegExp(EARLIER_CLOSE.source, 'gi'), '')
  const carriedOn = TRANSCRIPT_LINE.exec(text)
  if (carriedOn !== null) text = text.slice(0, carriedOn.index)
  return text.trim()
}

/** How many words a text has. */
export function wordCount(text: string): number {
  return text.split(/\s+/).filter(word => word !== '').length
}
