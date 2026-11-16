// Reading Claude Code's worktree refusals and writing the note, free of the engine, so the tests run the same code.

/**
 * The kinds of refusal Claude Code 2.1.325's worktree git guard gives a
 * worktree-isolated agent's (or session's) Bash command. Each is counted on
 * its own, per agent.
 */
export type Pattern =
  /** "is too complex to verify that it stays inside the worktree", or "names git in a form too complex …". */
  | 'too-complex'
  /** "names git more than once in a single command …". */
  | 'git-twice'
  /** "runs sh/xargs/eval before a git command …", "hands text naming git to a shell". */
  | 'shell-wrapper'
  /** "changes directory (to the shared checkout / via env / to a location computed at runtime) before running git", "-C <runtime>". */
  | 'chdir'
  /** "has a word … that the shell fills in only when the command runs", globs, runtime paths. */
  | 'runtime-value'
  /** GIT_DIR and friends, `-c` config, env flags, ARGV0: "sets X …", "exports X …", "passes X to git, injecting …". */
  | 'git-env'
  /** Any other reason. */
  | 'other'

/**
 * A refusal as parsed from the result. `reason` and `remedy` are quoted to
 * Claude only when they are one of Claude Code's fixed sentences, word for
 * word (`isKnownReason`, `isKnownRemedy`); `worktree` is echoed only once it
 * has been checked against the agent's real directory.
 */
export type Refusal = { pattern: Pattern; worktree: string; reason: string; remedy: string; isKnownReason: boolean; isKnownRemedy: boolean }

/** The full note is given at the first refusal of a pattern; the short reminder from this refusal of it on. */
export const REMINDER_FROM = 3
/** Agents whose counts are kept; the least recently refused is forgotten past this. */
export const MAX_AGENTS = 64

/**
 * The whole result text, exactly as Claude Code 2.1.325 words the git guard's
 * refusal, optionally after the Bash tool's "Exit code N" line:
 * `${noun} is isolated in the worktree ${path}, but this command ${reason}. Refusing to run it — ${possessive} git operations must target its own worktree. ${remedy}`
 * Anchored at both ends, one line: refusal wording inside other output is not it.
 */
const GUARD = /^(?:Exit code \d+\n)?This (agent|session) is isolated in the worktree (\/[^\n]*?), but this command ([^\n]+?)\. Refusing to run it \u2014 a worktree-isolated (agent|session)'s git operations must target its own worktree\. ([^\n]+)$/

/** Claude Code's reasons that hold no part of the command. */
const KNOWN_REASONS = new Set([
  'is too complex to verify that it stays inside the worktree',
  'names git in a form too complex to verify that it stays inside the worktree',
  'names git more than once in a single command, which cannot be verified to stay inside the worktree',
  'passes more than one -C/--chdir to env (last-wins semantics), which cannot be verified',
  'changes directory to a location computed at runtime before running git',
  'redirects git through a glob pattern that expands at runtime',
  'runs git from above the shared checkout, where its operands can reach the checkout',
  'hands text naming git to a shell',
])

/** Claude Code's remedies that hold nothing but the worktree path. */
const KNOWN_REMEDIES = [
  'Split it into plain, separate commands and run them from ',
  'Use one git invocation per command and run it from ',
  'Run the equivalent from %s without the redirect.',
  'Run the plain command from ',
  'Run git directly with literal arguments from ',
]
const isKnownRemedyFor = (remedy: string, worktree: string) =>
  KNOWN_REMEDIES.some(r => (r.includes('%s') ? r.replace('%s', worktree) : `${r}${worktree}.`) === remedy)

/** The refusal, when the result text is exactly Claude Code's; else undefined. */
export function parseRefusal(text: string | undefined): Refusal | undefined {
  if (text === undefined) return undefined
  const m = GUARD.exec(text)
  if (m === null || m[1] !== m[4]) return undefined
  const [worktree, reason, remedy] = [m[2]!, m[3]!, m[5]!]
  return { pattern: classify(reason), worktree, reason: `this command ${reason}`, remedy, isKnownReason: KNOWN_REASONS.has(reason), isKnownRemedy: isKnownRemedyFor(remedy, worktree) }
}

