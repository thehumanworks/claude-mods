// Generated filler for the fixtures: tool output with nothing in it, and the
// distractor steps that pad a hand-written conversation to the size of a real
// session. All of it is deterministic: the same seed gives the same text.

import { render, type Message } from '../hooks/transcript.ts'

export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
export const pick = <T>(r: () => number, items: readonly T[]): T => items[Math.floor(r() * items.length)]!
export const hex = (r: () => number, n: number) => Array.from({ length: n }, () => Math.floor(r() * 16).toString(16)).join('')
const capital = (word: string) => word.replace(/^./, c => c.toUpperCase())

export const NOUNS = ['ledger', 'batch', 'cursor', 'tenant', 'shard', 'window', 'bucket', 'quota', 'retry', 'lease', 'session', 'payload', 'digest', 'offset', 'worker', 'queue']
export const VERBS = ['load', 'flush', 'merge', 'verify', 'rotate', 'resolve', 'collect', 'expire', 'publish', 'acquire', 'release', 'decode']

export function logLines(seed: number, n: number, service: string): string {
  const r = rng(seed)
  const lines: string[] = []
  let ms = 100 + Math.floor(r() * 800)
  for (let i = 0; i < n; i++) {
    ms += Math.floor(r() * 400)
    const level = pick(r, ['INFO', 'INFO', 'INFO', 'DEBUG', 'DEBUG', 'WARN'])
    lines.push(
      `2026-10-0${1 + (i % 8)}T09:${String(10 + (i % 45)).padStart(2, '0')}:${String(ms % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}Z ${level} ${service} ` +
        `${pick(r, VERBS)}_${pick(r, NOUNS)} id=${hex(r, 8)} took=${Math.floor(r() * 900)}ms ${pick(r, NOUNS)}=${Math.floor(r() * 5000)}`,
    )
  }
  return lines.join('\n')
}

export function pyCode(seed: number, n: number): string {
  const r = rng(seed)
  const out: string[] = []
  for (let i = 0; i < n; i++) {
    const fn = `${pick(r, VERBS)}_${pick(r, NOUNS)}`
    const a = pick(r, NOUNS)
    const b = pick(r, NOUNS)
    out.push(
      `def ${fn}(${a}, ${b}=None):\n    """${capital(pick(r, VERBS))} the ${a} for a ${b}."""\n    if ${b} is None:\n        ${b} = default_${b}()\n` +
        `    ${a}_state = ${pick(r, VERBS)}(${a}, limit=${Math.floor(r() * 500)})\n    return ${pick(r, VERBS)}_${pick(r, NOUNS)}(${a}_state, ${b})\n`,
    )
  }
  return out.join('\n\n')
}

export function tsCode(seed: number, n: number): string {
  const r = rng(seed)
  const out: string[] = []
  for (let i = 0; i < n; i++) {
    const fn = `${pick(r, VERBS)}${capital(pick(r, NOUNS))}`
    const a = pick(r, NOUNS)
    out.push(
      `export async function ${fn}(${a}: ${capital(a)}, opts: Options = {}): Promise<Result> {\n` +
        `  const ${pick(r, NOUNS)}Key = \`${pick(r, NOUNS)}:\${${a}.id}\`\n  if (opts.dryRun) return { ok: true, changed: 0 }\n` +
        `  const changed = await ${pick(r, VERBS)}(${a}, { limit: ${Math.floor(r() * 300)} })\n  return { ok: true, changed }\n}`,
    )
  }
  return out.join('\n\n')
}

export function csvRows(seed: number, n: number): string {
  const r = rng(seed)
  const rows = ['order_id,account,region,month,net_eur,units']
  for (let i = 0; i < n; i++) {
    rows.push(`${10000 + Math.floor(r() * 89999)},acc_${hex(r, 5)},${pick(r, ['north', 'south', 'east', 'west', 'central'])},2025-${String(1 + Math.floor(r() * 12)).padStart(2, '0')},${(r() * 4000).toFixed(2)},${1 + Math.floor(r() * 40)}`)
  }
  return rows.join('\n')
}

export function prose(seed: number, n: number, topic: string): string {
  const r = rng(seed)
  const starts = ['Note that', 'In practice', 'As a rule', 'By default', 'Historically', 'For most teams', 'In the common case', 'When in doubt']
  const out: string[] = []
  for (let i = 0; i < n; i++) {
    out.push(`${pick(r, starts)} the ${pick(r, NOUNS)} ${pick(r, VERBS)}s the ${pick(r, NOUNS)} before the ${pick(r, NOUNS)} can ${pick(r, VERBS)} it, which matters for ${topic}.`)
  }
  return out.join(' ')
}

