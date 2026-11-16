// The command-line rewrite behind the failing tail, free of the engine: which
// commands may be wrapped, and the wrap that copies their whole output to a
// file while the shell still shows it and keeps its exit code.
//
// The wrap runs the command, unchanged, as a `{ ...; }` group in the session's
// own shell, so `cd`, `export` and the exit code act as they do unwrapped, and
// the command's first line stays line 1 for the shell's error messages:
//
//   if <bash 4.4 or later> && command -v tee; then exec {o}>&1 {e}>&2 > >(exec tee -- '<file>' 2>/dev/null) 2>&1; p=$!; else p=; fi; { <the command>; }; rc=$?; if [ -n "$p" ]; then exec 1>&$o 2>&$e {o}>&- {e}>&-; <give tee up to 3 seconds to finish>; fi; (exit $rc)
//
// all on the command's own lines (a `#` on its last line puts the closing `}` on
// a line of its own instead, as it may be a comment).
//
// (The real names start with __output_shaper_.) stdout and stderr go into one
// pipe in the order they were written, as Claude Code shows them already merged;
// tee writes that to the original stdout and to the file. stdin is left as
// Claude Code set it. Under any other shell, or without tee, the group runs
// with no redirection at all.

/** The variables the wrap sets; a command naming any is never wrapped. */
export const WRAP_PREFIX = '__output_shaper_'
const OUT = `${WRAP_PREFIX}o`
const ERR = `${WRAP_PREFIX}e`
const RC = `${WRAP_PREFIX}rc`
const PID = `${WRAP_PREFIX}p`
const I = `${WRAP_PREFIX}i`

/** Longer commands are left alone. */
export const MAX_WRAP_COMMAND_CHARS = 20_000
/** How long the wrap waits for tee to write the last of the output, in 10 ms steps. */
const TEE_WAIT_STEPS = 300

/** A string as one single-quoted shell word. */
export function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`
}

/** The wrapped command line. `file` must be an absolute path. */
export function wrapCommand(command: string, file: string): string {
  const isBash44 = `builtin test -n "\${BASH_VERSION-}" && { builtin test "\${BASH_VERSINFO[0]}" -gt 4 || { builtin test "\${BASH_VERSINFO[0]}" -eq 4 && builtin test "\${BASH_VERSINFO[1]}" -ge 4; }; }`
  const open = `exec {${OUT}}>&1 {${ERR}}>&2 > >(exec tee -- ${shellQuote(file)} 2>/dev/null) 2>&1; ${PID}=$!`
  const waitTee = `${I}=0; while builtin test "$${I}" -lt ${TEE_WAIT_STEPS} && builtin kill -0 "$${PID}" 2>/dev/null; do builtin command sleep 0.01 2>/dev/null || break; ${I}=$((${I} + 1)); done`
  const close = `exec 1>&"$${OUT}" 2>&"$${ERR}" {${OUT}}>&- {${ERR}}>&-; ${waitTee}`
  const before = `if ${isBash44} && builtin command -v tee >/dev/null 2>&1; then ${open}; else ${PID}=; fi;`
  const after = `${RC}=$?; if builtin test -n "$${PID}"; then ${close}; fi; builtin unset -v ${OUT} ${ERR} ${PID} ${I}; (exit "$${RC}")`
  // On the command's own lines, so the shell numbers lines in its messages as it
  // does unwrapped; a `#` on the last line could be a comment, which would swallow
  // what follows, so then the group closes on a line of its own.
  const body = command.replace(/[\s;]+$/, '')
  if (!body.includes('#', body.lastIndexOf('\n') + 1)) return `${before} { ${body}; }; ${after}`
  return `${before} { ${command}\n}; ${after}`
}

/**
 * The command with everything quoted or commented blanked out, so the checks
 * below read only what the shell reads as words and operators. Undefined when
 * a quote is left open.
 *
 * Quotes inside `$(...)` inside double quotes are not followed exactly; the
 * checks that matter for safety (`&`, `<<`, process substitution) run on the
 * raw text as well, so a misread there can only skip a command.
 */
export function unquoted(command: string): string | undefined {
  let out = ''
  let i = 0
  const n = command.length
  const blank = (s: string) => s.replace(/[^\n]/g, ' ')
  while (i < n) {
    const c = command[i]!
    if (c === '\\') {
      out += '  '.slice(0, Math.min(2, n - i))
      i += 2
      continue
    }
    if (c === "'" || (c === '$' && command[i + 1] === "'")) {
      const ansi = c === '$'
      let j = i + (ansi ? 2 : 1)
      while (j < n && command[j] !== "'") j += ansi && command[j] === '\\' ? 2 : 1
      if (j >= n) return undefined
      out += `${ansi ? ' ' : ''}'${blank(command.slice(i + (ansi ? 2 : 1), j))}'`
      i = j + 1
      continue
    }
    if (c === '"') {
      let j = i + 1
      while (j < n && command[j] !== '"') j += command[j] === '\\' ? 2 : 1
      if (j >= n) return undefined
      out += `"${blank(command.slice(i + 1, j))}"`
      i = j + 1
      continue
    }
    if (c === '#' && (i === 0 || /[\s;&|()]/.test(command[i - 1]!))) {
      let j = i
      while (j < n && command[j] !== '\n') j++
      out += blank(command.slice(i, j))
      i = j
      continue
    }
    out += c
    i++
  }
  return out
}

