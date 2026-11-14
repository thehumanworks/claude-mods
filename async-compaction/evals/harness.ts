// The eval harness: summaries are written by the mod's own code with a haiku
// child session standing in for `$.model.complete`, then a second haiku call
// answers each fixture's probes from the summary alone, and regexes grade the
// answers. Every model reply is cached by what was asked, so grading again
// costs nothing.

import { createHash } from 'node:crypto'
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LEVELS, type LevelName } from '../hooks/config.ts'
import { baseFor } from '../hooks/register.ts'
import type { Rules } from '../hooks/prompts.ts'
import { writeSummary } from '../hooks/summary.ts'
import { idsOf, isSummary, render, summaryMessage, type Message } from '../hooks/transcript.ts'
import type { Fixture, Probe } from './fixtures.ts'

export const MODEL = process.env.EVAL_MODEL ?? 'haiku'
const CACHE = join(import.meta.dir, '.cache')
/** Child sessions run here: no project, no CLAUDE.md, no memory. */
const NEUTRAL_CWD = join(tmpdir(), 'async-compaction-evals')
const CONCURRENCY = Number(process.env.EVAL_CONCURRENCY ?? 4)
const CALL_TIMEOUT_MS = 420_000

// One model call.

export type Reply = { text: string; inputTokens: number; outputTokens: number; ms: number } | { text?: undefined; error: string; isTooLong: boolean }

let running = 0
const waiting: (() => void)[] = []
async function slot<T>(work: () => Promise<T>): Promise<T> {
  if (running >= CONCURRENCY) await new Promise<void>(resolve => waiting.push(resolve))
  running++
  try {
    return await work()
  } finally {
    running--
    waiting.shift()?.()
  }
}

/**
 * One reply from the model: a `claude -p` session with no tools, no settings,
 * no plugins and nothing saved, the system prompt replaced and the prompt on
 * stdin. `salt` tells repetitions of the same request apart in the cache.
 */
export async function complete(request: { system: string; prompt: string; effort: 'low' | 'medium'; salt?: string }): Promise<Reply> {
  const key = createHash('sha256').update(JSON.stringify([MODEL, request.effort, request.system, request.prompt, request.salt ?? ''])).digest('hex')
  const file = join(CACHE, `${key}.json`)
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as Reply
  mkdirSync(CACHE, { recursive: true })
  mkdirSync(NEUTRAL_CWD, { recursive: true })
  const reply = await slot(async () => {
    let last: Reply = { error: 'not run', isTooLong: false }
    for (let attempt = 0; attempt < 2; attempt++) {
      last = await callOnce(request)
      if (last.text !== undefined || last.isTooLong) break
    }
    return last
  })
  // A child session is told the account's email address in a context block, and a reply now and then repeats it.
  if (reply.text !== undefined) reply.text = reply.text.replace(/[\w.+-]+@[\w-]+\.[a-z][\w.]*/gi, found => (request.prompt.includes(found) ? found : '[redacted]'))
  if (reply.text !== undefined || reply.isTooLong) writeFileSync(file, JSON.stringify(reply))
  return reply
}

async function callOnce(request: { system: string; prompt: string; effort: string }): Promise<Reply> {
  const started = Date.now()
  const child = Bun.spawn(
    [
      'claude', '-p', '--model', MODEL, '--effort', request.effort, '--system-prompt', request.system, '--tools', '',
      '--no-session-persistence', '--strict-mcp-config', '--setting-sources', '', '--disable-slash-commands', '--output-format', 'json',
    ],
    { cwd: NEUTRAL_CWD, stdin: new Blob([request.prompt]), stdout: 'pipe', stderr: 'pipe' },
  )
  const timer = setTimeout(() => child.kill(), CALL_TIMEOUT_MS)
  const out = await new Response(child.stdout).text()
  await child.exited
  clearTimeout(timer)
  try {
    const result = JSON.parse(out) as { is_error?: boolean; result?: string; api_error_status?: number | null; usage?: Record<string, number> }
    if (result.is_error || typeof result.result !== 'string') {
      const status = result.api_error_status ?? 0
      return { error: `${status} ${String(result.result).slice(0, 200)}`, isTooLong: status === 400 || status === 413 || /prompt is too long/i.test(String(result.result)) }
    }
    const usage = result.usage ?? {}
    return {
      text: result.result,
      inputTokens: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
      outputTokens: usage.output_tokens ?? 0,
      ms: Date.now() - started,
    }
  } catch {
    return { error: `no result: ${out.slice(0, 200)}`, isTooLong: false }
  }
}

