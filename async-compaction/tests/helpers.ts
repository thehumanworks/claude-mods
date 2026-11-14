import type { On, SessionMessage } from 'claude-code'
import { mock, type Engine } from 'claude-code/testing'

export const user = (text: string): SessionMessage => ({ role: 'user', text, toolUses: [] })
export const assistant = (text: string): SessionMessage => ({ role: 'assistant', text, toolUses: [] })
export const calls = (tool: string, input: Record<string, unknown>, id = 'tu1'): SessionMessage => ({
  role: 'assistant',
  text: '',
  toolUses: [{ tool_use_id: id, tool, input }],
})
export const result = (text: string, id = 'tu1'): SessionMessage => ({
  role: 'user',
  text: '',
  toolUses: [],
  toolResults: [{ tool_use_id: id, text, isError: false } as never],
})
/**
 * One reply that makes three tool calls at once, numbered `n`: its thinking
 * (a row with no text), the calls and their results. `order` is where the
 * rows stand: 'compact' as compaction has them, every call before the first
 * result; 'early' and 'late' as `$.session.messages()` has had them, in the
 * order they came, the first result before the second call or before the third.
 */
export function parallelReply(n: number, order: 'compact' | 'early' | 'late'): SessionMessage[] {
  const [a, b, c] = ['a', 'b', 'c'].map(k => calls('Bash', { command: `step ${n}${k}` }, `tu${n}${k}`)) as [SessionMessage, SessionMessage, SessionMessage]
  const [ra, rb, rc] = ['a', 'b', 'c'].map(k => result(`${n}${k}: ${'x'.repeat(4000)}`, `tu${n}${k}`)) as [SessionMessage, SessionMessage, SessionMessage]
  const thinking = assistant('')
  if (order === 'compact') return [thinking, a, b, c, ra, rb, rc]
  return order === 'early' ? [thinking, a, ra, b, c, rb, rc] : [thinking, a, b, ra, c, rb, rc]
}

/** A message as `session.compact` carries it: with the engine's handle. */
export const handled = (messages: SessionMessage[]): SessionMessage[] => messages.map((m, i) => ({ ...m, handle: `h${i}` }))

/** `n` turns of about 1,000 estimated tokens each, numbered from `first`. */
export const conversation = (n: number, first = 1): SessionMessage[] =>
  Array.from({ length: n }, (_, i) => [
    user(`turn ${i + first}: ${'lorem '.repeat(330)}`),
    assistant(`reply ${i + first}: ${'ipsum '.repeat(330)}`),
  ]).flat()

export type World = {
  /** The context size the last response reported. */
  tokens?: number
  messages: SessionMessage[]
  /** Claude Code's auto-compact limit as it reports it. Default 160k: the default trigger (75%) is then 120k. */
  limit?: number
  /** The auto-compact window Claude Code measures against (`rawMaxTokens`). Default 180k. */
  compactWindow?: number
  env?: Record<string, string>
  /** What an earlier process left in the plugin's store. */
  store?: Record<string, unknown>
  files?: Record<string, string>
  /** The compaction model answers nothing. */
  isFailing?: boolean
  /** The compaction model takes this long to answer. */
  summarySeconds?: number
  /** What the compaction model answers, given the request. */
  answer?: (request: { prompt: string; system: string }, n: number) => string
  /** Every reply uses this many output tokens: at the cap, it was cut off. */
  outputTokens?: number
  /** The API refuses a request longer than this, as one that does not fit the model's window. */
  refusesOver?: number
  sessionId?: string
}

