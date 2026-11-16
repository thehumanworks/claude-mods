// Reading Claude Code's worktree refusals and writing the rewrite, free of the engine, so the tests run the same code.

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

export type Refusal = { pattern: Pattern; worktree: string; reason: string }

/** One refused call as the coach sees it. */
export type Seen = { pattern: Pattern; count: number }

/** The full note is given at the first refusal of a pattern; the short reminder from this refusal of it on. */
export const REMINDER_FROM = 3
/** Commands are quoted up to this many characters. */
export const QUOTE_CHARS = 120

const squash = (text: string) => text.replace(/\s+/g, ' ').trim()
export const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

// `${noun} is isolated in the worktree ${path}, but this command ${reason}. Refusing to run it — ${possessive} git operations must target its own worktree. ${remedy}`
const GUARD = /(?:This agent|This session) is isolated in the worktree (.+?), but this command (.+?)\. Refusing to run it — a worktree-isolated (?:agent|session)'s git operations must target its own worktree\./s
// `${noun} is isolated in the worktree ${path}, but this command's working directory (…) is in a different worktree (…)` / `… resolved to the shared checkout (…)`. Refusing to run it there — … commands must run inside its (own) worktree.
const CWD = /(?:This agent|This session) is isolated in the worktree (.+?), but this command's working directory (.+?)\. Refusing to run it there — a worktree-isolated (?:agent|session)'s commands must run inside its (?:own )?worktree\./s

/** What Claude Code's refusal says, or undefined when the text is not a worktree refusal. */
export function parseRefusal(text: string | undefined): Refusal | undefined {
  if (text === undefined || !text.includes('is isolated in the worktree')) return undefined
  const cwd = CWD.exec(text)
  if (cwd !== null) return { pattern: 'cwd-outside', worktree: cwd[1]!, reason: `working directory ${cwd[2]!}` }
  const m = GUARD.exec(text)
  if (m === null) return undefined
  return { pattern: classify(m[2]!), worktree: m[1]!, reason: m[2]! }
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

/** One piece of a command line between `&&`, `||`, `;` and newlines, and the operator that ended it. */
type Segment = { text: string; op: '&&' | '||' | ';' | '' }

/**
 * Splits a command line on `&&`, `||`, `;` and newlines outside quotes,
 * `$(…)`, backticks and brackets. Pipes stay inside a segment.
 */
export function segments(command: string): Segment[] {
  const out: Segment[] = []
  let depth = 0
  let quote: '"' | "'" | '`' | undefined
  let start = 0
  const push = (end: number, op: Segment['op'], skip: number) => {
    const text = command.slice(start, end).trim()
    if (text !== '') out.push({ text, op })
    else if (out.length > 0 && op !== '') out[out.length - 1]!.op = op
    start = end + skip
  }
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!
    if (c === '\\' && quote !== "'") {
      i++
      continue
    }
    if (quote !== undefined) {
      if (c === quote) quote = undefined
      continue
    }
    if (c === '"' || c === "'" || c === '`') quote = c
    else if (c === '(' || c === '{') depth++
    else if ((c === ')' || c === '}') && depth > 0) depth--
    else if (depth === 0) {
      const two = command.slice(i, i + 2)
      if (two === '&&' || two === '||') {
        push(i, two, 2)
        i++
      } else if (c === ';' || c === '\n') push(i, c === ';' ? ';' : '', 1)
    }
  }
  push(command.length, '', 0)
  if (out.length > 0) out[out.length - 1]!.op = ''
  return out
}