function yamlBlock(seed: number, n: number): string {
  const r = rng(seed)
  const out: string[] = []
  for (let i = 0; i < n; i++) {
    out.push(`${pick(r, NOUNS)}:\n${Array.from({ length: 4 }, () => `  ${pick(r, NOUNS)}_${pick(r, VERBS)}: ${Math.floor(r() * 9000)}`).join('\n')}`)
  }
  return out.join('\n')
}

function table(seed: number, n: number): string {
  const r = rng(seed)
  const rows = ['region   month     net_eur      units  accounts']
  for (let i = 0; i < n; i++) {
    rows.push(
      `${pick(r, ['north', 'south', 'east', 'west', 'central']).padEnd(8)} 2025-${String(1 + Math.floor(r() * 12)).padStart(2, '0')}  ${(4_000_000 + r() * 3_000_000).toFixed(1).padStart(11)}  ${String(Math.floor(r() * 90000)).padStart(6)}  ${String(Math.floor(r() * 2000)).padStart(8)}`,
    )
  }
  return rows.join('\n')
}

/**
 * What pads one fixture: the side steps an assistant takes in a session of this
 * kind. `nearMisses` are lines that look like the planted facts and are not
 * them (another timeout, another migration, last quarter's branch): a summary
 * that picks one up in place of the fact gets the probe wrong.
 */
export type Theme = {
  kind: 'py' | 'ts' | 'data' | 'ops' | 'docs' | 'config'
  files: readonly string[]
  commands: readonly string[]
  nearMisses: readonly string[]
  notes: readonly string[]
  /** How long the padded conversation is, rendered as the compaction model reads it at the balanced level. */
  targetChars: number
}

function body(theme: Theme, seed: number, r: () => number): string {
  const n = 3 + Math.floor(r() * 5)
  switch (theme.kind) {
    case 'py':
      return pyCode(seed, n + 2)
    case 'ts':
      return tsCode(seed, n + 2)
    case 'data':
      return r() < 0.5 ? table(seed, 8 + n * 3) : csvRows(seed, 8 + n * 3)
    case 'ops':
      return r() < 0.5 ? logLines(seed, 6 + n * 2, pick(r, ['kubelet', 'kestrel-consumer', 'helm', 'kcat'])) : yamlBlock(seed, 5 + n * 2)
    case 'docs':
      return `# ${capital(pick(r, NOUNS))} ${pick(r, NOUNS)}s\n\n${prose(seed, 6 + n, 'the reference')}\n\n## ${capital(pick(r, VERBS))} a ${pick(r, NOUNS)}\n\n${prose(seed + 1, 5 + n, 'day-to-day use')}`
    case 'config':
      return r() < 0.5 ? yamlBlock(seed, 5 + n * 2) : pyCode(seed, n + 1)
  }
}

/** One side step: a tool call and its result, a near-miss somewhere in about half of them. */
function sideStep(theme: Theme, seed: number): Message[] {
  const r = rng(seed)
  let output = body(theme, seed, r)
  if (r() < 0.5) {
    const lines = output.split('\n')
    lines.splice(Math.floor(r() * lines.length), 0, pick(r, theme.nearMisses))
    output = lines.join('\n')
  }
  const narration = r() < 0.35 ? pick(r, theme.notes) : ''
  const isCommand = r() < 0.4
  const use = isCommand ? { tool: 'Bash', input: { command: pick(r, theme.commands) } } : { tool: 'Read', input: { file_path: pick(r, theme.files) } }
  return [
    { role: 'assistant', text: narration, toolUses: [use] },
    { role: 'user', text: '', toolResults: [{ text: output }] },
  ]
}

const rendered = (messages: readonly Message[]) => render(messages, { maxToolChars: 1500, refs: true }).length

/**
 * The conversation with side steps spread through it until it renders to about
 * `theme.targetChars`. A step goes only where the assistant is about to act
 * (after a prompt or a tool result), so the hand-written order of events, and
 * every call and its result, stay as they are.
 */
export function pad(messages: readonly Message[], theme: Theme, seed: number): Message[] {
  const slots: number[] = []
  for (let i = 1; i < messages.length; i++) if (messages[i]!.role === 'assistant' && messages[i - 1]!.role === 'user') slots.push(i)
  const missing = theme.targetChars - rendered(messages)
  if (slots.length === 0 || missing <= 0) return [...messages]
  const steps: Message[][] = []
  let size = 0
  for (let k = 0; size < missing; k++) {
    const step = sideStep(theme, seed * 1000 + k)
    steps.push(step)
    size += rendered(step) + 2
  }
  const perSlot = new Map<number, Message[]>()
  steps.forEach((step, k) => {
    const slot = slots[Math.floor((k * slots.length) / steps.length)]!
    perSlot.set(slot, [...(perSlot.get(slot) ?? []), ...step])
  })
  return messages.flatMap((m, i) => [...(perSlot.get(i) ?? []), m])
}
