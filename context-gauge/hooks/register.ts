// Context gauge: the context's fill against Claude Code's auto-compact limit on
// the status line, and one note to Claude each time it passes a band.

import type { EngineInterface, Register } from 'claude-code'
import { crossedBand, limitOf, note, parseBands, statusLine } from './gauge.js'

type $ = EngineInterface

/** What the hooks share for this load of the module. */
type State = {
  bands: readonly number[]
  /** The session the bands below were noted in: another one (`/clear`, a resume) starts over. */
  sessionId?: string
  /** The highest band Claude was told of since the last compaction; 0 for none. */
  noted: number
  /** The context size at the last tool-call check: parallel calls of one response measure once. */
  checkedTokens?: number
}

const $name = 'context-gauge'

export const register: Register = (on, options) => {
  const { bands, problems } = parseBands(options.bands)
  const state: State = { bands, noted: 0 }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    for (const problem of problems) $.ui.log(`${$name}: ${problem}`)
    await refresh($, state)
    return started
  })

  // After each main-thread turn, and whenever the engine's figures move.
  on('session.measure', async ($, e, next) => {
    const measured = await next(e)
    if (e.changed.includes('context')) await refresh($, state)
    return measured
  })

  // A note for the request that follows the user's prompt: the last response of a turn may have crossed a band.
  on('prompt.submit', async ($, e, next) => {
    const before = state.noted
    const text = await measure($, state, true)
    if (text === undefined) return next(e)
    const submitted = await next({ ...e, context: [...(e.context ?? []), text] })
    // A prompt that did not enter carried no note: the band is still to tell.
    if (submitted.drop !== undefined && state.noted > before) state.noted = before
    return submitted
  }).catch(($, e, next) => next(e))

  // Inside a turn: a note after a tool's result, read with the next request. Main loop only.
  on('tool.call', async ($, e, next) => {
    const called = await next(e)
    if (e.agentId !== undefined || called.deny !== undefined) return called
    const { tokens } = (await $.session.usage()).context
    if (tokens === undefined || tokens === state.checkedTokens) return called
    state.checkedTokens = tokens
    const text = await measure($, state, true)
    if (text === undefined) return called
    return { ...called, context: [...(called.context ?? []), text] }
  }).catch(($, e, next) => next(e))

  // A compaction of the main conversation starts the bands over, whoever wrote its summary.
  on('session.append', { door: 'compaction' }, async ($, e, next) => {
    const appended = await next(e)
    if (e.agentId === undefined) {
      reset($, state, 'compaction')
      await refresh($, state)
    }
    return appended
  }).catch(($, e, next) => next(e))

  on('session.compact', async ($, e, next) => {
    const compacted = await next(e)
    if (e.agentId === undefined && e.trigger !== 'precompute' && compacted.skip === undefined) {
      reset($, state, `compaction (${e.trigger})`)
      await refresh($, state)
    }
    return compacted
  }).catch(($, e, next) => next(e))

  // `/autocompact` and the auto-compact toggle move the limit: redraw at once.
  on('command.run', { command: 'autocompact' }, async ($, e, next) => {
    const ran = await next(e)
    await refresh($, state)
    return ran
  }).catch(($, e, next) => next(e))
  on('config.set', { key: 'autoCompact' }, async ($, e, next) => {
    const set = await next(e)
    await refresh($, state)
    return set
  }).catch(($, e, next) => next(e))
}

/**
 * Reads the context size and the limit (both fresh, never cached), redraws
 * the status line, and answers the note to send when a band was crossed.
 * The band is claimed with no await between the comparison and the update,
 * so two checks at once never give two notes.
 */
async function measure($: $, state: State, wantsNote: boolean): Promise<string | undefined> {
  const [sessionId, { context }, override] = await Promise.all([
    $.session.id(),
    $.session.usage({ breakdown: 'summary' }),
    $.env.get('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE'),
  ])
  const limit = limitOf(context, Number(override))
  if (state.sessionId !== sessionId) Object.assign(state, { sessionId, noted: 0, checkedTokens: undefined })
  const tokens = context.tokens
  $.ui.status(statusLine(tokens, limit))
  if (!wantsNote || tokens === undefined) return undefined
  const band = crossedBand(tokens, limit.tokens, state.bands, state.noted)
  if (band === undefined) return undefined
  state.noted = band
  $.ui.log(`${$name}: band ${band}% crossed at ${tokens} of ${limit.tokens} tokens`, { to: 'debug' })
  return note(band, tokens, limit)
}

/** The status line alone. Never throws. */
async function refresh($: $, state: State): Promise<void> {
  try {
    await measure($, state, false)
  } catch (err) {
    $.ui.log(`${$name}: not measured: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
  }
}

function reset($: $, state: State, why: string): void {
  if (state.noted > 0) $.ui.log(`${$name}: bands reset (${why})`, { to: 'debug' })
  state.noted = 0
  state.checkedTokens = undefined
}