/** The text with what is inside `( ... )` (subshells, `$( )`, arithmetic) blanked out. */
export function outsideParens(bare: string): string {
  let depth = 0
  let out = ''
  for (const c of bare) {
    if (c === '(') depth++
    if (c === ')') depth = Math.max(0, depth - 1)
    out += depth > 0 && c !== '(' && c !== '\n' ? ' ' : c
  }
  return out
}

/** Builtins that act on the shell the wrap runs in, or leave it before the wrap's end; harmless in a subshell. */
const SHELL_WORDS = ['exit', 'exec', 'return', 'logout', 'trap', 'set', 'shopt', 'wait', 'jobs', 'fg', 'bg', 'disown', 'suspend', 'eval', 'enable', 'ulimit']
/** Builtins that read stdin, wherever they are. */
const STDIN_WORDS = ['read', 'select', 'mapfile', 'readarray', 'coproc']
/** Programs that are interactive, or open an editor or a pager, by their first word. */
const INTERACTIVE = new Set([
  'vi', 'vim', 'nvim', 'nano', 'emacs', 'pico', 'ed', 'less', 'more', 'most', 'man', 'top', 'htop', 'btop', 'watch', 'tmux', 'screen',
  'ssh', 'telnet', 'ftp', 'sftp', 'nc', 'sudo', 'su', 'doas', 'passwd', 'login', 'fzf', 'crontab', 'visudo', 'vipw', 'script',
  'mysql', 'psql', 'sqlite3', 'redis-cli', 'mongo', 'mongosh', 'irb', 'ipython', 'jshell', 'ghci', 'gdb', 'lldb', 'pdb',
])
/** Programs that read stdin as a session when given nothing more than this. */
const REPL_ALONE = new Set(['python', 'python3', 'node', 'ruby', 'bash', 'sh', 'zsh', 'fish', 'deno', 'bun', 'php', 'perl', 'lua', 'R', 'julia'])
const EDITOR_GIT = ['commit', 'rebase', 'merge', 'mergetool', 'difftool', 'tag']
const PREFIX_WORDS = ['time', 'nice', 'nohup', 'env', 'command', 'builtin', 'then', 'do', 'else', 'elif', 'if', 'while', 'until', '!']

const wordRe = (words: readonly string[]) => new RegExp(`(^|[\\s;&|(){}!\`])(${words.join('|')})(?=$|[\\s;&|()<>\`])`)
const SHELL_WORD_RE = wordRe(SHELL_WORDS)
const STDIN_WORD_RE = wordRe(STDIN_WORDS)

/**
 * Why a command is left as it is, or undefined when it may be wrapped. When in
 * doubt it is left alone.
 */
export function skipReason(command: string): string | undefined {
  if (command.trim() === '') return 'empty'
  if (command.length > MAX_WRAP_COMMAND_CHARS) return 'too long'
  if (command.includes('\0')) return 'a NUL character'
  if (command.includes(WRAP_PREFIX)) return 'already wrapped'
  // A line continuation at the very end would join the wrap's closing brace.
  if (/(^|[^\\])(\\\\)*\\\s*$/.test(command)) return 'ends in a backslash'
  // On the raw text, quoted or not: a misread quote must never let these through.
  if (/(^|[^<])<<(?!<)/.test(command)) return 'a heredoc'
  if (/[<>]\(/.test(command)) return 'process substitution'
  // Every `&` that is not `&&`, `|&`, `>&`, `<&` or `&>`, even a quoted one.
  if (command.replace(/&&|\|&|[<>]&|&>/g, ' ').includes('&')) return 'runs something in the background'
  const bare = unquoted(command)
  if (bare === undefined) return 'an open quote'
  if (/\/dev\/(stdin|tty)\b|<&\s*0\b/.test(bare)) return 'reads stdin or the terminal'
  const stdinWord = STDIN_WORD_RE.exec(bare)
  if (stdinWord !== null) return `uses \`${stdinWord[2]}\``
  const shellWord = SHELL_WORD_RE.exec(outsideParens(bare))
  if (shellWord !== null) return `uses \`${shellWord[2]}\``
  // `source` and `.` run a file in this shell, and are allowed: `source .venv/bin/activate && pytest` is common.
  for (const simple of bare.split(/\|\||&&|[;|\n(){}]/)) {
    const words = simple.trim().split(/\s+/).filter(w => w !== '')
    while (words.length > 0 && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!) || PREFIX_WORDS.includes(words[0]!))) words.shift()
    const first = words[0]
    if (first === undefined) continue
    const name = first.replace(/^.*\//, '')
    const rest = words.slice(1)
    if (INTERACTIVE.has(name)) return `\`${name}\` is interactive`
    if (REPL_ALONE.has(name) && (rest.length === 0 || (rest.length === 1 && ['-i', '-', '--interactive'].includes(rest[0]!)))) return `\`${name}\` alone reads stdin`
    const gitEditor = name === 'git' ? rest.find(w => EDITOR_GIT.includes(w)) : undefined
    if (gitEditor !== undefined) return `\`git ${gitEditor}\` can open an editor`
    if (name === 'git' && rest.includes('add') && rest.some(w => /^(-p|-i|--patch|--interactive|-e|--edit)$/.test(w))) return '`git add` is interactive'
    const attaches = rest.some(w => ['run', 'exec', 'attach', 'start'].includes(w))
    if (['docker', 'podman', 'kubectl', 'nerdctl'].includes(name) && attaches && rest.some(w => /^-[a-zA-Z]*[it][a-zA-Z]*$|^--(interactive|tty|stdin|attach)(=|$)/.test(w))) return `\`${name}\` with a terminal or stdin`
    if (name === 'kubectl' && rest.includes('edit')) return '`kubectl edit` opens an editor'
  }
  return undefined
}
