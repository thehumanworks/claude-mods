// Counting failing tool calls, free of the engine, so the tests run the same code.

export const DEFAULT_THRESHOLD = 3
export const THRESHOLD_MIN = 2
export const THRESHOLD_MAX = 20
/** The last error is quoted to Claude up to this many characters. */
export const ERROR_CHARS = 300
/** The call is named, in the note and the toast, up to this many characters. */
export const LABEL_CHARS = 160
/** Failing calls remembered per loop: the oldest is forgotten past this. */
const MAX_KEYS = 50

/** Keys of `tool.call`'s input that are the engine's, not the tool's arguments. */
const RESERVED = new Set(['tool', 'tool_use_id', 'agentId', 'requestMeta', 'consent'])

/** One tool call as the counter sees it. */
export type Call = {
  tool: string
  /** The tool's arguments; reserved keys are ignored. */
  input: Readonly<Record<string, unknown>>
  /** The subagent or teammate the call ran in; absent on the main loop. */
  agentId?: string
}

/** What came of the call. */
export type Outcome = {
  isError: boolean
  /** The tool ran the input read-only (core's `isReadOnly`): a look around, not a change of approach. */
  isReadOnly?: boolean
  text?: string
}

/** A call that has failed `threshold` times in a row. */
export type Loop = {
  key: string
  /** The call as Claude made it: the command for Bash, else `Tool {input}`. */
  label: string
  count: number
  /** The last error, whitespace collapsed, at most ERROR_CHARS. */
  lastError: string
}

type Failing = { count: number; isNoted: boolean }

const squash = (text: string) => text.replace(/\s+/g, ' ').trim()

export const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

/** The input with its keys sorted and every string's whitespace collapsed. */
function canonical(value: unknown): unknown {
  if (typeof value === 'string') return squash(value)
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(k => [k, canonical((value as Record<string, unknown>)[k])]),
    )
  }
  return value
}

const argsOf = (input: Readonly<Record<string, unknown>>) =>
  Object.fromEntries(Object.entries(input).filter(([k, v]) => !RESERVED.has(k) && v !== undefined))

/**
 * What makes two calls the same call: the tool and its input, whitespace
 * normalised. For Bash only the command counts (not its description or timeout).
 */
export function keyOf(call: Call): string {
  if (call.tool === 'Bash' && typeof call.input.command === 'string') return `Bash\0${squash(call.input.command)}`
  return `${call.tool}\0${JSON.stringify(canonical(argsOf(call.input)))}`
}

export function labelOf(call: Call): string {
  if (call.tool === 'Bash' && typeof call.input.command === 'string') return clip(squash(call.input.command), LABEL_CHARS)
  return clip(`${call.tool} ${JSON.stringify(canonical(argsOf(call.input)))}`, LABEL_CHARS)
}

/**
 * Counts consecutive failures of each call, separately for each agent loop.
 *
 * - A failure adds one to that call's count. Failures of other calls in
 *   between do not reset it.
 * - A success of that call clears its count.
 * - A success of a different call that is not read-only clears every count in
 *   that loop: Claude has changed something. A read-only success (`ls`, Read,
 *   Grep) clears nothing else: looking around and retrying is still a loop.
 * - At the threshold `record` returns the loop once; later failures of that
 *   call return nothing until its count has been cleared.
 */
export class Tracker {
  private loops = new Map<string, Map<string, Failing>>()

  constructor(readonly threshold: number) {}

  record(call: Call, outcome: Outcome): Loop | undefined {
    const loopId = call.agentId ?? ''
    const key = keyOf(call)
    if (!outcome.isError) {
      if (outcome.isReadOnly === true) this.loops.get(loopId)?.delete(key)
      else this.loops.delete(loopId)
      return undefined
    }
    let failing = this.loops.get(loopId)
    if (failing === undefined) this.loops.set(loopId, (failing = new Map()))
    const entry = failing.get(key) ?? { count: 0, isNoted: false }
    failing.delete(key) // re-inserted last: the map is kept oldest first
    failing.set(key, { ...entry, count: entry.count + 1 })
    if (failing.size > MAX_KEYS) failing.delete(failing.keys().next().value!)
    const now = failing.get(key)!
    if (now.isNoted || now.count < this.threshold) return undefined
    now.isNoted = true
    return { key, label: labelOf(call), count: now.count, lastError: clip(squash(outcome.text ?? ''), ERROR_CHARS) }
  }

  /** The count of a call, for tests and debugging. */
  countOf(call: Call): number {
    return this.loops.get(call.agentId ?? '')?.get(keyOf(call))?.count ?? 0
  }
}

/**
 * Whether a `tool.call` is one the model made: raised by the engine and
 * carrying the model's `tool_use_id`. A plugin's own `$.tool.call` is raised
 * under that plugin's name (it gets an id of its own too), and what it
 * answers goes back to the plugin, so a note on it would never reach Claude.
 */
export const isModelCall = (origin: { plugin: string }, toolUseId: string | undefined) =>
  origin.plugin === 'engine' && typeof toolUseId === 'string' && toolUseId !== ''

/** What Claude reads after the failing result. */
export function noteFor(loop: Loop, tool: string): string {
  const what = tool === 'Bash' ? `The Bash command \`${loop.label}\`` : `The call ${loop.label}`
  const error = loop.lastError === '' ? '' : ` Last error: ${loop.lastError}`
  return (
    `loop-breaker: ${what} has now failed ${loop.count} times in a row.${error}\n` +
    'Do not run it again as it is. Work out why it fails and change approach (another command, other input, or a different way to the goal), or ask the user how to proceed.'
  )
}

/** What the user sees. */
export const toastFor = (loop: Loop) => `loop-breaker: failed ${loop.count}× in a row, told Claude to change approach: ${clip(loop.label, 60)}`

/** The threshold from the plugin's options; a value that cannot be used keeps the default and is reported. */
export function resolveThreshold(options: Readonly<Record<string, unknown>>): { threshold: number; problem?: string } {
  const raw = options.threshold
  if (raw === undefined || raw === '') return { threshold: DEFAULT_THRESHOLD }
  const n = typeof raw === 'string' ? Number(raw) : raw
  if (typeof n !== 'number' || !Number.isInteger(n) || n < THRESHOLD_MIN || n > THRESHOLD_MAX) {
    return { threshold: DEFAULT_THRESHOLD, problem: `threshold: ${JSON.stringify(raw)} is not a whole number from ${THRESHOLD_MIN} to ${THRESHOLD_MAX}; using ${DEFAULT_THRESHOLD}` }
  }
  return { threshold: n }
}
