import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

export type World = {
  /** The context size the last response reported; undefined before one has (a fresh or just compacted window). */
  tokens?: number
  /** Claude Code's auto-compact limit as it reports it. Default 160k. */
  limit?: number
  /** The auto-compact window (`rawMaxTokens`). Default 180k. */
  compactWindow?: number
  isAutoCompactEnabled?: boolean
  env?: Record<string, string>
  sessionId?: string
  /** Claude Code leaves the conversation as it is (a PreCompact hook blocked it). */
  isCompactSkipped?: boolean
  /** `$.session.usage` throws. */
  isUsageFailing?: boolean
  /** What core attaches after the tool's result. */
  toolContext?: string[]
}

/** Stands in for Claude Code beneath the plugin. */
export function engine(on: On, world: World) {
  const seen = { status: [] as (string | undefined)[], logs: [] as string[], breakdowns: 0, toolRuns: 0 }
  on('session.id', () => ({ value: world.sessionId ?? 'session-1' }))
  on('env.get', (_, e) => ({ value: world.env?.[e.name] }) as never)
  on('session.usage', (_, e) => {
    if (world.isUsageFailing) throw new Error('usage unavailable')
    if (e.breakdown) seen.breakdowns++
    const isAuto = world.isAutoCompactEnabled ?? true
    return {
      value: {
        startedAt: 0,
        rateLimits: [],
        context: {
          tokens: world.tokens,
          window: 200_000,
          ...(e.breakdown && {
            breakdown: {
              ...(isAuto && { autoCompactThreshold: world.limit ?? 160_000 }),
              rawMaxTokens: world.compactWindow ?? 180_000,
              autocompactSource: 'model-default',
              isAutoCompactEnabled: isAuto,
            },
          }),
        },
      } as never,
    }
  })
  on('ui.status', (_, e) => {
    seen.status.push(e.text)
    return { value: undefined } as never
  })
  on('ui.log', (_, e) => {
    if ((e as { to?: string }).to !== 'debug') seen.logs.push(String((e as { text?: string }).text))
    return { value: undefined } as never
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))
  on('tool.call', () => {
    if (world.isUsageFailing) seen.toolRuns++
    return (world.toolContext ? { result: { stdout: 'ok' }, context: world.toolContext } : { result: { stdout: 'ok' } }) as never
  })
  on('session.compact', () => (world.isCompactSkipped ? { skip: 'not now' } : { messages: [{ role: 'user', text: 'SUMMARY', toolUses: [] }] }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  return { seen }
}

/** What Claude reads beside the user's prompt; `more` adds fields of the submission (a `command`, a `context`). */
export async function prompt($: Engine, text = 'go on', more: Record<string, unknown> = {}): Promise<readonly string[]> {
  const submitted = await $.prompt.submit({ text, wait: false, origin: { kind: 'user' }, ...more } as never)
  return (submitted as { context?: readonly string[] }).context ?? []
}

/** What Claude reads after a tool's result, in the main loop or a subagent's. */
let calls = 0
export async function toolCall($: Engine, agentId?: string): Promise<readonly string[]> {
  const called = await $.tool.call({ tool: 'Bash', command: 'ls', tool_use_id: `tu${++calls}`, ...(agentId && { agentId }) } as never)
  return (called as { context?: readonly string[] }).context ?? []
}

export const compact = ($: Engine, trigger = 'auto') => $.session.compact({ trigger, messages: [{ role: 'user', text: 'hello', toolUses: [], handle: 'h0' }] } as never)

/** The row Claude Code appends when it compacts, whoever wrote the summary. */
export const compactionRow = ($: Engine) =>
  $.session.append({
    message: { type: 'system', content: [{ type: 'text', text: 'Conversation compacted' }] },
    door: 'compaction',
    origin: { kind: 'engine' },
    uuid: 'row-1',
  } as never)