// Writing a summary the way the mod does.

export type SummaryRun = {
  /** The whole message that takes the conversation's place, framed as the mod frames it. */
  message: string
  /** What the compaction model wrote plus the quoted user messages. */
  summary: string
  words: number
  parts: number
  /** Replies the mod did not take for a summary and asked for again. */
  rejected: number
  outputTokens: number
  inputTokens: number
  ms: number
  /** Whether a reply ran past the output limit the mod sets, where the mod would have got it cut off. */
  isOverTokens: boolean
  base: number
}
/** No summary: the mod would have left this compaction to Claude Code. */
export type FellBack = { fellBack: string; rejected: number }

export type RunOptions = { instructions: string; rules?: Partial<Rules>; level: LevelName; refs: boolean; rep: number; partChars?: number }

export async function summarize(
  fixture: Fixture,
  options: RunOptions,
): Promise<SummaryRun | FellBack> {
  const level = LEVELS[options.level]
  const base = options.refs ? baseFor({ count: 0 }, fixture.messages) : 0
  const totals = { inputTokens: 0, outputTokens: 0, ms: 0, isOverTokens: false }
  let rejected = 0
  let failure = ''
  const written = await writeSummary({
    messages: fixture.messages,
    level,
    instructions: options.instructions,
    rules: options.rules,
    refs: options.refs,
    base,
    partChars: options.partChars ?? 500_000,
    partsAtOnce: 4,
    ask: async ({ system, prompt, maxTokens, attempt }) => {
      if (attempt > 0) rejected++
      // The mod asks at low effort; so does the eval.
      const reply = await complete({ system, prompt, effort: 'low', salt: `rep${options.rep}${attempt > 0 ? `#${attempt}` : ''}` })
      if (reply.text === undefined) return { reason: reply.error, isTooLong: reply.isTooLong }
      totals.inputTokens += reply.inputTokens
      totals.outputTokens += reply.outputTokens
      totals.ms += reply.ms
      if (reply.outputTokens > maxTokens) totals.isOverTokens = true
      return { text: reply.text }
    },
    onFailure: reason => {
      failure = reason
      console.error(`  no summary for ${fixture.name}: ${reason}`)
    },
  })
  if (written === undefined) return { fellBack: failure, rejected: rejected + 1 }
  return {
    message: summaryMessage({ summary: written.summary, pointer: options.refs ? 'recall' : { transcriptPath: '/dev/null' }, hasKept: false }),
    summary: written.summary,
    words: written.words,
    parts: written.parts,
    rejected: written.rejected,
    base,
    ...totals,
  }
}

// Asking the probes.

const QA_SYSTEM = `You are an AI assistant picking a task back up. The earlier part of your conversation with the user is gone: what you are given inside <context> is all you have of it. Answer each question about that earlier conversation from the context alone.

- Answer briefly and exactly: the value, name or fact asked for, in a few words, with no explanation.
- If the context does not give the answer, the answer is UNKNOWN. Never guess, and never answer from general knowledge.
- "cite" is the bracketed message id (like m412) the context puts on the statement your answer rests on, or null when there is none.

Output only a JSON object that maps each question's label to {"a": "<answer>", "cite": "<id or null>"}.`

export type Answer = { a: string; cite: number | undefined }

/** The probes answered from `context` alone: one call for all of them. */
export async function ask(context: string, probes: readonly Probe[], salt: string): Promise<Answer[] | undefined> {
  const questions = probes.map((probe, i) => `q${i + 1}: ${probe.q}`).join('\n')
  const reply = await complete({ system: QA_SYSTEM, prompt: `<context>\n${context}\n</context>\n\nQuestions:\n${questions}`, effort: 'medium', salt })
  if (reply.text === undefined) {
    console.error(`  no answers: ${reply.error}`)
    return undefined
  }
  const start = reply.text.indexOf('{')
  const end = reply.text.lastIndexOf('}')
  try {
    const parsed = JSON.parse(reply.text.slice(start, end + 1)) as Record<string, { a?: unknown; cite?: unknown } | string>
    return probes.map((_, i) => {
      const entry = parsed[`q${i + 1}`]
      if (entry === undefined) return { a: 'UNKNOWN', cite: undefined }
      if (typeof entry === 'string') return { a: entry, cite: undefined }
      const cite = /m?(\d+)/.exec(String(entry.cite ?? ''))
      return { a: String(entry.a ?? 'UNKNOWN'), cite: cite ? Number(cite[1]) : undefined }
    })
  } catch {
    console.error(`  answers were not JSON: ${reply.text.slice(0, 120)}`)
    return undefined
  }
}

export type Grade = 'right' | 'wrong' | 'unknown'

/** UNKNOWN is settled before any pattern: it is right only for a never-stated probe. */
export function grade(probe: Probe, answer: string): Grade {
  const isUnknown = /^\W*unknown\b/i.test(answer.trim()) || answer.trim() === ''
  if (probe.kind === 'never-stated') return isUnknown ? 'right' : 'wrong'
  if (isUnknown) return 'unknown'
  return probe.accept.every(pattern => pattern.test(answer)) && !(probe.reject ?? []).some(pattern => pattern.test(answer)) ? 'right' : 'wrong'
}

// What a summary is measured by, besides the probes.

/** Everything the conversation holds, in every spelling a summary might copy it in. */
export function corpus(messages: readonly Message[]): string {
  const strings = (value: unknown): string[] =>
    typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(strings) : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [String(value)]
  return messages
    .map(m => [m.text, ...(m.toolUses ?? []).flatMap(use => [use.tool, ...strings(use.input)]), ...(m.toolResults ?? []).map(result => result.text ?? '')].join('\n'))
    .join('\n')
}

/** The id of the message that holds `src`, or undefined when it is in an earlier summary only. */
export function sourceId(fixture: Fixture, src: string, base: number): number | undefined {
  const ids = idsOf(fixture.messages, base)
  const index = fixture.messages.findIndex(m => !isSummary(m) && corpus([m]).includes(src))
  return index === -1 ? undefined : ids[index]
}

const IDENTIFIERS = [
  /`[^`\n]{2,80}`/g,
  /[\w\-./]+\.(?:py|ts|sql|md|ya?ml|toml|lua|csv|json)\b/g,
  /\b[A-Za-z]+_[A-Za-z0-9_]+\b/g,
  /\b[A-Z]{2,}-\d+\b/g,
  /\b\d[\d,]*(?:\.\d+)?\b/g,
]

/**
 * The names and numbers a summary gives that the conversation nowhere holds: a
 * mechanical sign of invention. Paraphrase is not counted, only things that
 * look copied (code spans, paths, identifiers, tickets, numbers of 3+ digits).
 */
export function unsupported(summaryText: string, source: string): { total: number; absent: string[] } {
  const text = summaryText.replace(/\[m\d+\]/g, '').replace(/^\d+\.\s/gm, '')
  const flat = source.replace(/,/g, '')
  const seen = new Set<string>()
  for (const pattern of IDENTIFIERS) {
    for (const match of text.matchAll(pattern)) {
      const token = match[0].replace(/^`|`$/g, '').trim()
      if (/^\d[\d,.]*$/.test(token) && token.replace(/\D/g, '').length < 3) continue
      seen.add(token)
    }
  }
  const absent = [...seen].filter(token => !source.includes(token) && !flat.includes(token.replace(/,/g, '')))
  return { total: seen.size, absent }
}

// One scored summary.

export type ProbeResult = { id: string; kind: Probe['kind']; grade: Grade; answer: string; isQuoted: boolean; isCiteHit?: boolean }

export type Scored = {
  variant: string
  fixture: string
  level: LevelName
  refs: boolean
  rep: number
  words: number
  maxWords: number
  parts: number
  /** Replies that were not a summary and were asked for again; absent in runs from before the mod checked. */
  rejected?: number
  /** Why there is no summary: the mod would have left the compaction to Claude Code. No probes are asked. */
  fellBack?: string
  outputTokens: number
  inputTokens: number
  seconds: number
  isOverTokens: boolean
  renderedChars: number
  summaryChars: number
  cites: number
  unsupportedTotal: number
  unsupported: string[]
  probes: ProbeResult[]
  summary: string
}

const QUOTES_HEADING = "## The user's own words"

export async function score(
  fixture: Fixture,
  variant: string,
  options: RunOptions,
): Promise<Scored | undefined> {
  const run = await summarize(fixture, options)
  if ('fellBack' in run) {
    return {
      variant, fixture: fixture.name, level: options.level, refs: options.refs, rep: options.rep, words: 0, maxWords: LEVELS[options.level].maxWords, parts: 0,
      rejected: run.rejected, fellBack: run.fellBack, outputTokens: 0, inputTokens: 0, seconds: 0, isOverTokens: false, renderedChars: 0, summaryChars: 0, cites: 0,
      unsupportedTotal: 0, unsupported: [], probes: [], summary: '',
    }
  }
  const answers = await ask(run.message, fixture.probes, `qa${options.rep}`)
  if (answers === undefined) return undefined
  const cut = run.summary.indexOf(QUOTES_HEADING)
  const own = cut === -1 ? run.summary : run.summary.slice(0, cut)
  const quotes = cut === -1 ? '' : run.summary.slice(cut)
  const source = corpus(fixture.messages)
  const count = unsupported(own, source)
  return {
    variant,
    fixture: fixture.name,
    level: options.level,
    refs: options.refs,
    rep: options.rep,
    words: run.words,
    maxWords: LEVELS[options.level].maxWords,
    parts: run.parts,
    rejected: run.rejected,
    outputTokens: run.outputTokens,
    inputTokens: run.inputTokens,
    seconds: Math.round(run.ms / 100) / 10,
    isOverTokens: run.isOverTokens,
    renderedChars: render(fixture.messages, { maxToolChars: LEVELS[options.level].toolChars, refs: options.refs, base: run.base }).length,
    summaryChars: run.summary.length,
    cites: (own.match(/\[m\d+\]/g) ?? []).length,
    unsupportedTotal: count.total,
    unsupported: count.absent,
    probes: fixture.probes.map((probe, i) => {
      const answer = answers[i]!
      const result: ProbeResult = { id: probe.id, kind: probe.kind, grade: grade(probe, answer.a), answer: answer.a, isQuoted: probe.src !== undefined && quotes.includes(probe.src) }
      const at = probe.src === undefined || !options.refs ? undefined : sourceId(fixture, probe.src, run.base)
      // A call and its result are two messages: a cite of either counts.
      if (at !== undefined && result.grade === 'right') result.isCiteHit = answer.cite !== undefined && Math.abs(answer.cite - at) <= 1
      return result
    }),
    summary: run.summary,
  }
}

/** The two controls that say whether the probes measure anything: everything in context, and nothing. */
export async function controls(fixture: Fixture): Promise<{ full: ProbeResult[]; empty: ProbeResult[] } | undefined> {
  const base = baseFor({ count: 0 }, fixture.messages)
  const everything = render(fixture.messages, { maxToolChars: 1e9, refs: true, base })
  const nothing = summaryMessage({ summary: 'Nothing of the earlier conversation was kept.', pointer: 'recall', hasKept: false })
  const [full, empty] = await Promise.all([ask(everything, fixture.probes, 'control-full'), ask(nothing, fixture.probes, 'control-empty')])
  if (full === undefined || empty === undefined) return undefined
  const results = (answers: Answer[]) => fixture.probes.map((probe, i) => ({ id: probe.id, kind: probe.kind, grade: grade(probe, answers[i]!.a), answer: answers[i]!.a, isQuoted: false }))
  return { full: results(full), empty: results(empty) }
}
