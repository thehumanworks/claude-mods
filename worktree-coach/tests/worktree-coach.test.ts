import type { On, ToolCallResult } from 'claude-code'
import { expect, test, type Engine } from 'claude-code/testing'
import { classify, isModelCall, parseRefusal, rewrite, segments, textOf, triggers } from '../hooks/coach.js'

const WT = '/repo/.claude/worktrees/agent-a1b2'

// Claude Code 2.1.325's own wording (checkBgWorktreeCommandGuard and the cwd check before a shell exec).
const guard = (reason: string, remedy = `Split it into plain, separate commands and run them from ${WT}.`, noun = 'This agent') =>
  `${noun} is isolated in the worktree ${WT}, but this command ${reason}. Refusing to run it — a worktree-isolated ${noun === 'This agent' ? 'agent' : 'session'}'s git operations must target its own worktree. ${remedy}`
const TOO_COMPLEX = guard('is too complex to verify that it stays inside the worktree')
const GIT_TWICE = guard('names git more than once in a single command, which cannot be verified to stay inside the worktree', `Use one git invocation per command and run it from ${WT}.`)
const CWD_ELSEWHERE = `This agent is isolated in the worktree ${WT}, but this command's working directory resolved to the shared checkout (/repo). Refusing to run it there — a worktree-isolated agent's commands must run inside its worktree. Re-run the command from ${WT}.`

/**
 * Stands in for Claude Code beneath the plugin. A Bash command is refused, as
 * the worktree guard does it (exit 1, the message on stderr, isError), when it
 * holds `&&`, `$(` or `;`, or names git twice; `false` fails plainly; anything
 * else succeeds.
 */
function engine(on: On) {
  on('tool.call', { tool: 'Bash' }, (_, e) => {
    const c = e.command
    const msg = /\$\(|;|&&|\|/.test(c) ? TOO_COMPLEX : (c.match(/\bgit\b/g) ?? []).length > 1 ? GIT_TWICE : c.startsWith('pwd-outside') ? CWD_ELSEWHERE : undefined
    if (msg !== undefined) return { isError: true, result: msg, text: `Exit code 1\n${msg}` } as never
    if (c.startsWith('false')) return { isError: true, result: 'Exit code 1', text: 'Exit code 1\nfatal: not a git repository' } as never
    return { result: { stdout: 'ok', stderr: '', interrupted: false }, text: 'ok' } as never
  })
}

const bash = ($: Engine, command: string, agentId?: string) =>
  $.tool.call({ tool: 'Bash', command, ...(agentId !== undefined && { agentId }) } as never) as Promise<ToolCallResult>

const notes = (r: ToolCallResult) => (r.context ?? []).filter(c => c.startsWith('worktree-coach:'))

test('a worktree refusal gets one note with the trigger and the concrete rewrite', async ($, on) => {
  engine(on)
  const r = await bash($, `cd ${WT}/src && git status`)
  expect(r.isError).toBe(true) // the refusal still reaches Claude as Claude Code gave it
  expect(r.text).toContain('too complex to verify')
  const [note, ...more] = notes(r)
  expect(more).toEqual([])
  expect(note).toContain(`Likely trigger: the \`cd ${WT}/src\` chained in front of git`)
  expect(note).toContain(`1. git -C ${WT}/src status`)
  expect(note).toContain(`\`git -C ${WT} …\` instead of \`cd … &&\``)
  expect(note).toContain('no `$(…)`')
})

test('command substitutions and pipes are named, and no mechanical rewrite is offered', async ($, on) => {
  engine(on)
  const [note] = notes(await bash($, 'git log $(git merge-base HEAD main)..HEAD | git apply'))
  expect(note).toContain('the command substitution `$(git merge-base HEAD main)`')
  expect(note).toContain('a pipe into git')
  expect(note).toContain('split it by hand')
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
  expect(twice[0]).toContain('verifies one git invocation per command')
})

test('from the third refusal of a pattern on, a shorter reminder', async ($, on) => {
  engine(on)
  const first = notes(await bash($, 'cd src && git status'))[0]!
  expect(notes(await bash($, 'cd src && git diff'))).toEqual([])
  const third = notes(await bash($, `cd ${WT} && git log -1`))
  expect(third.length).toBe(1)
  expect(third[0]).toContain('refused again (3× this pattern)')
  expect(third[0]).toContain(`\`git -C ${WT} log -1\``)
  expect(third[0]!.length).toBeLessThan(first.length / 2)
  expect(notes(await bash($, 'cd src && git show'))[0]).toContain('4× this pattern')
})

test('each subagent is counted on its own', async ($, on) => {
  engine(on)
  expect(notes(await bash($, 'cd src && git status', 'agent-1')).length).toBe(1)
  expect(notes(await bash($, 'cd src && git status', 'agent-1'))).toEqual([])
  expect(notes(await bash($, 'cd src && git status', 'agent-2'))[0]).toContain('Likely trigger')
  expect(notes(await bash($, 'cd src && git status'))[0]).toContain('Likely trigger') // the main loop
})

test("a working directory outside the worktree gets the cwd advice", async ($, on) => {
  engine(on)
  const [note] = notes(await bash($, 'pwd-outside'))
  expect(note).toContain("working directory is outside this worktree")
  expect(note).toContain(`run \`cd ${WT}\` alone first`)
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
    expect(r.text).toContain('too complex to verify')
    expect(notes(r)).toEqual([])
  }
})

