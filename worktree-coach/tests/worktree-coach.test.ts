import type { On, ToolCallResult } from 'claude-code'
import { expect, test, type Engine } from 'claude-code/testing'
import { classify, Coach, isModelCall, noteFor, parseRefusal, reminderFor, textOf } from '../hooks/coach.js'

const WT = '/repo/.claude/worktrees/agent-a1b2'
const SPLIT = `Split it into plain, separate commands and run them from ${WT}.`

// Claude Code 2.1.325's own wording (checkBgWorktreeCommandGuard and the cwd check before a shell exec).
const guard = (reason: string, remedy = SPLIT, noun = 'This agent') =>
  `${noun} is isolated in the worktree ${WT}, but this command ${reason}. Refusing to run it — a worktree-isolated ${noun === 'This agent' ? 'agent' : 'session'}'s git operations must target its own worktree. ${remedy}`
const TOO_COMPLEX = guard('is too complex to verify that it stays inside the worktree')
const GIT_TWICE = guard('names git more than once in a single command, which cannot be verified to stay inside the worktree', `Use one git invocation per command and run it from ${WT}.`)
const CWD_ELSEWHERE = `This agent is isolated in the worktree ${WT}, but this command's working directory resolved to the shared checkout (/repo). Refusing to run it there — a worktree-isolated agent's commands must run inside its worktree. Re-run the command from ${WT}.`

/**
 * Stands in for Claude Code beneath the plugin. A Bash command is refused, as
 * the worktree guard does it (exit 1, the message as the result, isError),
 * when it holds `&&`, `$(`, `;` or `|`, or names git twice; `pwd-outside`
 * gets the cwd refusal; `false` fails plainly; anything else succeeds.
 */
