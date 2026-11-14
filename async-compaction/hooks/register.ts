// Asynchronous compaction: the summary is written in the background once the
// context passes the trigger, and swapped in when Claude Code compacts, with
// everything said since the trigger left raw after it.

import type { EngineInterface, PluginOptions, Register, SessionCompactResult, SessionMessage } from 'claude-code'
import { aroundOf, parseRef, readAnswer, RECALL, searchAnswer, toArchive, toSegments, type Archived, type Segment } from './archive.js'
import { LEVELS, resolveConfig, type Config, type Level } from './config.js'
import { writeSummary } from './summary.js'
import {
  chooseCut,
  countIds,
  estimateTotal,
  fitSummary,
  inContext,
  isSummary,
  keyOf,
  maxCitedId,
  RECALL_TOOL_NAME,
  summaryBody,
  summaryMessage,
  type Message,
} from './transcript.js'

type $ = EngineInterface

/** A summary written ahead of compaction for one session, kept in `$.store`. */
export type Prepared = {
  sessionId: string
  /** How many messages are summarized: those before this index of `$.session.messages()` as it was. */
  cut: number
  /** A key for each summarized message: the summary is used only while all of them still open the conversation. */
  keys: string[]
  summary: string
  model: string
  level: string
  createdAt: number
  /** The context size when the summary started. */
  contextTokens: number
  summarizedTokens: number
  words: number
  /** With recall: the id of the first summarized message, how many take one, and the archive files written for them. */
  base?: number
  count?: number
  segments?: Segment[]
}

/** What of a session the recall tool can read back. */
type ArchiveIndex = { count: number; segments: Segment[] }

type Settings = { config: Config; level: Level; instructions: string }

/** What the hooks share for this load of the module. */
type Runtime = {
  options: PluginOptions
  settings?: Promise<Settings>
  transcriptPath?: string
  /** The summary being written in the background. */
  running?: { sessionId: string; done: Promise<Prepared | undefined>; startedAt: number; tokens: number }
  /** Checks run one at a time, so two close together start one summary. */
  checking?: Promise<void>
  /** When the context was last measured from a tool call. */
  checkedAt?: number
  /** Compactions begun, and whether one is under way: a check that overlaps one starts nothing. */
  compactions: number
  isCompacting: boolean
  /** Compactions that replaced the conversation: a summary one of them overtook is not kept. */
  compacted: number
  /** Claude Code's auto-compact limit, as last read; with auto-compact off, its window. */
  limit?: { model: string; tokens: number; isAuto: boolean; at: number }
}

/** Sessions whose ready summary is kept, and whose archive index is. */
const KEEP_PREPARED = 20
const KEEP_ARCHIVES = 200
/** How long a compaction waits for a summary still being written: inside a hook's budget. */
const WAIT_FOR_SUMMARY_MS = 8_000
/** A background summary waits until there is at least this much to summarize. */
const MIN_SUMMARIZED_TOKENS = 1_000
/** How often the auto-compact limit is read again. */
const LIMIT_TTL_MS = 5 * 60_000
/** Inside a turn the context is measured at a tool call at most this often. */
const CHECK_EVERY_MS = 10_000
/** Summaries in a row that may go unfinished (cut off with their process, or failed) before compaction writes the next itself. */
const MAX_UNFINISHED = 2
/** A ready summary is written again once what was said after it comes to this share of the limit: the raw part never outgrows it. */
const MAX_RAW_PERCENT = 50
/** What one request to the compaction model holds of the conversation, in characters (some 125,000 tokens); more is summarized in parts. */
export const PART_CHARS = 500_000
/** Parts summarized at once. */
const PARTS_AT_ONCE = 4
const SUMMARY_TIMEOUT_MS = 240_000
/** What Claude Code keeps free between its auto-compact threshold and the window less the reply's room. */
const AUTOCOMPACT_BUFFER = 13_000
const COMMAND = 'async-compaction'
const $name = 'async-compaction'

