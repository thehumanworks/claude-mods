// Reading Claude Code's worktree refusals and writing the note, free of the engine, so the tests run the same code.

/**
 * The kinds of refusal Claude Code 2.1.325 gives a worktree-isolated agent's
 * (or session's) Bash command. Each is counted on its own, per agent.
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
  /** "this command's working directory … is in a different worktree" / "resolved to the shared checkout". */
  | 'cwd-outside'
  /** Any other worktree refusal. */
  | 'other'

/** A refusal as Claude Code worded it: its reason ("this command …") and its remedy, both quoted to Claude as they are. */
export type Refusal = { pattern: Pattern; worktree: string; reason: string; remedy: string }

/** The full note is given at the first refusal of a pattern; the short reminder from this refusal of it on. */
export const REMINDER_FROM = 3

// `${noun} is isolated in the worktree ${path}, but this command ${reason}. Refusing to run it — ${possessive} git operations must target its own worktree. ${remedy}`
const GUARD = /(?:This agent|This session) is isolated in the worktree (.+?), but (this command .+?)\. Refusing to run it — a worktree-isolated (?:agent|session)'s git operations must target its own worktree\.(?: ([^\n]*))?/s
// `${noun} is isolated in the worktree ${path}, but this command's working directory (…) is in a different worktree (…)` / `… resolved to the shared checkout (…)`. Refusing to run it there — … commands must run inside its (own) worktree.
const CWD = /(?:This agent|This session) is isolated in the worktree (.+?), but (this command's working directory .+?)\. Refusing to run it there — a worktree-isolated (?:agent|session)'s commands must run inside its (?:own )?worktree\.(?: ([^\n]*))?/s

/** Claude Code's remedy sentence(s), or its usual one when the text is cut. */
const remedyOf = (text: string | undefined, worktree: string) => text?.trim() || `Re-run the command from ${worktree}.`

/** What Claude Code's refusal says, or undefined when the text is not a worktree refusal. */
export function parseRefusal(text: string | undefined): Refusal | undefined {
  if (text === undefined || !text.includes('is isolated in the worktree')) return undefined
  const cwd = CWD.exec(text)
  if (cwd !== null) return { pattern: 'cwd-outside', worktree: cwd[1]!, reason: cwd[2]!, remedy: remedyOf(cwd[3], cwd[1]!) }
  const m = GUARD.exec(text)
  if (m === null) return undefined
  return { pattern: classify(m[2]!.replace(/^this command /, '')), worktree: m[1]!, reason: m[2]!, remedy: remedyOf(m[3], m[1]!) }
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

/** The fixed tips: the same for every command, so nothing of the refused command is ever suggested back. */
const tips = (wt: string) =>
  [
    '- Run each git command as its own Bash call.',
    `- Use \`git -C ${wt}\` with exactly this path.`,
    '- Use no `cd` chains, `$(...)`, pipes into git, or GIT_* variables.',
    '- If you need data from one command, run it first and use its output in the next call.',
  ].join('\n')

/**
 * The full note: Claude Code's reason and remedy as it gave them, the
 * worktree, and the fixed tips. It never quotes the refused command.
 */
export function noteFor(refusal: Refusal): string {
  return [
    `worktree-coach: Claude Code refused this command because "${refusal.reason}". Its remedy: "${refusal.remedy}"`,
    `Your worktree: ${refusal.worktree}`,
    tips(refusal.worktree),
    'Do not resend the same command.',
  ].join('\n')
}

/** The short reminder for a pattern Claude has already had the note for. */
export const reminderFor = (refusal: Refusal, count: number) =>
  `worktree-coach: refused again (${count}× this pattern). One git command per Bash call, \`git -C ${refusal.worktree}\`, no \`cd\` chains, \`$(...)\`, pipes into git or GIT_* variables.`

/**
 * Counts refusals per agent loop and pattern, and says what each gets: the
 * full note the first time, nothing the second (the note is just above), and
 * the short reminder from the `REMINDER_FROM`th time on.
 */
export class Coach {
  private counts = new Map<string, number>()

  /** The note for this refusal, or undefined. */
  record(refusal: Refusal, agentId: string | undefined): string | undefined {
    const key = `${agentId ?? ''}\0${refusal.pattern}`
    const count = (this.counts.get(key) ?? 0) + 1
    this.counts.set(key, count)
    if (count === 1) return noteFor(refusal)
    if (count >= REMINDER_FROM) return reminderFor(refusal, count)
    return undefined
  }
}

/**
 * Whether a `tool.call` is one the model made: raised by the engine and
 * carrying the model's `tool_use_id`. A plugin's own `$.tool.call` is raised
 * under that plugin's name, and its result goes back to the plugin.
 */
export const isModelCall = (origin: { plugin: string }, toolUseId: string | undefined) =>
  origin.plugin === 'engine' && typeof toolUseId === 'string' && toolUseId !== ''

/** The text the model read for a result: core's `text`, else a string result or its `stderr`. */
export function textOf(ran: { text?: string; result?: unknown }): string | undefined {
  if (typeof ran.text === 'string') return ran.text
  if (typeof ran.result === 'string') return ran.result
  const r = ran.result as { stderr?: unknown } | null | undefined
  return r !== null && typeof r === 'object' && typeof r.stderr === 'string' ? r.stderr : undefined
}

/** `enabled` from the plugin's options: on unless set to false. */
export const isEnabled = (options: Readonly<Record<string, unknown>>) => options.enabled !== false && options.enabled !== 'false'