test("parsing Claude Code's refusal texts", async () => {
  expect(parseRefusal(TOO_COMPLEX)).toEqual({ pattern: 'too-complex', worktree: WT, reason: 'is too complex to verify that it stays inside the worktree' })
  expect(parseRefusal(`Exit code 1\n${guard('names git in a form too complex to verify that it stays inside the worktree', 'x', 'This session')}`)?.pattern).toBe('too-complex')
  expect(parseRefusal(GIT_TWICE)?.pattern).toBe('git-twice')
  expect(parseRefusal(CWD_ELSEWHERE)).toEqual({ pattern: 'cwd-outside', worktree: WT, reason: 'working directory resolved to the shared checkout (/repo)' })
  expect(parseRefusal('Exit code 1')).toBe(undefined)
  expect(parseRefusal(undefined)).toBe(undefined)
  expect(classify('runs xargs before a git command, whose string payload can\'t be verified to leave the worktree alone')).toBe('shell-wrapper')
  expect(classify('hands text naming git to a shell')).toBe('shell-wrapper')
  expect(classify('changes directory to the shared checkout (/repo) before running git')).toBe('chdir')
  expect(classify('points git at a directory computed at runtime (-C $D), which can\'t be verified before it runs')).toBe('chdir')
  expect(classify('sets GIT_DIR to the shared checkout (/repo/.git)')).toBe('git-env')
  expect(classify('passes core.worktree=/x to git, injecting configuration whose effect on where git writes can\'t be verified')).toBe('git-env')
  expect(classify("has a word at or before git's subcommand that the shell fills in only when the command runs ($X), so the options git receives can't be verified")).toBe('runtime-value')
  expect(classify('does something new')).toBe('other')
})

test('splitting and rewriting commands', async () => {
  expect(segments(`cd a && git commit -m "x && y; z" ; git log`).map(s => s.text)).toEqual(['cd a', 'git commit -m "x && y; z"', 'git log'])
  expect(rewrite('cd src && git add . && git commit -m "fix: a; b"', WT)).toEqual([`git -C ${WT}/src add .`, `git -C ${WT}/src commit -m "fix: a; b"`])
  expect(rewrite('cd /other/wt && npm test && git status', WT)).toEqual(['cd /other/wt && npm test', 'git -C /other/wt status'])
  expect(rewrite('git -C /x status; git diff', WT)).toEqual(['git -C /x status', `git -C ${WT} diff`])
  expect(rewrite('git status', WT)).toEqual([`git -C ${WT} status`])
  expect(rewrite('npm test', WT)).toBe(undefined)
  expect(rewrite('cd src && git log -1 $(git rev-parse --abbrev-ref HEAD)', WT)).toEqual([`git -C ${WT}/src rev-parse --abbrev-ref HEAD`, `git -C ${WT}/src log -1 <output of step 1>`])
  expect(rewrite('git tag v1 $(cat sha.txt)', WT)).toEqual(['cat sha.txt', `git -C ${WT} tag v1 <output of step 1>`])
  expect(rewrite('git diff $(git merge-base HEAD $(cat b))', WT)).toBe(undefined)
  expect(rewrite('cd ~/x && git status', WT)).toBe(undefined)
  expect(triggers('for f in a b; do git add $f; done').join(' ')).toContain('loop')
  expect(triggers('GIT_DIR=/repo/.git git status').join(' ')).toContain('`GIT_DIR=`')
  expect(triggers('bash -c "git status"').join(' ')).toContain('git run through another program')
  expect(textOf({ result: { stderr: 'boom' } })).toBe('boom')
})