export const register: Register = (on, options) => {
  const rt: Runtime = { options, compactions: 0, isCompacting: false, compacted: 0 }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    rt.settings = loadSettings($, rt.options)
    const { config } = await rt.settings
    try {
      await $.command.register({
        name: COMMAND,
        description: 'Asynchronous compaction: whether a summary is ready, and when the conversation compacts',
        immediate: true,
      })
      if (config.enabled && config.recall) await $.tool.register({ ...RECALL, isDeferred: false })
    } catch (err) {
      debug($, `not registered: ${messageOf(err)}`)
    }
    return started
  })

  on('command.run', { command: COMMAND }, async $ => ({ text: await report($, rt) })).catch(($, e, next) => ({
    text: `Its state could not be read: ${messageOf(next.error)}`,
  }))

  // Plugins see the transcript's path only on the classic hook events.
  on('classic.SessionStart', ($, e, next) => {
    rt.transcriptPath = e.transcript_path
    // A resumed session may be past the trigger already, its summary never started or cut off with the process writing it.
    if (e.source === 'resume' || e.source === 'fork') check($, rt, `session ${e.source}`, e.context_tokens)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const completed = await next(e)
    if (e.agentId === undefined) check($, rt, 'turn end')
    return completed
  })

  // One long turn can run from an empty context to the limit, so the context is measured inside turns too.
  on('tool.call', ($, e, next) => {
    if (e.agentId === undefined && e.tool !== RECALL_TOOL_NAME) check($, rt, 'tool call', undefined, true)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.check', { tool: 'mcp__async-compaction__recall' }, () => ({ decision: 'allow' as const }))
  on('tool.call', { tool: 'mcp__async-compaction__recall' }, async ($, e) => ({ result: await recall($, e as Record<string, unknown>) })).catch(
    ($, e, next) => ({ deny: `recall failed: ${messageOf(next.error)}` }),
  )

  on('session.compact', async ($, e, next) => {
    const settings = await settingsOf($, rt)
    const { config } = settings
    if (!config.enabled || e.agentId !== undefined) return next(e)
    // Claude Code's own ahead-of-time summary would be paid for and never used.
    if (e.trigger === 'precompute') return { skip: `${$name} writes its own summary ahead of time` }
    const sessionId = await $.session.id()

    rt.compactions++
    rt.isCompacting = true
    try {
      await $.store.delete(unfinishedKey(sessionId))
      const index = await readIndex($, sessionId)
      const usable = (prepared: Prepared | undefined): Usable | undefined => {
        if (prepared === undefined) return undefined
        const match = matching(prepared, e.messages, config.recall ? index : undefined)
        if (match.prepared === undefined) debug($, `compacting (${e.trigger}): the summary written ahead is not used: ${match.reason}`)
        return match.prepared === undefined ? undefined : match
      }
      let ready: Usable | undefined
      // `/compact <what to stress>` asks for a summary of its own.
      if (e.instructions === undefined) {
        ready = usable(await readPrepared($, sessionId))
        if (ready === undefined && rt.running?.sessionId === sessionId) {
          const done = rt.running.done
          ready = usable(await Promise.race([done, $.clock.sleep(WAIT_FOR_SUMMARY_MS).then(() => undefined)]))
        }
      }
      const tokens = (await $.session.usage()).context.tokens ?? estimateTotal(e.messages)
      const isPrepared = ready !== undefined
      if (ready === undefined) {
        // Nothing ready: the summary is written now, leaving raw what a summary started on time would have.
        const { limit } = await thresholds($, rt, config)
        const rawPercent = e.trigger === 'auto' ? 100 - config.triggerAt + settings.level.keepPercent : settings.level.keepPercent
        const cut = cutFor(e.messages, (limit * rawPercent) / 100, 0)
        const written = cut === undefined ? undefined : await summarize($, settings, sessionId, e.messages, cut, tokens, e.instructions)
        if (written === undefined) {
          debug($, `compacting (${e.trigger}): no summary of its own; left to Claude Code`)
          return await spent($, rt, sessionId, await next(e))
        }
        ready = { prepared: written, cut: written.cut, movedBack: 0 }
      }

      const { prepared } = ready
      rt.compacted++
      await $.store.delete(preparedKey(sessionId))
      if (prepared.count !== undefined) await commit($, sessionId, index, prepared)
      const kept = e.messages.slice(ready.cut)
      const age = Math.max(0, Math.round(((await $.clock.now()) - prepared.createdAt) / 1000))
      debug(
        $,
        `compacting (${e.trigger}): ${prepared.cut} messages summarized by ${prepared.model}${isPrepared ? ` ${age}s ago` : ' now'}, ${kept.length} kept raw` +
          // A reply ran across the summary's cut: it stays whole, so its summarized messages are raw as well.
          (ready.movedBack > 0 ? `, ${ready.movedBack} of the summarized among them` : ''),
      )
      $.ui.toast(
        isPrepared
          ? `Compacted with the summary ${prepared.model} wrote ${duration(age)} ago; ${count(kept.length, 'message')} since kept as they were`
          : `Compacted with a summary by ${prepared.model}`,
      )
      const text = summaryMessage({
        summary: prepared.summary,
        pointer: prepared.count !== undefined ? 'recall' : rt.transcriptPath !== undefined ? { transcriptPath: rt.transcriptPath } : undefined,
        hasKept: kept.length > 0,
      })
      return { messages: [{ role: 'user', text, toolUses: [] }, ...handBack(kept)] }
    } finally {
      rt.isCompacting = false
    }
  })
}

/** After a compaction left to Claude Code: what the ready summary covered is gone from context, so it is dropped. */
async function spent($: $, rt: Runtime, sessionId: string, compacted: SessionCompactResult): Promise<SessionCompactResult> {
  if (compacted.messages !== undefined) {
    rt.compacted++
    await $.store.delete(preparedKey(sessionId))
    await $.store.delete(unfinishedKey(sessionId))
  }
  return compacted
}

function settingsOf($: $, rt: Runtime): Promise<Settings> {
  return (rt.settings ??= loadSettings($, rt.options))
}

/**
 * Runs `armIfDue` off the hook's clock (a summary takes longer than a hook
 * may), one check at a time. From a tool call it measures at most every
 * CHECK_EVERY_MS, and not at all while a summary is being written.
 */
function check($: $, rt: Runtime, when: string, resumedTokens?: number, isThrottled = false): void {
  if (isThrottled && rt.running !== undefined) return
  $.clock.after(0, async () => {
    if (isThrottled) {
      const now = await $.clock.now()
      if (rt.checkedAt !== undefined && now - rt.checkedAt < CHECK_EVERY_MS) return
      rt.checkedAt = now
    }
    rt.checking = (rt.checking ?? Promise.resolve()).then(() => armIfDue($, rt, when, resumedTokens))
  })
}

/**
 * Starts the summary once the context passes the trigger, unless one is ready
 * or being written. Never throws.
 */
async function armIfDue($: $, rt: Runtime, when: string, resumedTokens?: number): Promise<void> {
  try {
    const settings = await settingsOf($, rt)
    const { config } = settings
    if (!config.enabled) return
    const compactions = rt.compactions
    const tokens = resumedTokens ?? (await $.session.usage()).context.tokens
    if (tokens === undefined) return
    const sessionId = await $.session.id()
    if (rt.running?.sessionId === sessionId) return
    const { limit, trigger } = await thresholds($, rt, config)
    if (tokens < trigger) return
    const prepared = await readPrepared($, sessionId)
    if (prepared !== undefined) {
      // A context smaller than the summary's own was compacted or rewound since; one grown far past it would keep too much raw.
      const isOutdated = tokens < prepared.contextTokens * 0.9 || tokens - prepared.contextTokens >= (limit * MAX_RAW_PERCENT) / 100
      if (!isOutdated) return
    }
    const unfinished = (((await $.store.get(unfinishedKey(sessionId))) ?? 0) as number)
    if (unfinished >= MAX_UNFINISHED) {
      debug($, `${when}: the last ${unfinished} summaries did not finish; compaction will write the next`)
      return
    }
    // A compaction under way, or done since this check began, writes or has its own.
    if (rt.isCompacting || rt.compactions !== compactions) return
    debug($, `${when}: ${tokens} tokens, past the trigger at ${trigger} (${config.triggerAt}% of ${limit}); summarizing with ${config.model}`)
    const done = writeInBackground($, rt, settings, sessionId, tokens, limit, unfinished)
    rt.running = { sessionId, done, startedAt: await $.clock.now(), tokens }
    void done.then(() => {
      if (rt.running?.done === done) rt.running = undefined
    })
  } catch (err) {
    debug($, `${when}: ${messageOf(err)}`)
  }
}

/** Never rejects: a failure is logged and resolves undefined. */
async function writeInBackground(
  $: $,
  rt: Runtime,
  settings: Settings,
  sessionId: string,
  tokens: number,
  limit: number,
  unfinished: number,
): Promise<Prepared | undefined> {
  try {
    const compacted = rt.compacted
    const all = await $.session.messages()
    // What compaction will see: it matches the summary against what is in context, not the whole transcript.
    const messages = inContext(all)
    // The engine hands over the newest 4096 entries: with no summary among them, where the context starts is unknown.
    if (all.length >= 4096 && messages.length === all.length) {
      debug($, 'the transcript is longer than a plugin can read; compaction will write the summary')
      return undefined
    }
    const cut = cutFor(messages, (limit * settings.level.keepPercent) / 100, MIN_SUMMARIZED_TOKENS)
    if (cut === undefined) return undefined
    await remember($, 'sessions', sessionId, KEEP_PREPARED, [preparedKey, unfinishedKey])
    // Counted until the summary is kept, so one cut off with its process is still counted when the session resumes.
    await $.store.set(unfinishedKey(sessionId), unfinished + 1)
    const prepared = await summarize($, settings, sessionId, messages, cut, tokens)
    if (prepared === undefined) return undefined
    // Compacted meanwhile, without this summary: what it covers no longer opens the conversation.
    if (rt.compacted !== compacted) return undefined
    await $.store.set(preparedKey(sessionId), prepared)
    await $.store.delete(unfinishedKey(sessionId))
    return prepared
  } catch (err) {
    debug($, `background summary failed: ${messageOf(err)}`)
    return undefined
  }
}

/**
 * Where Claude Code compacts and where the summary starts, in tokens. (A plugin
 * cannot start a compaction that its own hook answers, so the swap always
 * waits for Claude Code's.)
 */
async function thresholds($: $, rt: Runtime, config: Config): Promise<{ limit: number; trigger: number; isAuto: boolean }> {
  const [model, now] = await Promise.all([$.session.model(), $.clock.now()])
  if (rt.limit === undefined || rt.limit.model !== model || now - rt.limit.at > LIMIT_TTL_MS) {
    const { window, breakdown } = (await $.session.usage({ breakdown: 'summary' })).context
    let tokens = breakdown?.autoCompactThreshold ?? breakdown?.rawMaxTokens ?? window
    // The documented override moves Claude Code's threshold without changing what it reports: it is a share of
    // the window less the room kept for the reply, which is the reported threshold plus the engine's own buffer.
    const percent = Number(await $.env.get('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE'))
    if (breakdown?.autoCompactThreshold !== undefined && percent > 0 && percent <= 100) {
      tokens = Math.min(tokens, Math.floor(((breakdown.autoCompactThreshold + AUTOCOMPACT_BUFFER) * percent) / 100))
    }
    rt.limit = { model, tokens, isAuto: breakdown?.isAutoCompactEnabled !== false, at: now }
    debug($, `auto-compact limit for ${model}: ${tokens} tokens`)
  }
  const limit = rt.limit.tokens
  return { limit, trigger: Math.round((limit * config.triggerAt) / 100), isAuto: rt.limit.isAuto }
}

/**
 * Where to cut so that about `keepTokens` stay raw: never more than half of
 * the conversation, so there is always an older part. Undefined when that part
 * is missing or under `minTokens`.
 */
export function cutFor(messages: readonly Message[], keepTokens: number, minTokens: number): number | undefined {
  const cut = chooseCut(messages, Math.min(keepTokens, Math.floor(estimateTotal(messages) / 2)))
  if (cut === undefined) return undefined
  return estimateTotal(messages.slice(0, cut)) < minTokens ? undefined : cut
}

/**
 * Summarizes the messages before `cut` with the compaction model, in parts
 * when they are more than one request holds, and with recall on writes them to
 * the archive. Undefined when no summary comes back.
 */
async function summarize(
  $: $,
  settings: Settings,
  sessionId: string,
  messages: readonly Message[],
  cut: number,
  tokens: number,
  focus?: string,
): Promise<Prepared | undefined> {
  const { config, level, instructions } = settings
  const older = messages.slice(0, cut)
  const refs = config.recall
  const base = refs ? baseFor(await readIndex($, sessionId), older) : 0
  const started = await $.clock.now()
  const written = await writeSummary({
    messages: older,
    level,
    instructions,
    refs,
    base,
    focus,
    partChars: PART_CHARS,
    partsAtOnce: PARTS_AT_ONCE,
    ask: async ({ system, prompt, maxTokens }) => {
      const reply = await $.model.complete({ model: config.model, effort: 'low', system, prompt, maxTokens, timeoutMs: SUMMARY_TIMEOUT_MS })
      // A reply that used the whole cap was cut off: half a summary is worse than Claude Code's own.
      if (reply.isAnswered) return reply.usage.output_tokens >= maxTokens ? { reason: 'the reply was cut off at the token cap' } : { text: reply.text }
      return { reason: reply.reason, isTooLong: reply.reason === 'api-error' && (reply.status === 400 || reply.status === 413) }
    },
    onFailure: reason => debug($, `no summary from ${config.model}: ${reason}`),
  })
  if (written === undefined) return undefined
  const count = countIds(older)
  const createdAt = await $.clock.now()
  const summarizedTokens = estimateTotal(older)
  debug($, `summary by ${config.model} in ${Math.round((createdAt - started) / 1000)}s: ${cut} messages, ~${summarizedTokens} tokens, ${written.parts} part(s)${written.rejected > 0 ? `, ${written.rejected} reply(ies) that were not a summary asked for again` : ''}`)
  const prepared: Prepared = {
    sessionId,
    cut,
    keys: older.map(keyOf),
    summary: written.summary,
    model: config.model,
    level: config.level,
    createdAt,
    contextTokens: tokens,
    summarizedTokens,
    words: written.words,
  }
  if (refs) {
    try {
      prepared.segments = await writeArchive($, sessionId, toArchive(older, base))
      prepared.base = base
      prepared.count = count
    } catch (err) {
      // Without the archive the ids lead nowhere: the summary stands without them.
      debug($, `archive not written: ${messageOf(err)}`)
      prepared.summary = prepared.summary.replace(/ ?\[m\d+\]/g, '')
    }
  }
  return prepared
}

/** A prepared summary and where it cuts the conversation compaction has. */
type Usable = { prepared: Prepared; cut: number; movedBack: number }

/**
 * The prepared summary with its cut in `messages`, while the messages it
 * covers still open the conversation and its ids still follow the archive's.
 * Otherwise why it cannot be used.
 */
function matching(prepared: Prepared, messages: readonly Message[], index?: ArchiveIndex): Usable | { prepared?: undefined; reason: string } {
  // A summary an earlier version of this mod stored has no keys.
  if (!Array.isArray(prepared.keys)) return { reason: 'it was stored by an earlier version' }
  const fit = fitSummary(messages, prepared.keys)
  if (fit.cut === undefined) return fit
  if (index !== undefined && prepared.base !== undefined && prepared.base !== baseFor(index, messages.slice(0, fit.cut))) {
    return { reason: 'its message ids no longer follow the archive\'s' }
  }
  return { prepared, cut: fit.cut, movedBack: fit.movedBack }
}

/**
 * The kept messages as the hook hands them back. Claude Code writes a tool
 * result kept by its handle under the parent it had before the compaction, so
 * a resumed session follows it past the summary and loads all that came
 * before. Handed back without its handle, a tool result is written anew from
 * its text, after the call it answers; every other message keeps its handle
 * and stays whole.
 */
function handBack(kept: readonly SessionMessage[]): SessionMessage[] {
  return kept.map(m => (m.toolResults?.length ? { role: m.role, text: m.text, toolUses: m.toolUses, toolResults: m.toolResults } : m))
}

// The archive: what was summarized, word for word, for the recall tool.

/**
 * The id the first of `older` takes: one past the last archived. A session
 * forked from another starts with no archive of its own, but with a summary
 * whose ids are the other's: its own ids then start past those.
 */
export function baseFor(index: { count: number }, older: readonly Message[]): number {
  const cited = older.reduce((max, m) => (isSummary(m) ? Math.max(max, maxCitedId(summaryBody(m.text))) : max), -1)
  return Math.max(index.count, cited + 1)
}

async function archiveDir($: $, sessionId: string): Promise<string> {
  const home = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${await $.env.get('HOME')}/.claude`
  return `${home}/${$name}/${sessionId.replace(/[^A-Za-z0-9_-]/g, '_')}`
}

/** Writes the entries to files of the session's archive folder; they count once `commit` lists them. */
async function writeArchive($: $, sessionId: string, entries: readonly Archived[]): Promise<Segment[]> {
  const dir = await archiveDir($, sessionId)
  const segments: Segment[] = []
  for (const segment of toSegments(entries)) {
    const file = `${dir}/m${segment.from}-m${segment.to}.json`
    await $.fs.write(file, segment.json)
    segments.push({ from: segment.from, to: segment.to, file })
  }
  return segments
}

async function readIndex($: $, sessionId: string): Promise<ArchiveIndex> {
  return ((await $.store.get(archiveKey(sessionId))) ?? { count: 0, segments: [] }) as ArchiveIndex
}

/** Lists the summary's messages in the session's archive, as it is swapped in. */
async function commit($: $, sessionId: string, index: ArchiveIndex, prepared: Prepared): Promise<void> {
  const next: ArchiveIndex = {
    count: (prepared.base ?? index.count) + (prepared.count ?? 0),
    segments: [...index.segments, ...(prepared.segments ?? [])],
  }
  await remember($, 'archives', sessionId, KEEP_ARCHIVES, [archiveKey])
  await $.store.set(archiveKey(sessionId), next)
}

/** Answers one call of the recall tool. */
async function recall($: $, input: Record<string, unknown>): Promise<string> {
  const sessionId = await $.session.id()
  const index = await readIndex($, sessionId)
  if (index.segments.length === 0) return 'Nothing of this conversation has been compacted yet: all of it is still in your context.'
  const read = async (segments: readonly Segment[]): Promise<Archived[]> => {
    const entries: Archived[] = []
    for (const segment of segments) {
      try {
        entries.push(...(JSON.parse(await $.fs.read(segment.file)) as Archived[]))
      } catch (err) {
        debug($, `archive file not read (${segment.file}): ${messageOf(err)}`)
      }
    }
    return entries
  }

  const query = typeof input.query === 'string' ? input.query.trim() : ''
  const ref = typeof input.ref === 'string' ? input.ref.trim() : typeof input.ref === 'number' ? String(input.ref) : ''
  if (ref === '') return query === '' ? 'Give ref (an id the summary cites, like "m412") or query (words to find).' : searchAnswer(await read(index.segments), query)

  const range = parseRef(ref)
  if (range === undefined) return `"${ref}" is not a message id: give one as the summary cites it, like "m412", or a range, "m412-m420".`
  const around = aroundOf(input.around)
  const wanted = { from: Math.max(0, range.from - around), to: range.to + around }
  const offset = typeof input.offset === 'number' && input.offset > 0 ? Math.floor(input.offset) : 0
  const answer = readAnswer(await read(index.segments.filter(s => s.to >= wanted.from && s.from <= wanted.to)), wanted, offset)
  if (answer !== '') return answer
  return range.from >= index.count
    ? `[m${range.from}] is not among the summarized messages (their ids end at m${index.count - 1}): what came later is still in your context.`
    : `[m${range.from}] could not be read from the archive of this session. Try query to search what was summarized.`
}

// The store.

const preparedKey = (sessionId: string) => `prepared:${sessionId}`
/** How many summaries in a row were started for the session and not kept. */
const unfinishedKey = (sessionId: string) => `unfinished:${sessionId}`
const archiveKey = (sessionId: string) => `archive:${sessionId}`

async function readPrepared($: $, sessionId: string): Promise<Prepared | undefined> {
  return ((await $.store.get(preparedKey(sessionId))) ?? undefined) as Prepared | undefined
}

/** Lists the session under `list`, and forgets the keys of all but the latest `keep` sessions. */
async function remember($: $, list: string, sessionId: string, keep: number, keys: ((sessionId: string) => string)[]): Promise<void> {
  const sessions = (((await $.store.get(list)) ?? []) as string[]).filter(id => id !== sessionId)
  sessions.push(sessionId)
  for (const old of sessions.splice(0, Math.max(0, sessions.length - keep))) {
    for (const key of keys) await $.store.delete(key(old))
  }
  await $.store.set(list, sessions)
}

// Settings, and what /async-compaction says.

async function loadSettings($: $, options: PluginOptions): Promise<Settings> {
  const { config, problems } = resolveConfig(options)
  for (const problem of problems) $.ui.log(`${$name}: ${problem}`)
  let instructions = config.prompt
  if (config.promptFile !== undefined) {
    try {
      const path = config.promptFile.startsWith('~/') ? `${await $.env.get('HOME')}${config.promptFile.slice(1)}` : config.promptFile
      const text = await $.fs.read(path)
      if (text.trim() !== '') instructions = text
    } catch (err) {
      $.ui.log(`${$name}: promptFile not read (${messageOf(err)}); using ${config.prompt.trim() ? 'the prompt setting' : 'the built-in prompt'}`)
    }
  }
  return { config, level: LEVELS[config.level], instructions }
}

async function report($: $, rt: Runtime): Promise<string> {
  const { config, level, instructions } = await settingsOf($, rt)
  if (!config.enabled) return 'Off (the enabled setting): Claude Code compacts as it always does.'
  const sessionId = await $.session.id()
  const tokens = (await $.session.usage()).context.tokens
  const { limit, trigger, isAuto } = await thresholds($, rt, config)
  const prepared = await readPrepared($, sessionId)
  const index = await readIndex($, sessionId)
  const now = await $.clock.now()
  const n = (value: number) => Math.round(value).toLocaleString('en-US')
  const lines = [
    `Model ${config.model} · level ${config.level} (summary of at most ${n(level.maxWords)} words` +
      `${level.keepPercent > 0 ? `, ${level.keepPercent}% more of the limit kept raw` : ''}) · ` +
      `${instructions.trim() ? 'custom prompt' : 'built-in prompt'} · recall ${config.recall ? 'on' : 'off'}`,
    `Context: ${tokens === undefined ? 'not measured yet' : `${n(tokens)} tokens`}. ` +
      (isAuto ? `Claude Code compacts at ${n(limit)}` : `Auto-compact is off; the window is ${n(limit)}`) +
      `; the summary starts at ${n(trigger)} (${config.triggerAt}%).`,
  ]
  if (rt.running?.sessionId === sessionId) {
    lines.push(`Summary: being written by ${config.model} for ${duration((now - rt.running.startedAt) / 1000)}, from a context of ${n(rt.running.tokens)} tokens.`)
  } else if (prepared !== undefined) {
    const isUsable = matching(prepared, inContext(await $.session.messages())).prepared !== undefined
    lines.push(
      `Summary: ready. ${prepared.model} wrote it ${duration((now - prepared.createdAt) / 1000)} ago at ${n(prepared.contextTokens)} tokens: ` +
        `${count(prepared.cut, 'message')} (about ${n(prepared.summarizedTokens)} tokens) in ${n(prepared.words)} words. ` +
        (isUsable
          ? 'When the conversation compacts it is swapped in, and everything said since stays as it is.'
          : 'The conversation has changed under it, so compaction will write a new one.'),
    )
  } else {
    lines.push(
      tokens !== undefined && tokens >= trigger
        ? 'Summary: none ready; it is written at the next step, or at compaction itself.'
        : 'Summary: not started; the context is below the trigger.',
    )
  }
  if (config.recall) {
    lines.push(
      index.count > 0
        ? `Recall: ${count(index.count, 'summarized message')} of this session can be read back (${RECALL_TOOL_NAME}).`
        : 'Recall: nothing summarized in this session yet.',
    )
  }
  return lines.join('\n')
}

function count(n: number, noun: string): string {
  return `${n.toLocaleString('en-US')} ${noun}${n === 1 ? '' : 's'}`
}

function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  if (s < 90) return `${s}s`
  if (s < 5400) return `${Math.round(s / 60)}m`
  return `${(s / 3600).toFixed(1)}h`
}

function debug($: $, text: string): void {
  $.ui.log(`${$name}: ${text}`, { to: 'debug' })
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
