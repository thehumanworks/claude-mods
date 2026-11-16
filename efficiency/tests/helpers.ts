import type { On } from 'claude-code'
import { mock, type Engine } from 'claude-code/testing'

/** What the model answers: its text, a failure of the call, or a throw. */
export type ModelAnswer = string | { fail: 'api-error' | 'aborted' | 'empty-reply' } | 'throw'

export type World = {
  cwd?: string
  /** What `git rev-parse --show-toplevel` prints; undefined: not a repository. */
  gitRoot?: string
  /** The session's id; changed between sessions with `h.session`. */
  sessionId?: string
  /** The tools the session's tool list holds. */
  tools?: string[]
  /** What the model answers. */
  answer?: ModelAnswer
  /** The store at the start. */
  store?: Record<string, unknown>
  /** Files `$.fs` reads, by absolute path. */
  files?: Record<string, string>
}

export type Asked = { model: string; system: string; prompt: string; timeoutMs?: number; maxTokens?: number }

/** Stands in for Claude Code beneath the plugin: session, git, tools, turns, the model call, the store and files. */
export function engine(on: On, world: World = {}) {
  const seen = { asked: [] as Asked[], logs: [] as string[], registered: [] as string[], toolLists: 0 }
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  const store = new Map(Object.entries(world.store ?? {}))
  const state = { sessionId: world.sessionId ?? 'session-1', cwd: world.cwd ?? '/work/app/src', tools: world.tools ?? ['Bash', 'Read', 'Edit'] }
  on('store.get', (_, e) => ({ value: store.get(e.key) }) as never)
  on('store.set', (_, e) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined } as never
  })
  on('store.delete', (_, e) => {
    store.delete(e.key)
    return { value: undefined } as never
  })
  on('session.id', () => ({ value: state.sessionId }))
  on('session.cwd', () => ({ value: state.cwd }))
  on('process.run', (_, e) => {
    const isGit = e.argv[0] === 'git' && e.argv.includes('--show-toplevel')
    if (isGit && world.gitRoot !== undefined) return { value: { exitCode: 0, stdout: `${world.gitRoot}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
    return { value: { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })
  on('fs.exists', (_, e) => ({ value: world.files?.[e.path] !== undefined }) as never)
  on('fs.read', (_, e) => {
    const text = world.files?.[e.path]
    if (text === undefined) throw new Error('ENOENT')
    return { value: text } as never
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('command.register', (_, e) => {
    seen.registered.push(e.name)
    return { value: { command: e.name } } as never
  })
  on('tool.list', () => {
    seen.toolLists++
    return { value: state.tools.map(name => ({ name, description: name, mcp: name.startsWith('mcp__') })) } as never
  })
  on('tool.call', (_, e) => {
    const input = e as unknown as { fail?: boolean; deny?: boolean; size?: number }
    if (input.deny) return { deny: 'refused by a rule' } as never
    if (input.fail) return { isError: true, result: 'failed', text: 'Error: it failed' } as never
    return { result: {}, text: 'x'.repeat(input.size ?? 2) } as never
  })
  on('tool.describe', (_, e) => ({ description: e.description, ...(e.isDeferred && { isDeferred: true }) }) as never)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('session.compact', () => ({ messages: [{ role: 'user', text: 'SUMMARY', toolUses: [] }] }) as never)
  on('model.complete', (_, e) => {
    seen.asked.push({ model: e.model, system: String(e.system ?? ''), prompt: String(e.prompt), timeoutMs: e.timeoutMs, maxTokens: e.maxTokens })
    const usage = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
    const answer = world.answer ?? '1. Deny the unused server first [1].'
    if (answer === 'throw') throw new Error('model blocked')
    if (typeof answer === 'string') return { value: { isAnswered: true, text: answer, usage } } as never
    if (answer.fail === 'api-error') return { value: { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage } } as never
    return { value: { isAnswered: false, reason: answer.fail, usage } } as never
  })
  on('ui.log', (_, e) => {
    if ((e as { to?: string }).to !== 'debug') seen.logs.push(String((e as { text?: string }).text))
    return { value: undefined } as never
  })
  on('ui.status', () => ({ value: undefined }) as never)

  let ids = 0
  const api = {
    seen,
    clock,
    store,
    state,
    /** One of Claude's tool calls; `fail`, `deny` and `size` say how it ends. */
    call: async ($: Engine, tool: string, input: Record<string, unknown> = {}) => {
      await $.tool.call({ tool, tool_use_id: `toolu_${++ids}`, ...input } as never)
    },
    /** A main-loop turn: its start, what `body` does, its end; then whatever it set off runs. */
    turn: async ($: Engine, body: () => Promise<void> = async () => {}) => {
      const turnId = `turn_${++ids}`
      await $.turn.start({ text: 'do it', turnId } as never)
      await body()
      await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId, reason: 'answer' } as never)
      await clock.settle()
    },
    /** A session: it starts, runs `body` in a turn and ends. */
    session: async ($: Engine, id: string, body: () => Promise<void> = async () => {}) => {
      state.sessionId = id
      await $.session.start({ cwd: state.cwd, surface: null, isInteractive: false } as never)
      await api.turn($, body)
      await $.session.end({ reason: 'other', sessionId: id } as never)
      await clock.settle()
    },
    command: async ($: Engine): Promise<string> => ((await $.command.run({ command: 'efficiency', args: '' } as never)) as { text: string }).text,
    compact: ($: Engine) => $.session.compact({ trigger: 'auto', messages: [{ role: 'user', text: 'hello', toolUses: [], handle: 'h0' }] } as never),
  }
  return api
}