function engine(on: On) {
  on('tool.call', { tool: 'Bash' }, (_, e) => {
    const c = e.command
    const msg = /\$\(|;|&&|\|/.test(c) ? TOO_COMPLEX : (c.match(/\bgit\b/g) ?? []).length > 1 ? GIT_TWICE : c.startsWith('pwd-outside') ? CWD_ELSEWHERE : undefined
    if (msg !== undefined) return { isError: true, result: msg, text: msg } as never
    if (c.startsWith('false')) return { isError: true, result: 'Exit code 1', text: 'Exit code 1\nfatal: not a git repository' } as never
    return { result: { stdout: 'ok', stderr: '', interrupted: false }, text: 'ok' } as never
  })
}

const bash = ($: Engine, command: string, agentId?: string) =>
  $.tool.call({ tool: 'Bash', command, ...(agentId !== undefined && { agentId }) } as never) as Promise<ToolCallResult>

const notes = (r: ToolCallResult) => (r.context ?? []).filter(c => c.startsWith('worktree-coach:'))

test("a worktree refusal gets one note: Claude Code's reason and remedy, the worktree, the fixed tips", async ($, on) => {
  engine(on)
  const r = await bash($, `cd ${WT}/src && git status`)
  expect(r.isError).toBe(true) // the refusal still reaches Claude as Claude Code gave it
  expect(r.text).toBe(TOO_COMPLEX)
  const [note, ...more] = notes(r)
  expect(more).toEqual([])
  expect(note).toContain('Claude Code refused this command because "this command is too complex to verify that it stays inside the worktree".')
  expect(note).toContain(`Its remedy: "${SPLIT}"`)
  expect(note).toContain(`Your worktree: ${WT}`)
  expect(note).toContain('- Run each git command as its own Bash call.')
  expect(note).toContain(`- Use \`git -C ${WT}\` with exactly this path.`)
  expect(note).toContain('- Use no `cd` chains, `$(...)`, pipes into git, or GIT_* variables.')
  expect(note).toContain('- If you need data from one command, run it first and use its output in the next call.')
})

test('other errors and successes get no note', async ($, on) => {
  engine(on)
  expect(notes(await bash($, 'false'))).toEqual([])
  expect(notes(await bash($, 'git status'))).toEqual([])
})

test("a git error about worktrees that is not the guard's refusal gets no note", async ($, on) => {
  on('tool.call', { tool: 'Bash' }, () => ({ isError: true, result: 'x', text: "Exit code 128\nfatal: 'feature' is already checked out at '/repo/.claude/worktrees/x'" }) as never)
  expect(notes(await bash($, 'cd src && git checkout feature'))).toEqual([])
})

test('the note is given once per refusal pattern, and a different pattern gets its own', async ($, on) => {
  engine(on)
  expect(notes(await bash($, 'cd src && git add -A')).length).toBe(1)
  expect(notes(await bash($, 'git add -A; git commit -m x'))).toEqual([]) // same pattern (too complex), second time
  const twice = notes(await bash($, 'git add -A git'))
  expect(twice.length).toBe(1) // names git twice: another pattern
  expect(twice[0]).toContain('names git more than once')
  expect(twice[0]).toContain(`Its remedy: "Use one git invocation per command and run it from ${WT}."`)
})

test('from the third refusal of a pattern on, a shorter reminder', async ($, on) => {
  engine(on)
  const first = notes(await bash($, 'cd src && git status'))[0]!
  expect(notes(await bash($, 'cd src && git diff'))).toEqual([])
  const third = notes(await bash($, `cd ${WT} && git log -1`))
  expect(third.length).toBe(1)
  expect(third[0]).toContain('refused again (3× this pattern)')
  expect(third[0]).toContain(`\`git -C ${WT}\``)
  expect(third[0]!.length).toBeLessThan(first.length / 2)
  expect(notes(await bash($, 'cd src && git show'))[0]).toContain('4× this pattern')
})

test('each subagent is counted on its own', async ($, on) => {
  engine(on)
  expect(notes(await bash($, 'cd src && git status', 'agent-1')).length).toBe(1)
  expect(notes(await bash($, 'cd src && git status', 'agent-1'))).toEqual([])
  expect(notes(await bash($, 'cd src && git status', 'agent-2'))[0]).toContain('Your worktree')
  expect(notes(await bash($, 'cd src && git status'))[0]).toContain('Your worktree') // the main loop
})

test("a working directory outside the worktree gets Claude Code's own remedy", async ($, on) => {
  engine(on)
  const [note] = notes(await bash($, 'pwd-outside'))
  expect(note).toContain(`because "this command's working directory resolved to the shared checkout (/repo)"`)
  expect(note).toContain(`Its remedy: "Re-run the command from ${WT}."`)
})

test('a context already on the result is kept, and the note comes after it', async ($, on) => {
  on('tool.call', { tool: 'Bash' }, () => ({ isError: true, result: TOO_COMPLEX, text: TOO_COMPLEX, context: ['other note'] }) as never)
  const r = await bash($, 'cd src && git status')
  expect(r.context![0]).toBe('other note')
  expect(r.context![1]).toContain('worktree-coach:')
})

test('only calls the model made get a note: other plugins’ own calls are ignored', async () => {
  // The engine raises the model's calls, with the model's tool_use_id; a plugin's own `$.tool.call` is raised under its name.
  expect(isModelCall({ plugin: 'engine' }, 'toolu_1')).toBe(true)
  expect(isModelCall({ plugin: 'some-plugin' }, 'toolu_2')).toBe(false)
  expect(isModelCall({ plugin: 'engine' }, undefined)).toBe(false)
  expect(isModelCall({ plugin: 'engine' }, '')).toBe(false)
})

test('disabled: no note, and the refusal passes through unchanged', { options: { enabled: false } }, async ($, on) => {
  engine(on)
  for (let i = 0; i < 4; i++) {
    const r = await bash($, 'cd src && git status')
    expect(r.isError).toBe(true)
    expect(r.text).toBe(TOO_COMPLEX)
    expect(notes(r)).toEqual([])
  }
})

test("parsing Claude Code's refusal texts", async () => {
  expect(parseRefusal(TOO_COMPLEX)).toEqual({ pattern: 'too-complex', worktree: WT, reason: 'this command is too complex to verify that it stays inside the worktree', remedy: SPLIT })
  expect(parseRefusal(`Exit code 1\n${guard('names git in a form too complex to verify that it stays inside the worktree', SPLIT, 'This session')}`)?.pattern).toBe('too-complex')
  expect(parseRefusal(GIT_TWICE)?.pattern).toBe('git-twice')
  expect(parseRefusal(CWD_ELSEWHERE)).toEqual({ pattern: 'cwd-outside', worktree: WT, reason: "this command's working directory resolved to the shared checkout (/repo)", remedy: `Re-run the command from ${WT}.` })
  expect(parseRefusal('Exit code 1')).toBe(undefined)
  expect(parseRefusal(undefined)).toBe(undefined)
  expect(classify("runs xargs before a git command, whose string payload can't be verified to leave the worktree alone")).toBe('shell-wrapper')
  expect(classify('hands text naming git to a shell')).toBe('shell-wrapper')
  expect(classify('changes directory to the shared checkout (/repo) before running git')).toBe('chdir')
  expect(classify("points git at a directory computed at runtime (-C $D), which can't be verified before it runs")).toBe('chdir')
  expect(classify('sets GIT_DIR to the shared checkout (/repo/.git)')).toBe('git-env')
  expect(classify("passes core.worktree=/x to git, injecting configuration whose effect on where git writes can't be verified")).toBe('git-env')
  expect(classify("has a word at or before git's subcommand that the shell fills in only when the command runs ($X), so the options git receives can't be verified")).toBe('runtime-value')
  expect(classify('does something new')).toBe('other')
  expect(textOf({ result: { stderr: 'boom' } })).toBe('boom')
})

test('the note never contains text from the refused command, apart from the worktree path', async () => {
  // Commands built from tokens that appear nowhere in Claude Code's wording or the fixed tips.
  let seed = 7
  const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n)
  const token = () => `zq${rand(1e6).toString(36)}x`
  const shapes = [
    (a: string, b: string, c: string) => `cd ${a} && git ${b} $(${c})`,
    (a: string, b: string, c: string) => `cd /${a}/${b} && git -C /${c} ${a}`,
    (a: string, b: string, c: string) => `export GIT_DIR=/${a}; /usr/bin/git ${b} | ${c}`,
    (a: string, b: string, c: string) => `cd -P ../${a} && git --git-dir=${b} ${c}; git ${a}`,
    (a: string, b: string, c: string) => `for ${a} in ${b}; do git ${c} "$${a}"; done`,
    (a: string, b: string, c: string) => `${a}=${b} git ${c} \`${a}\``,
  ]
  const refusals = [TOO_COMPLEX, GIT_TWICE, CWD_ELSEWHERE, guard('changes directory to the shared checkout (/repo) before running git', `Run the equivalent from ${WT} without the redirect.`)]
  for (let i = 0; i < 300; i++) {
    const [a, b, c] = [token(), token(), token()]
    const cmd = shapes[rand(shapes.length)]!(a, b, c)
    const refusal = parseRefusal(refusals[rand(refusals.length)])!
    const coach = new Coach()
    const texts = [noteFor(refusal), reminderFor(refusal, 3), coach.record(refusal, undefined)!]
    for (const text of texts) {
      for (const t of [a, b, c, cmd]) expect([cmd, text.includes(t)]).toEqual([cmd, false])
      // Every path the note names is the worktree itself.
      for (const m of text.matchAll(/git -C (\S+?)`/g)) expect(m[1]).toBe(WT)
    }
  }
})

test('through the hook too: no note or reminder echoes the refused command', async ($, on) => {
  engine(on)
  for (let i = 0; i < 40; i++) {
    const tok = `zq${i}tok`
    const cmd = [`cd /${tok} && git log $(${tok})`, `git ${tok} | git ${tok}x`, `export GIT_DIR=/${tok}; git ${tok}`, 'pwd-outside'][i % 4]!
    for (const text of notes(await bash($, cmd, `agent-${i % 3}`))) {
      expect([cmd, text.includes(tok)]).toEqual([cmd, false])
      expect(text.includes(cmd)).toBe(false)
    }
  }
})
