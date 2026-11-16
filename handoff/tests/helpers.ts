import type { On } from 'claude-code'
import { mock, type Engine } from 'claude-code/testing'

/** What the model answers: its text, a failure of the call, or a throw. */
export type ModelAnswer = string | { fail: 'api-error' | 'aborted' | 'empty-reply' } | 'throw'

export type World = {
  /** The working directory. */
  cwd?: string
  /** What `git rev-parse --show-toplevel` prints; undefined: not a repository. */
  gitRoot?: string
  sessionId?: string
  /** What the model answers; a function answers per call. */
  answer?: ModelAnswer | ((n: number) => ModelAnswer)
  /** How long the model takes to answer, in milliseconds of the mocked clock. */
  delayMs?: number
  /** What the store holds at the start. */
  store?: Record<string, unknown>
  /** A compaction of this trigger is vetoed beneath, as a PreCompact hook that blocks. */
  skipTrigger?: string
}

export type Asked = { model: string; system: string; prompt: string; timeoutMs?: number; maxTokens?: number }

/** Stands in for Claude Code beneath the plugin: session, git, tools, turns, the model call and the store. */
export function engine(on: On, world: World = {}) {
  const seen = { asked: [] as Asked[], logs: [] as string[], registered: [] as string[] }
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  const store = new Map(Object.entries(world.store ?? {}))
  on('store.get', (_, e) => ({ value: store.get(e.key) }) as never)
  on('store.set', (_, e) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined } as never
  })
  on('session.id', () => ({ value: world.sessionId ?? 'session-1' }))
  on('session.cwd', () => ({ value: world.cwd ?? '/work/app/src' }))
  on('process.run', (_, e) => {
    const isGit = e.argv[0] === 'git' && e.argv.includes('--show-toplevel')
    if (isGit && world.gitRoot !== undefined) return { value: { exitCode: 0, stdout: `${world.gitRoot}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
    return { value: { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('command.register', (_, e) => {
    seen.registered.push(e.name)
    return { value: { command: e.name } } as never
  })
  on('tool.call', (_, e) => {
    if ((e as { fail?: boolean }).fail) return { isError: true, result: 'failed', text: 'failed' } as never
    return { result: {}, text: 'ok' } as never
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))
  on('classic.SessionStart', () => ({}) as never)
  on('session.compact', (_, e) => e.trigger === world.skipTrigger ? { skip: 'blocked' } : ({ messages: [{ role: 'user', text: 'SUMMARY by the compactor', toolUses: [] }] }))
  on('model.complete', async (_, e) => {
    const n = seen.asked.length
    seen.asked.push({ model: e.model, system: String(e.system ?? ''), prompt: String(e.prompt), timeoutMs: e.timeoutMs, maxTokens: e.maxTokens })
    if (world.delayMs !== undefined) await clock.sleep(world.delayMs)
    const usage = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
    const raw = world.answer ?? 'Work: the parser.\nDone: fixed a bug.\nNext: tests.\nOpen problems: none'
    const answer = typeof raw === 'function' ? raw(n) : raw
    if (answer === 'throw') throw new Error('model blocked')
    if (typeof answer === 'string') return { value: { isAnswered: true, text: answer, usage } } as never
    if (answer.fail === 'api-error') return { value: { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage } } as never
    return { value: { isAnswered: false, reason: answer.fail, usage } } as never
  })
  on('ui.log', (_, e) => {
    if ((e as { to?: string }).to !== 'debug') seen.logs.push(String((e as { text?: string }).text))
    return { value: undefined } as never
  })

  let ids = 0
  const call = async ($: Engine, input: Record<string, unknown>) => {
    await $.tool.call({ tool_use_id: `toolu_${++ids}`, ...input } as never)
  }
  const api = {
    seen,
    clock,
    edit: ($: Engine, file: string, more: Record<string, unknown> = {}) => call($, { tool: 'Edit', file_path: file, old_string: 'a', new_string: 'b', ...more }),
    bash: ($: Engine, command: string, more: Record<string, unknown> = {}) => call($, { tool: 'Bash', command, ...more }),
    read: ($: Engine, file: string, more: Record<string, unknown> = {}) => call($, { tool: 'Read', file_path: file, ...more }),
    /** A main-loop turn: its prompt, what `body` does, its end; then whatever it set off runs. */
    turn: async ($: Engine, text: string, body: () => Promise<void> = async () => {}, answer = 'Done for now.', agentId?: string) => {
      const turnId = `turn_${++ids}`
      await $.turn.start({ text, turnId, ...(agentId && { agentId }) } as never)
      await body()
      await $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId, reason: 'answer', ...(agentId && { agentId }) } as never)
      await clock.settle()
    },
    /** What Claude reads beside a prompt. */
    prompt: async ($: Engine, text = 'go on', more: Record<string, unknown> = {}): Promise<readonly string[]> => {
      const submitted = await $.prompt.submit({ text, wait: false, origin: { kind: 'user' }, ...more } as never)
      return (submitted as { context?: readonly string[] }).context ?? []
    },
    command: async ($: Engine): Promise<string> => ((await $.command.run({ command: 'handoff', args: '' } as never)) as { text: string }).text,
    compact: ($: Engine, more: Record<string, unknown> = {}) =>
      $.session.compact({ trigger: 'auto', messages: [{ role: 'user', text: 'hello', toolUses: [], handle: 'h0' }], ...more } as never) as Promise<{ messages?: { text: string }[]; skip?: string }>,
    end: async ($: Engine, reason = 'prompt_input_exit') => {
      await $.session.end({ reason, sessionId: world.sessionId ?? 'session-1', resume: { id: world.sessionId ?? 'session-1' } } as never)
      await clock.settle()
    },
    /** The notes the store holds. */
    notes: async (_$: Engine) => (store.get('notes') ?? {}) as Record<string, { note: string; writtenAt: number; model: string }>,
  }
  return api
}

/** Five tool calls that edit nothing. */
export const fiveReads = (h: ReturnType<typeof engine>, $: Engine) => async () => {
  for (let i = 0; i < 5; i++) await h.read($, `/work/app/src/f${i}.ts`)
}