const GIT = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*git(?:\s|$)/
const CD = /^(?:cd|pushd)(?:\s+(?:"([^"]*)"|'([^']*)'|(\S+)))?\s*$/
const WRAPPER = /(?:^|[\s|;&(])(?:sh|bash|zsh|eval|xargs|exec|env|nohup|timeout|watch|find\s.*-exec)(?:\s|$)/
const isGit = (s: string) => GIT.test(s)
/** Stands for a substitution's output while the rest of the command is rewritten. */
const SLOT = '\u0000out\u0000'
const quoteArg = (s: string) => (/^[\w@%+=:,./~-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`)

function join(base: string, dir: string): string {
  if (dir.startsWith('/')) return dir
  const parts = base.replace(/\/+$/, '').split('/')
  for (const p of dir.split('/')) {
    if (p === '' || p === '.') continue
    if (p === '..') parts.pop()
    else parts.push(p)
  }
  return parts.join('/') || '/'
}

/** What in the command most likely tripped the check, from its structure, worst first. */
export function triggers(command: string): string[] {
  const segs = segments(command)
  const found: string[] = []
  const gits = segs.filter(s => isGit(s.text))
  const sub = /\$\([^)]*\)?|`[^`]*`?/.exec(command)
  if (sub !== null) found.push(`the command substitution \`${clip(sub[0], 40)}\` (its output is only known when it runs)`)
  if (/\|\s*(?:xargs\s+(?:-\S+\s+)*)?git\b/.test(command)) found.push('a pipe into git')
  if (/<<-?\s*['"]?\w/.test(command)) found.push('a heredoc')
  if (/^\s*(?:for|while|until|if|case)\b|^\s*[({]/.test(command)) found.push('a shell loop, conditional or group around git')
  const wrap = segs.find(s => !isGit(s.text) && /\bgit\b/.test(s.text) && WRAPPER.test(s.text))
  if (wrap !== undefined) found.push(`git run through another program (\`${clip(wrap.text, 50)}\`)`)
  const env = /(?:^|\s)(GIT_[A-Z_]+)=/.exec(command)
  if (env !== null) found.push(`the \`${env[1]}=\` assignment`)
  if (gits.some(s => /\$\{?[A-Za-z_]/.test(s.text))) found.push("a shell variable in git's arguments")
  if (gits.some(s => /(?:^|\s)~(?:\/|\s|$)/.test(s.text))) found.push("a `~` path in git's arguments")
  if (gits.length > 1) found.push(`${gits.length} git commands in one call`)
  // A plain `cd X && git …` can pass on its own; with anything above it, the `cd` makes the rest harder to verify.
  const cdBeforeGit = segs.findIndex((s, i) => CD.test(s.text) && segs.slice(i + 1).some(t => isGit(t.text)))
  if (cdBeforeGit !== -1) found.push(`the \`${clip(segs[cdBeforeGit]!.text, 60)}\` chained in front of git (use \`git -C\` instead)`)
  const ops = new Set(segs.slice(0, -1).map(s => s.op).filter(op => op !== ''))
  if (segs.length > 1 && gits.length > 0) {
    const named = [...ops].map(op => `\`${op}\``).join(' and ')
    found.push(named === '' ? 'several commands on separate lines around git' : `the ${named} chain around git`)
  }
  return found
}

/**
 * The command split into separate calls, `cd X &&` folded into `git -C X`.
 * Undefined when the command cannot be rewritten mechanically (substitutions,
 * pipes into git, heredocs, loops, wrappers) or would come out the same.
 */
export function rewrite(command: string, worktree: string): string[] | undefined {
  // One plain `$(…)`: run its command first, then the rest with that output pasted in.
  const sub = /\$\(([^()`$]*)\)/.exec(command)
  if (sub !== null && command.split('$(').length === 2) {
    const outer = rewrite(command.replace(sub[0], SLOT), worktree)
    const at = outer?.findIndex(c => c.includes(SLOT)) ?? -1
    if (outer === undefined || at === -1) return undefined
    const dir = /^(?:git -C|cd) ('[^']*'|\S+)/.exec(outer[at]!)?.[1]
    const inner = sub[1]!.trim()
    const first = rewrite(dir === undefined ? inner : `cd ${dir} && ${inner}`, worktree) ?? [inner]
    const step = at + first.length // 1-based number of the inner's last step
    return [...outer.slice(0, at), ...first, ...outer.slice(at).map(c => c.replace(SLOT, `<output of step ${step}>`))]
  }
  if (/\$\(|`|<<|\|\s*(?:xargs\s+(?:-\S+\s+)*)?git\b/.test(command)) return undefined
  if (/^\s*(?:for|while|until|if|case)\b|^\s*[({]/.test(command)) return undefined
  const segs = segments(command)
  const out: string[] = []
  let dir: string | undefined
  for (const s of segs) {
    const cd = CD.exec(s.text)
    if (cd !== null) {
      const to = cd[1] ?? cd[2] ?? cd[3]
      if (to === undefined || to === '~' || to.startsWith('~/') || to === '-' || to.includes('$')) return undefined
      dir = join(dir ?? worktree, to)
      continue
    }
    if (isGit(s.text)) {
      if (/^[A-Za-z_]/.test(s.text) && !s.text.startsWith('git')) return undefined // VAR=… git: no mechanical rewrite
      const rest = s.text.slice(3).trimStart()
      out.push(/^-C\s/.test(rest) ? s.text : `git -C ${quoteArg(dir ?? worktree)}${rest === '' ? '' : ` ${rest}`}`)
    } else {
      if (/\bgit\b/.test(s.text) && WRAPPER.test(s.text)) return undefined
      // A command that does not name git is not what the check refuses: it may keep its `cd`.
      out.push(dir === undefined ? s.text : `cd ${quoteArg(dir)} && ${s.text}`)
    }
  }
  if (out.length === 0 || (out.length === 1 && squash(out[0]!) === squash(command))) return undefined
  return out
}

const HINT: Record<Pattern, string> = {
  'too-complex': 'Claude Code could not parse this command well enough to prove it stays in the worktree.',
  'git-twice': 'Claude Code verifies one git invocation per command.',
  'shell-wrapper': 'Claude Code cannot see what git does when another program (sh -c, xargs, eval, env) starts it.',
  chdir: 'Claude Code cannot verify where git runs when the directory is changed in the command or computed at runtime.',
  'runtime-value': 'Claude Code cannot verify a value the shell fills in only when the command runs.',
  'git-env': 'Claude Code cannot verify git configuration or GIT_* variables set in the command.',
  'cwd-outside': "The Bash tool's working directory is outside this worktree.",
  other: 'Claude Code could not verify that this command stays in the worktree.',
}

const RULES = (wt: string) =>
  `For git in this worktree: one plain git command per Bash call; \`git -C ${quoteArg(wt)} …\` instead of \`cd … &&\`; no \`$(…)\` or backticks (run the inner command first and paste its output literally); no pipes into git; no \`;\`, \`&&\` or \`||\` chains around git; literal paths, no variables or \`~\`. Do not resend the same command.`

const steps = (cmds: string[]) => cmds.map((c, i) => `  ${i + 1}. ${clip(c, QUOTE_CHARS * 2)}`).join('\n')

/** The full note: why, what to change and, when it can be written out, the rewrite. */
export function noteFor(refusal: Refusal, command: string): string {
  const wt = refusal.worktree
  const lines = [`worktree-coach: ${HINT[refusal.pattern]}`]
  const found = triggers(command)
  if (found.length > 0) lines.push(`Likely trigger: ${found.slice(0, 3).join('; ')}.`)
  const cmds = refusal.pattern === 'cwd-outside' ? undefined : rewrite(command, wt)
  if (cmds !== undefined) lines.push(`Rewrite: run these as separate Bash calls, in order, checking each result${cmds.some(c => c.includes('<output of step')) ? ' and pasting each <output of step N> in literally' : ''}:\n${steps(cmds)}`)
  else if (refusal.pattern === 'cwd-outside')
    lines.push(`Rewrite: name the worktree explicitly, e.g. \`git -C ${quoteArg(wt)} …\` and absolute paths under ${wt}; if plain commands keep being refused, run \`cd ${quoteArg(wt)}\` alone first.`)
  else lines.push('Rewrite: split it by hand into plain, separate commands, following the rules below.')
  lines.push(RULES(wt))
  return lines.join('\n')
}

/** The short reminder for a pattern Claude has already had the note for. */
export function reminderFor(refusal: Refusal, command: string, count: number): string {
  const cmds = refusal.pattern === 'cwd-outside' ? undefined : rewrite(command, refusal.worktree)
  const how = cmds !== undefined ? ` Run instead, one per call: ${cmds.map(c => `\`${clip(c, QUOTE_CHARS)}\``).join(', then ')}.` : ` One plain git command per call, \`git -C ${quoteArg(refusal.worktree)}\`, no \`cd &&\`, \`$(…)\`, pipes or chains.`
  return `worktree-coach: refused again (${count}× this pattern).${how}`
}

/**
 * Counts refusals per agent loop and pattern, and says what each gets: the
 * full note the first time, nothing the second (the note is just above), and
 * the short reminder from the `REMINDER_FROM`th time on.
 */
export class Coach {
  private counts = new Map<string, number>()

  /** The note for this refusal, or undefined. */
  record(refusal: Refusal, command: string, agentId: string | undefined): string | undefined {
    const key = `${agentId ?? ''}\0${refusal.pattern}`
    const count = (this.counts.get(key) ?? 0) + 1
    this.counts.set(key, count)
    if (count === 1) return noteFor(refusal, command)
    if (count >= REMINDER_FROM) return reminderFor(refusal, command, count)
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