/** Stands in for Claude Code beneath the plugin. */
export function engine(on: On, world: World) {
  const store = new Map(Object.entries(world.store ?? {}))
  const env = new Map(Object.entries({ HOME: '/home/me', ...world.env }))
  const files = new Map(Object.entries(world.files ?? {}))
  const seen = {
    completions: [] as { model: string; prompt: string; system: string; effort?: string; maxTokens?: number }[],
    core: [] as string[],
    toasts: [] as string[],
    logs: [] as string[],
    commands: [] as string[],
    tools: [] as { name: string; isDeferred?: boolean }[],
    store,
    files,
  }
  on('store.get', (_, e) => ({ value: store.get(e.key) }) as never)
  on('store.set', (_, e) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined } as never
  })
  on('store.delete', (_, e) => {
    store.delete(e.key)
    return { value: undefined } as never
  })
  on('env.get', (_, e) => ({ value: env.get(e.name) }) as never)
  const clock = mock.clock(on, { now: 1_000_000 })
  on('session.id', () => ({ value: world.sessionId ?? 'session-1' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.messages', () => ({ value: world.messages }))
  on('session.usage', (_, e) => ({
    value: {
      startedAt: 0,
      rateLimits: [],
      context: {
        tokens: world.tokens,
        window: 200_000,
        ...(e.breakdown && {
          breakdown: { autoCompactThreshold: world.limit ?? 160_000, rawMaxTokens: world.compactWindow ?? 180_000, autocompactSource: 'model-default', isAutoCompactEnabled: true },
        }),
      },
    } as never,
  }))
  on('model.complete', async (_, e) => {
    const request = { model: e.model, prompt: String(e.prompt), system: String(e.system ?? ''), effort: e.effort, maxTokens: e.maxTokens }
    seen.completions.push(request)
    const n = seen.completions.length
    if (world.summarySeconds !== undefined) await clock.sleep(world.summarySeconds * 1000)
    if (world.refusesOver !== undefined && request.prompt.length > world.refusesOver) {
      return { value: { isAnswered: false, reason: 'api-error', status: 400, error: 'invalid_request', usage: {} } } as never
    }
    if (world.isFailing) return { value: { isAnswered: false, reason: 'timeout' } } as never
    const usage = { input_tokens: 1, output_tokens: world.outputTokens ?? 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
    // Cites the first message id it was shown, as the compaction model is asked to.
    const ref = /(\[m\d+\]) (?:USER|ASSISTANT)/.exec(request.prompt)?.[1]
    // Without ids to cite, a summary is told from a refusal by its length.
    const body = /\[m\d+\]/.test(request.prompt) ? '' : `\n${'It went on. '.repeat(120)}`
    const text = world.answer?.(request, n) ?? `SUMMARY ${n}${ref ? ` ${ref}` : ''}${body}`
    return { value: { isAnswered: true, text, usage } } as never
  })
  on('command.register', (_, e) => {
    seen.commands.push(e.name)
    return { value: { command: e.name } } as never
  })
  on('tool.register', (_, e) => {
    seen.tools.push({ name: e.name, isDeferred: e.isDeferred })
    return { value: { tool: `mcp__async-compaction__${e.name}` } } as never
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.log', (_, e) => {
    if ((e as { to?: string }).to !== 'debug') seen.logs.push(JSON.stringify(e))
    return { value: undefined } as never
  })
  on('ui.toast', (_, e) => {
    seen.toasts.push(JSON.stringify(e))
    return { value: undefined } as never
  })
  on('fs.write', (_, e) => {
    files.set(e.path, e.text)
    return { value: undefined } as never
  })
  on('fs.read', (_, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text } as never
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'ok' } }) as never)
  on('session.compact', (_, e) => {
    seen.core.push(e.trigger)
    return { messages: [user('CORE SUMMARY')] }
  })
  on('classic.SessionStart', () => ({}))
  return { seen, clock }
}

type Clock = { settle: () => Promise<void>; advance: (ms: number) => Promise<void> }

export async function endTurn($: Engine, clock: Clock): Promise<void> {
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never)
  await clock.settle()
}

/** A tool call inside a turn, as the main loop makes one. */
export async function toolCall($: Engine, clock: Clock): Promise<void> {
  await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  await clock.settle()
}

export type Compacted = { messages?: readonly SessionMessage[]; skip?: string }

export const compact = ($: Engine, messages: SessionMessage[], more: Record<string, unknown> = {}) =>
  $.session.compact({ trigger: 'auto', messages: handled(messages), ...more } as never) as Promise<Compacted>

export const recall = async ($: Engine, input: Record<string, unknown>): Promise<string> => {
  const answer = (await $.tool.call({ tool: 'mcp__async-compaction__recall', ...input } as never)) as { result?: unknown; deny?: string; text?: string }
  return String(answer.result ?? answer.text ?? answer.deny)
}

export async function resume($: Engine, clock: Clock, contextTokens: number): Promise<void> {
  await $.classic.SessionStart({ source: 'resume', transcript_path: '/home/me/.claude/projects/p/session-1.jsonl', context_tokens: contextTokens } as never)
  await clock.settle()
}
