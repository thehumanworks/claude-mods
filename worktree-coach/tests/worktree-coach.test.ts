import type { On, ToolCallResult } from 'claude-code'
import { expect, test, type Engine } from 'claude-code/testing'
import { classify, isInside, isModelCall, noteFor, parseRefusal, reminderFor, resolvePath, rewrite, segments, textOf, triggers, type Refusal } from '../hooks/coach.js'

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

test('a working directory outside the worktree gets only the remedy, no rewrite', async ($, on) => {
  engine(on)
  const [note] = notes(await bash($, 'pwd-outside'))
  expect(note).toContain("working directory is outside this worktree")
  expect(note).toContain(`Run git in your own worktree, ${WT}, and nowhere else`)
  expect(note).not.toContain('Rewrite')
  expect(note).not.toContain('git -C')
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
  expect(rewrite(`cd ${WT}/pkg && npm test && git status`, WT)).toEqual([`cd ${WT}/pkg && npm test`, `git -C ${WT}/pkg status`])
  expect(rewrite('git -C sub status; git diff', WT)).toEqual([`git -C ${WT}/sub status`, `git -C ${WT} diff`])
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

// ---------------------------------------------------------------- the guardrail: never point git outside the worktree

const location = (reason: string): Refusal => ({ pattern: classify(reason), worktree: WT, reason })

test('refusals about where git runs get no rewrite, only the remedy', async () => {
  const reasons = [
    'changes directory to the shared checkout (/repo) before running git',
    'changes directory to a location computed at runtime before running git',
    "points git at a directory computed at runtime (-C $D), which can't be verified before it runs",
    'sets GIT_DIR to the shared checkout (/repo/.git)',
    'redirects git to the shared checkout via GIT_WORK_TREE',
    "passes core.worktree=/repo to git, injecting configuration whose effect on where git writes can't be verified",
    'runs git from above the shared checkout, where its operands can reach the checkout',
  ]
  for (const reason of reasons) {
    for (const cmd of ['cd /repo && git commit -m x', 'cd src && git status', 'export GIT_DIR=/repo/.git; git status']) {
      const note = noteFor(location(reason), cmd)
      expect(note).toContain(`Run git in your own worktree, ${WT}`)
      expect(note).not.toContain('git -C')
      expect(note).not.toContain('Rewrite')
      expect(reminderFor(location(reason), cmd, 3)).not.toContain('git -C')
    }
  }
  const cwd = parseRefusal(CWD_ELSEWHERE)!
  expect(noteFor(cwd, 'cd /repo && git status')).not.toContain('git -C')
  expect(noteFor({ pattern: 'other', worktree: WT, reason: 'is in a different worktree (/repo/.claude/worktrees/b)' }, 'cd ../b && git status')).not.toContain('git -C')
})

test('no rewrite when a directory resolves outside the worktree', async () => {
  for (const cmd of [
    'cd /repo && git commit -m x',
    'cd .. && git status',
    'cd ../agent-other && git status',
    `cd ${WT}/../agent-other && git status`,
    `cd ${WT}/src/../../.. && git status`,
    'cd src && cd ../../.. && git log',
    'cd / && git status',
    `cd ${WT}-evil && git status`,
    'cd /repo && npm test && git status',
    'git -C /repo status && git diff',
    'git -C .. status; git diff',
    `git -C ${WT}/../x log; git diff`,
    'cd src && git -C ../../.. status',
    'cd ~ && git status',
    'cd - && git status',
    'cd $HOME && git status',
    'git -C ~/x status; git diff',
  ]) expect([cmd, rewrite(cmd, WT)]).toEqual([cmd, undefined])
})

test('no rewrite when a segment sets or exports GIT_*', async () => {
  for (const cmd of [
    'export GIT_DIR=/repo/.git; git status',
    'export GIT_WORK_TREE=/repo && git status',
    'GIT_DIR=/repo/.git git status; git log',
    'GIT_INDEX_FILE=/tmp/i git add -A && git commit',
    'declare -x GIT_DIR=/repo/.git; git status',
    'env GIT_DIR=/repo/.git git status; git log',
    'unset GIT_DIR; git status',
    'FOO=1; git status',
    'export FOO=1 && git status',
  ]) expect([cmd, rewrite(cmd, WT)]).toEqual([cmd, undefined])
})

test("no rewrite when git has -c, --git-dir, --work-tree, --namespace, or -C outside", async () => {
  for (const cmd of [
    'git -c core.worktree=/repo status; git log',
    'cd src && git -c user.name=x commit',
    'git --git-dir=/repo/.git status; git log',
    'git --git-dir /repo/.git status && git log',
    'git --work-tree=/repo status; git log',
    'git --work-tree /repo add -A && git commit',
    'git --namespace=x fetch; git log',
    'git --config-env=core.worktree=X status; git log',
    'git --bare status; git log',
    'git -C /etc status; git log',
    'git -C src -C /repo status; git log',
    'git log; git status --git-dir=/repo/.git',
  ]) expect([cmd, rewrite(cmd, WT)]).toEqual([cmd, undefined])
  // A subcommand's own -c is not git's: `git switch -c` stays rewritable.
  expect(rewrite('cd src && git switch -c feature', WT)).toEqual([`git -C ${WT}/src switch -c feature`])
  // An inside -C is folded into the one -C the rewrite sets.
  expect(rewrite(`git -C ${WT}/a -C b status; git --no-pager log`, WT)).toEqual([`git -C ${WT}/a/b status`, `git -C ${WT} --no-pager log`])
})

test('paths resolve lexically, and inside means the worktree or under it', async () => {
  expect(resolvePath(WT, '../x')).toBe('/repo/.claude/worktrees/x')
  expect(resolvePath(WT, '/a/./b/../c')).toBe('/a/c')
  expect(isInside(WT, WT)).toBe(true)
  expect(isInside(`${WT}/src/..`, WT)).toBe(true)
  expect(isInside(`${WT}/src/../..`, WT)).toBe(false)
  expect(isInside(`${WT}-evil`, WT)).toBe(false)
  expect(isInside('relative', WT)).toBe(false)
  expect(isInside('/x', '/')).toBe(false)
})

test('property: no emitted rewrite ever names a path outside the worktree', async () => {
  // A small seeded generator over the pieces that could lead git out of the worktree.
  let seed = 12345
  const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n)
  const pick = <T,>(xs: readonly T[]) => xs[rand(xs.length)]!
  const dirs = ['src', 'a/b', '.', '..', '../..', '../other', '/repo', '/', '/tmp', WT, `${WT}/src`, `${WT}/..`, `${WT}/src/../..`, `${WT}-x`, `'${WT}/with space'`, `"${WT}/q"`, '~', '~/x', '$HOME', '-', 'src/../..']
  const gitOpts = ['', '-C src ', '-C .. ', '-C /repo ', `-C ${WT}/a `, '-c core.worktree=/repo ', '--git-dir=/repo/.git ', '--work-tree /repo ', '--namespace=n ', '--no-pager ', '-p ', '--bare ']
  const subs = ['status', 'log -1', 'add -A', 'commit -m "a; b"', 'switch -c x', 'diff --stat', 'push origin HEAD']
  const segment = () => {
    switch (rand(6)) {
      case 0: return `cd ${pick(dirs)}`
      case 1: return `export GIT_DIR=${pick(dirs)}`
      case 2: return `GIT_WORK_TREE=${pick(dirs)} git ${pick(subs)}`
      case 3: return 'npm test'
      default: return `git ${pick(gitOpts)}${pick(gitOpts)}${pick(subs)}`
    }
  }
  const pathsIn = (cmd: string) => {
    const found: string[] = []
    for (const m of cmd.matchAll(/(?:git -C|^cd) ('[^']*'|"[^"]*"|\S+)/g)) found.push(m[1]!.replace(/^['"]|['"]$/g, ''))
    return found
  }
  let offered = 0
  for (let i = 0; i < 3000; i++) {
    const n = 1 + rand(4)
    const cmd = Array.from({ length: n }, segment).join(pick([' && ', '; ', '\n', ' || ']))
    const out = rewrite(cmd, WT)
    if (out === undefined) continue
    offered++
    for (const step of out) {
      const paths = pathsIn(step)
      if (/^git\b/.test(step)) expect([step, paths.length]).toEqual([step, 1]) // exactly one -C, set by the rewrite
      for (const p of paths) expect([step, p, isInside(p, WT)]).toEqual([step, p, true])
      expect([step, /GIT_|--git-dir|--work-tree|--namespace|--bare|^git -C \S+ (?:-\S+ )*-c\b/.test(step)]).toEqual([step, false])
    }
  }
  expect(offered).toBeGreaterThan(50) // the generator does reach rewritable commands
})
