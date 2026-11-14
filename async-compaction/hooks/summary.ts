// Writing the summary: the whole way from the messages to the text that takes
// their place, with the model call passed in. The runtime gives it
// `$.model.complete`, the evals a child session, so both score the same code.

import type { Level } from './config.js'
import { mergeRequest, summaryRequest, systemPrompt, type Rules } from './prompts.js'
import { chunkUnits, cleanReply, countIds, dropUnknownCites, isSummary, quoteUserMessages, renderUnits, wordCount, type Message } from './transcript.js'

/**
 * The cap on one reply, thinking included. It is a guard against a reply that
 * runs away, not what keeps the summary short (the length rule does that): a
 * model that thinks before it writes has been seen to spend 12,000 tokens on a
 * 1,100-word summary, and a tighter cap would cut that summary off.
 */
export const SUMMARY_MAX_TOKENS = 24_000

/** How often one request is put to the compaction model when its reply is not a summary. */
const ATTEMPTS = 2
/** With this many message ids in front of it, a summary that cites none is not one. */
const CITES_EXPECTED_FROM = 8
const REFUSAL = /^\W*(?:I['’]m sorry|I am sorry|Sorry\b|I apologi[sz]e|I can(?:no|['’])t\b|I['’]m (?:not able|unable)\b|I won['’]t\b)/i

/**
 * Whether a reply can be taken for the summary that was asked for. Now and then
 * a model answers the request instead of carrying it out: it refuses, or goes on
 * with the conversation as if it were the assistant in it. Swapped in, that
 * reply would be all that is left of the conversation. Every such reply in the
 * evals (3 of about 190) cited no message, where a summary cites dozens, so
 * with ids that is the test. Without ids there is less to go by: a reply that
 * opens as a refusal, or is far shorter than the level asks for.
 */
export function isSummaryLike(text: string, asked: { request: string; refs: boolean; maxWords: number }): boolean {
  if (REFUSAL.test(text)) return false
  const ids = asked.refs ? (asked.request.match(/\[m\d+\]/g) ?? []).length : 0
  if (ids >= CITES_EXPECTED_FROM) return /\[m\d+\]/.test(text)
  return wordCount(text) >= Math.min(asked.maxWords / 5, asked.request.length / 2000)
}

/**
 * One call to the compaction model: its text, or why there is none. `attempt`
 * is 0 the first time a request is made and counts up when it is made again.
 */
export type Ask = (request: {
  system: string
  prompt: string
  maxTokens: number
  attempt: number
}) => Promise<{ text: string } | { text?: undefined; isTooLong?: boolean; reason: string }>

export type Written = {
  /** The summary with the user's own words quoted after it: what replaces the messages. */
  summary: string
  /** How many words the compaction model wrote, the quotes not counted. */
  words: number
  /** In how many parts the conversation was summarized. */
  parts: number
  /** How many replies were not a summary and were asked for again. */
  rejected: number
}

export type WriteInput = {
  /** The messages to summarize, an earlier summary at their head included. */
  messages: readonly Message[]
  level: Level
  /** The user's compaction prompt, or '' for the built-in one. */
  instructions: string
  /** Cite message ids, counted from `base`. */
  refs: boolean
  base: number
  /** What `/compact <text>` asked the summary to focus on. */
  focus?: string
  /** A conversation longer than this, rendered, is summarized in parts and merged. */
  partChars: number
  partsAtOnce: number
  ask: Ask
  /** Other wordings of the mod's own rules: the evals' way in, never the mod's. */
  rules?: Partial<Rules>
  onFailure?: (reason: string) => void
}

/** The summary of `messages`, or undefined when the compaction model gave none. */
export async function writeSummary(input: WriteInput): Promise<Written | undefined> {
  const { messages, level, refs, base, focus } = input
  const system = systemPrompt(input.instructions, { maxWords: level.maxWords, refs, hasEarlier: messages.some(isSummary), rules: input.rules })
  const maxTokens = SUMMARY_MAX_TOKENS
  let isTooLong = false
  let rejected = 0
  const ask = async (prompt: string): Promise<string | undefined> => {
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const reply = await input.ask({ system, prompt, maxTokens, attempt })
      if (reply.text === undefined) {
        if (reply.isTooLong) isTooLong = true
        input.onFailure?.(reply.reason)
        return undefined
      }
      const text = cleanReply(reply.text)
      if (isSummaryLike(text, { request: prompt, refs, maxWords: level.maxWords })) return text
      rejected++
    }
    input.onFailure?.(`the compaction model did not write a summary, asked ${ATTEMPTS} times`)
    return undefined
  }
  const units = renderUnits(messages, { maxToolChars: level.toolChars, refs, base })
  let partCount = 0
  const write = async (partChars: number): Promise<string | undefined> => {
    const parts = chunkUnits(units, partChars)
    partCount = parts.length
    if (parts.length <= 1) return ask(summaryRequest(parts[0] ?? '', { focus }))
    const partials: string[] = []
    for (let i = 0; i < parts.length; i += input.partsAtOnce) {
      const batch = await Promise.all(
        parts.slice(i, i + input.partsAtOnce).map((part, j) => ask(summaryRequest(part, { focus, part: { index: i + j + 1, of: parts.length } }))),
      )
      for (const partial of batch) {
        if (partial === undefined) return undefined
        partials.push(partial)
      }
    }
    return ask(mergeRequest(partials, focus))
  }

  let text = await write(input.partChars)
  // Refused as too long: text that takes more tokens than its length suggests is summarized in smaller parts.
  if (text === undefined && isTooLong) text = await write(Math.floor(input.partChars / 4))
  if (text === undefined) return undefined

  if (refs) text = dropUnknownCites(text, base + countIds(messages))
  const quotes = quoteUserMessages(messages, { maxChars: level.quoteChars, totalChars: level.quoteTotalChars, refs, base })
  return { summary: [text, quotes].filter(part => part !== '').join('\n\n'), words: wordCount(text), parts: partCount, rejected }
}