/** The pattern of a guard refusal, from its reason ("this command <reason>."). */
export function classify(reason: string): Pattern {
  const r = reason.toLowerCase()
  if (r.includes('too complex to verify')) return 'too-complex'
  if (r.includes('names git more than once')) return 'git-twice'
  if (/^runs \S+ before a git command|hands text naming git to a shell/.test(r)) return 'shell-wrapper'
  if (/changes directory|points git at a directory|-c\/--chdir|runs git from above/.test(r)) return 'chdir'
  if (/^(?:sets|exports|assigns|re-assigns|runs env with)\b|injecting|redirects git to|passes \S+ to git|points git at a repository|gives \S+ a path/.test(r)) return 'git-env'
  if (/fills? in only when|filled in only when|computed at runtime|glob|can't be verified before it runs|has a word|has \{\}/.test(r)) return 'runtime-value'
  return 'other'
}

/**
 * Whether the worktree named in the refusal is the agent's real one: the
 * top folder of the git worktree its directory is in (`git rev-parse
 * --show-toplevel`, run from the agent's own `$.session.cwd()`), exactly.
 * The guard names that root, so any other path did not come from Claude Code.
 */
export function isAgentWorktree(worktree: string, root: string | undefined): boolean {
  if (root === undefined || !worktree.startsWith('/')) return false
  const trim = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p)
  return trim(worktree) === trim(root) && trim(root) !== '/'
}

/** The fixed tips: the same for every command, so nothing of the refused command is ever suggested back. */
const tips = (wt: string | undefined) =>
  [
    '- Run each git command as its own Bash call.',
    wt === undefined ? '- Use `git -C` with the path of your own worktree, and no other path.' : `- Use \`git -C ${wt}\` with exactly this path.`,
    '- Use no `cd` chains, `$(...)`, pipes into git, or GIT_* variables.',
    '- If you need data from one command, run it first and use its output in the next call.',
  ].join('\n')

/**
 * The full note: Claude Code's reason and remedy when they are its fixed
 * sentences, the worktree when it was checked (`worktree`, else undefined),
 * and the fixed tips. It never quotes the refused command.
 */
export function noteFor(refusal: Refusal, worktree: string | undefined): string {
  const why = refusal.isKnownReason ? `because "${refusal.reason}"` : 'as one it cannot verify stays inside the worktree'
  const remedy = worktree !== undefined && refusal.isKnownRemedy ? ` Its remedy: "${refusal.remedy}"` : ''
  return [
    `worktree-coach: Claude Code refused this command ${why}.${remedy}`,
    ...(worktree === undefined ? [] : [`Your worktree: ${worktree}`]),
    tips(worktree),
    'Do not resend the same command.',
  ].join('\n')
}

/** The short reminder for a pattern Claude has already had the note for. */
export const reminderFor = (count: number, worktree: string | undefined) =>
  `worktree-coach: refused again (${count}× this pattern). One git command per Bash call, \`git -C ${worktree ?? '<your worktree>'}\`, no \`cd\` chains, \`$(...)\`, pipes into git or GIT_* variables.`

/**
 * Counts refusals per agent loop and pattern, and says what each gets: the
 * full note the first time, nothing the second (the note is just above), and
 * the short reminder from the `REMINDER_FROM`th time on. Keeps at most
 * `MAX_AGENTS` agents, forgetting the least recently refused.
 */
export class Coach {
  private agents = new Map<string, Map<Pattern, number>>()

  /** The note for this refusal, or undefined. `worktree` is the checked path to show, if any. */
  record(refusal: Refusal, agentId: string | undefined, worktree: string | undefined): string | undefined {
    const id = agentId ?? ''
    const counts = this.agents.get(id) ?? new Map<Pattern, number>()
    this.agents.delete(id) // re-inserted last: the map is kept least recently refused first
    this.agents.set(id, counts)
    if (this.agents.size > MAX_AGENTS) this.agents.delete(this.agents.keys().next().value!)
    const count = (counts.get(refusal.pattern) ?? 0) + 1
    counts.set(refusal.pattern, count)
    if (count === 1) return noteFor(refusal, worktree)
    if (count >= REMINDER_FROM) return reminderFor(count, worktree)
    return undefined
  }

  /** How many agents are tracked, for tests. */
  get size(): number {
    return this.agents.size
  }
}

/**
 * Whether a `tool.call` is one the model made: raised by the engine and
 * carrying the model's `tool_use_id`. A plugin's own `$.tool.call` is raised
 * under that plugin's name, and its result goes back to the plugin.
 */
export const isModelCall = (origin: { plugin: string }, toolUseId: string | undefined) =>
  origin.plugin === 'engine' && typeof toolUseId === 'string' && toolUseId !== ''

/** The text the model read for a result: core's `text`, else a string result. */
export function textOf(ran: { text?: string; result?: unknown }): string | undefined {
  if (typeof ran.text === 'string') return ran.text
  return typeof ran.result === 'string' ? ran.result : undefined
}

/** `enabled` from the plugin's options: on unless set to false. */
export const isEnabled = (options: Readonly<Record<string, unknown>>) => options.enabled !== false && options.enabled !== 'false'
