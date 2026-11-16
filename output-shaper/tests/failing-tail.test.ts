import type { On, Register, ToolCallResult } from 'claude-code'
import { expect, test, type Engine } from 'claude-code/testing'
import { lostTheEnd, linesOf, TAIL_FILE_MAX_AGE_MS } from '../hooks/shape.js'
import { outsideParens, skipReason, unquoted, wrapCommand, WRAP_PREFIX } from '../hooks/wrap.js'

const ROOT = '/repo'
const SESSION = 's1'
const BASE = `${ROOT}/.claude/output-shaper`
const TAILS = `${BASE}/tails`
const FILE = `${TAILS}/tail-toolu_1.txt`

/** `n` lines, `prefix 1` to `prefix n`, each closed by a newline. */
const numbered = (n: number, prefix = 'test_case') => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1} ... ok`).join('\n') + '\n'
/** The output of the live eval's script: about 49,000 characters ending in the failure. */
const FAILING = `${numbered(1500)}FAILED: test_widget_overflow\n`

/**
 * What Claude Code 2.1.325 gives the model for a failing command: `Exit code N`,
 * then the output cut at 30,000 characters, and that cut to its first and last
 * 5,000 characters around its marker.
 */
function claudeCodeError(output: string, code = 1): string {
  const capped = output.slice(0, 30_000).trimEnd()
  const body = capped.length <= 10_000 ? capped : `${capped.slice(0, 5_000)}\n\n... [${capped.length - 10_000} characters truncated] ...\n\n${capped.slice(-5_000)}`
  return `Exit code ${code}\n${body}`
}

type Answer = { result: unknown; text?: string; isError?: true; context?: readonly string[]; ref?: number }
type Verdict = 'allow' | 'ask' | 'deny'
type Options = {
  /** The verdict for the command as written (the mod's own query). Default: allow. */
  asWritten?: Verdict
  /** The verdict for the wrapped line on the real call. Default: allow. */
  wrapped?: Verdict
}

/** The command the wrap holds, or the command itself when it is not wrapped. */
function unwrap(command: string): { original: string; file?: string } {
  if (!command.includes(WRAP_PREFIX)) return { original: command }
  const original = /; else __output_shaper_p=; fi; \{ ([\s\S]*?)(?:; \}|\n\}); __output_shaper_rc=/.exec(command)?.[1]
  const file = /exec tee -- '([^']+)'/.exec(command)?.[1]
  if (original === undefined || file === undefined) throw new Error(`not a wrap: ${command}`)
  return { original, file }
}

/**
 * Stands in for Claude Code beneath the plugin. Bash answers what `answer` gives
 * for the command as the model wrote it, and when the line reaching it is a wrap,
 * plays tee: the whole output (`full`, else stdout) lands in the wrap's file.
 */
function engine(on: On, answer: (command: string) => Answer & { full?: string }, options: Options = {}) {
  const files = new Map<string, string>()
  const mtimes = new Map<string, number>()
  const links = new Set<string>()
  const seen = { commands: [] as string[], writes: [] as string[], removed: [] as string[], checks: [] as string[], logs: [] as string[] }
  on('session.root', () => ({ value: ROOT }))
  on('session.id', () => ({ value: SESSION }))
  on('tool.check', (_, e) => {
    const command = (e.input as { command: string }).command
    seen.checks.push(e.tool_use_id === undefined ? `query: ${command}` : `call: ${command.includes(WRAP_PREFIX) ? 'wrapped' : command}`)
    if (e.tool_use_id === undefined) return { decision: options.asWritten ?? 'allow' }
    return { decision: command.includes(WRAP_PREFIX) ? (options.wrapped ?? 'allow') : 'allow' }
  })
  on('tool.call', { tool: 'Bash' }, (_, e) => {
    seen.commands.push(e.command)
    const { original, file } = unwrap(e.command)
    const { full, ...a } = answer(original)
    if (file !== undefined && files.has(file)) {
      const record = a.result as { stdout?: string } | undefined
      files.set(file, full ?? (typeof record === 'object' && record !== null ? record.stdout ?? '' : ''))
    }
    return a as never
  })
  on('fs.write', (_, e) => {
    seen.writes.push(e.path)
    files.set(e.path, e.text)
    mtimes.set(e.path, Date.now())
    return { value: undefined } as never
  })
  on('fs.read', (_, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text } as never
  })
  on('fs.exists', (_, e) => ({ value: files.has(e.path) }) as never)
  on('fs.stat', (_, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: { kind: 'file', size: text.length, mtimeMs: mtimes.get(e.path) ?? 0, isLink: links.has(e.path) } } as never
  })
  on('fs.list', (_, e) => {
    const dir = `${e.path}/`
    const names = [...files.keys()].filter(p => p.startsWith(dir) && !p.slice(dir.length).includes('/'))
    return { value: names.map(p => ({ name: p.slice(dir.length), kind: 'file', size: files.get(p)!.length, mtimeMs: mtimes.get(p) ?? 0, isLink: links.has(p) })) } as never
  })
  on('process.run', (_, e) => {
    const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as never
    if (e.argv[0] === 'bash' && e.argv[1] === '-n') {
      return { value: { exitCode: e.argv[3]!.includes('BAD-SYNTAX') ? 2 : 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
    }
    if (e.argv[0] === 'rm') {
      expect(e.argv.slice(1, 3)).toEqual(['-f', '--'])
      for (const p of e.argv.slice(3)) {
        seen.removed.push(p)
        files.delete(p)
      }
      return ok()
    }
    throw new Error(`unexpected process.run: ${e.argv.join(' ')}`)
  })
  on('ui.log', (_, e) => {
    seen.logs.push(e.text)
    return { value: undefined } as never
  })
  return { files, mtimes, links, seen }
}

/** A Bash call of the model's in the main loop. */
const bash = ($: Engine, command: string, more: Record<string, unknown> = {}) =>
  $.tool.call({ tool: 'Bash', command, tool_use_id: 'toolu_1', ...more } as never) as Promise<ToolCallResult>

const failed = (output: string, code = 1): Answer & { full: string } => {
  const text = claudeCodeError(output, code)
  return { isError: true, result: text, text, ref: 4, full: output }
}
const ok = (stdout: string): Answer => ({ result: { stdout, stderr: '', interrupted: false }, text: stdout, ref: 7 })

test('a failing command whose output Claude Code cut: Claude reads its real last lines and the path', async ($, on) => {
  const { files, seen } = engine(on, () => failed(FAILING))
  const r = await bash($, './t.sh')
  // The wrapped line ran, holding the command as written.
  expect(seen.commands.length).toBe(1)
  expect(unwrap(seen.commands[0]!)).toEqual({ original: './t.sh', file: FILE })
  expect(files.get(`${BASE}/.gitignore`)).toBe('*\n')
  // What Claude Code made stays as it was, and lost the end.
  expect(r.isError).toBe(true)
  expect(r.text).toBe(claudeCodeError(FAILING))
  expect(r.text).not.toContain('test_widget_overflow')
  expect(r.ref).toBe(4)
  const [note] = r.context ?? []
  expect(note).toContain(`The whole output (1,501 lines, ${FAILING.length.toLocaleString('en-US')} characters) is in ${FILE}`)
  expect(note).toContain('These are its last 60 lines:')
  expect(note).toContain('test_case 1500 ... ok\nFAILED: test_widget_overflow\n')
  expect(note).not.toContain('test_case 1441 ... ok')
  expect(note).toContain('Grep that file')
  // The file stays for Claude to read.
  expect(files.get(FILE)).toBe(FAILING)
  expect(seen.removed).toEqual([])
})

test('the note keeps to tailLines, and to its character cap', { options: { tailLines: 1000 } }, async ($, on) => {
  const long = Array.from({ length: 2000 }, (_, i) => `${i} ${'x'.repeat(400)}`).join('\n') + '\nFAILED: last\n'
  engine(on, () => failed(long))
  const [note] = (await bash($, 'make test')).context ?? []
  expect(note!.length).toBeLessThan(11_000)
  expect(note).toContain('FAILED: last')
})

test('a failing command Claude Code did not cut: no note, and the file is removed', async ($, on) => {
  const { files, seen } = engine(on, () => failed('short failure\nFAILED: test_x\n', 2))
  const r = await bash($, 'pytest -x')
  expect(r.context).toBeUndefined()
  expect(r.text).toBe('Exit code 2\nshort failure\nFAILED: test_x')
  expect(seen.removed).toEqual([FILE])
  expect(files.has(FILE)).toBe(false)
})

test('a cut marker the command printed itself, with nothing lost, adds no note', async ($, on) => {
  const output = 'a\n\n... [999 characters truncated] ...\n\nb\n'
  const text = `Exit code 1\n${output}`
  engine(on, () => ({ isError: true, result: text, text, full: output }))
  expect((await bash($, 'cat notes.txt')).context).toBeUndefined()
})

test('a cut that kept the real end (a failure under the inline limit) is told by the size and the marker', async () => {
  const output = numbered(600)
  const text = claudeCodeError(output)
  expect(text).toContain('characters truncated')
  expect(lostTheEnd(text, output.length, linesOf(output))).toBe(true)
  // Same size, same end: nothing lost.
  expect(lostTheEnd(`Exit code 1\n${output}`, output.length, linesOf(output))).toBe(false)
  // No marker, but the end is not what Claude read.
  expect(lostTheEnd('Exit code 1\nline 1', 5_000, ['line 1', 'line 2', 'FAILED'])).toBe(true)
  // Colour codes do not hide the end.
  expect(lostTheEnd('x\n\u001b[31mFAILED\u001b[0m', 50, ['a', '\u001b[31mFAILED\u001b[0m'.padEnd(60)])).toBe(false)
})

test('a command that succeeds: the result is Claude Code\'s, and the file is removed', async ($, on) => {
  const { files, seen } = engine(on, () => ok('all good\n'))
  const r = await bash($, 'npm test')
  expect(r).toEqual(ok('all good\n') as never)
  expect(seen.removed).toEqual([FILE])
  expect(files.has(FILE)).toBe(false)
})

test('a big success Claude Code saved itself is shaped as before, and the wrap\'s copy is removed', async ($, on) => {
  const core = `/home/u/.claude/projects/-repo/${SESSION}/tool-results/toolu_1.txt`
  const whole = numbered(3000)
  const { files, seen } = engine(on, () => ({ ...ok(whole.slice(0, 2000)), result: { stdout: whole.slice(0, 2000), stderr: '', interrupted: false, persistedOutputPath: core }, full: whole }))
  files.set(core, whole)
  const r = await bash($, 'npm test')
  expect((r.result as { stdout: string }).stdout).toContain(`the whole output is in ${core}`)
  expect(r.context).toBeUndefined()
  expect(seen.removed).toEqual([FILE])
})

test('a success whose output was cut with no copy kept: the file stays and Claude gets its path', async ($, on) => {
  const whole = `${numbered(10)}END\n`
  const { files } = engine(on, () => ({ ...ok('test_case 1 ... ok'), full: whole }))
  const r = await bash($, 'npm test')
  expect(r.context).toEqual([`output-shaper: the result above was cut; the whole output (11 lines, ${whole.length} characters) is in ${FILE}. Grep it or Read it with offset and limit rather than running the command again.`])
  expect(files.get(FILE)).toBe(whole)
})

test('the off switch: the command runs exactly as written and nothing is written', { options: { keepFailingTail: false } }, async ($, on) => {
  const { seen } = engine(on, () => failed(FAILING))
  const r = await bash($, './t.sh')
  expect(seen.commands).toEqual(['./t.sh'])
  expect(r.context).toBeUndefined()
  expect(seen.writes).toEqual([])
  expect(seen.checks.filter(c => c.startsWith('query'))).toEqual([])
})

test('background commands, heredocs and other unsafe commands are never wrapped', async ($, on) => {
  const { seen } = engine(on, () => ok('x'))
  const commands = ['npm run dev &', 'sleep 1 & echo hi', "cat <<'EOF' > a.txt\nhi\nEOF", 'read -r line', 'vim a.txt', 'exit 3', 'python3', 'git commit -m x', 'docker run -it ubuntu']
  for (const command of commands) await bash($, command)
  await bash($, 'npm test', { run_in_background: true })
  expect(seen.commands).toEqual([...commands, 'npm test'])
  expect(seen.writes).toEqual([])
})

test('a command not allowed outright is not wrapped, so a person is only ever asked about the command as written', { }, async ($, on) => {
  const { seen } = engine(on, () => ok('x'), { asWritten: 'ask' })
  await bash($, 'npm test')
  expect(seen.commands).toEqual(['npm test'])
  expect(seen.checks).toEqual(['query: npm test', 'call: npm test'])
})

test('a wrapped line the rules would ask about is allowed, as the command it wraps is', async ($, on) => {
  const { seen } = engine(on, () => failed(FAILING), { wrapped: 'ask' })
  const r = await bash($, './t.sh')
  expect(seen.checks).toEqual(['query: ./t.sh', 'call: wrapped'])
  expect(seen.commands.length).toBe(1)
  expect(r.context?.[0]).toContain('FAILED: test_widget_overflow')
})

test('a wrapped line that is denied runs again as written', async ($, on) => {
  const { seen, files } = engine(on, () => failed(FAILING), { wrapped: 'deny' })
  const r = await bash($, './t.sh')
  expect(seen.commands.length).toBe(1) // the denied line never reached Bash
  expect(seen.commands[0]).toBe('./t.sh')
  expect(r.text).toBe(claudeCodeError(FAILING))
  expect(r.context).toBeUndefined()
  expect(files.has(FILE)).toBe(false)
})

test('a command the shell would read differently is not wrapped', async ($, on) => {
  const { seen } = engine(on, () => ok('x'))
  await bash($, 'echo BAD-SYNTAX')
  expect(seen.commands).toEqual(['echo BAD-SYNTAX'])
})

test('another plugin\'s call and a subagent\'s are never wrapped', { plugins: [] }, async ($, on) => {
  const { seen } = engine(on, () => ok('x'))
  await bash($, 'npm test', { agentId: 'a1' })
  expect(seen.commands).toEqual(['npm test'])
})

/** A mod of its own that runs a Bash command when a turn ends. */
const caller: { name: string; register: Register } = {
  name: 'caller',
  register: on => {
    on('turn.complete', async ($, e, next) => {
      await $.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: 'toolu_plugin' } as never)
      return next(e)
    })
  },
}

test('a call another plugin makes is not wrapped', { plugins: [caller] }, async ($, on) => {
  const { seen } = engine(on, () => ok('x'))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never)
  expect(seen.commands).toEqual(['npm test'])
})

test('a link put in place of the file is not read', async ($, on) => {
  const { links } = engine(on, () => failed(FAILING))
  links.add(FILE)
  expect((await bash($, './t.sh')).context).toBeUndefined()
})

test('old wrap files are cleaned: past a day, and past the newest 20; nothing else in the folder', async ($, on) => {
  const { files, mtimes, seen } = engine(on, () => ok('fine'))
  const now = Date.now()
  for (let i = 0; i < 25; i++) {
    const p = `${TAILS}/tail-toolu_old${i}.txt`
    files.set(p, 'x')
    mtimes.set(p, now - i * 60_000)
  }
  const stale = `${TAILS}/tail-toolu_stale.txt`
  files.set(stale, 'x')
  mtimes.set(stale, now - TAIL_FILE_MAX_AGE_MS - 1)
  files.set(`${TAILS}/notes.txt`, 'mine')
  mtimes.set(`${TAILS}/notes.txt`, 0)
  await bash($, 'npm test')
  const left = [...files.keys()].filter(p => p.startsWith(`${TAILS}/`)).sort()
  expect(left).toContain(`${TAILS}/notes.txt`)
  expect(left).not.toContain(stale)
  expect(left.filter(p => /tail-toolu_old/.test(p)).length).toBe(20)
  expect(left).not.toContain(`${TAILS}/tail-toolu_old24.txt`)
  expect(seen.removed).toContain(FILE)
})

test('a saveDir of its own holds the wrap files beside the saved output', { options: { saveDir: '/tmp/shaped' } }, async ($, on) => {
  const { seen } = engine(on, () => failed(FAILING))
  const r = await bash($, './t.sh')
  expect(unwrap(seen.commands[0]!).file).toBe('/tmp/shaped/tail-toolu_1.txt')
  expect(r.context?.[0]).toContain('/tmp/shaped/tail-toolu_1.txt')
})

test('skipReason: what is wrapped and what is left alone', async () => {
  const wrapped = [
    './t.sh',
    'npm test 2>&1 | tail -n 50',
    'cd sub && make && ./run || echo failed',
    '(cd /tmp && ls) ; pwd',
    `echo 'single' "double $HOME" \`date\` $(pwd)`,
    'printf "a\nb"\necho two',
    'cmd <<< "here string"',
    'cmd >&2; cmd &> log; cmd |& cat',
    'source .venv/bin/activate && pytest',
    '( exit 3 ); echo $?',
    'echo "exit" "set -e" \'trap\'',
    'docker build -t app .',
    'git log --oneline | cat',
  ]
  for (const c of wrapped) expect([c, skipReason(c)]).toEqual([c, undefined])
  const left: [string, string][] = [
    ['', 'empty'],
    ['npm start &', 'runs something in the background'],
    ['a & b', 'runs something in the background'],
    ['curl "x?a=1&b=2"', 'runs something in the background'],
    ['cat <<EOF\nx\nEOF', 'a heredoc'],
    ['diff <(a) <(b)', 'process substitution'],
    ['echo "open', 'an open quote'],
    ['echo a \\', 'ends in a backslash'],
    ['make; exit 1', 'uses `exit`'],
    ['set -e; make', 'uses `set`'],
    ['trap "x" EXIT', 'uses `trap`'],
    ['eval "$CMD"', 'uses `eval`'],
    ['while read l; do :; done', 'uses `read`'],
    ['cat /dev/stdin', 'reads stdin or the terminal'],
    ['less log.txt', '`less` is interactive'],
    ['FOO=1 sudo make install', '`sudo` is interactive'],
    ['node', '`node` alone reads stdin'],
    ['git rebase -i HEAD~2', '`git rebase` can open an editor'],
    ['git add -p', '`git add` is interactive'],
    ['kubectl run -it box --image=busybox', '`kubectl` with a terminal or stdin'],
    ['kubectl exec -it pod -- sh', 'uses `exec`'],
    [`echo ${WRAP_PREFIX}x`, 'already wrapped'],
  ]
  for (const [c, why] of left) expect([c, skipReason(c)]).toEqual([c, why])
  expect(skipReason('x'.repeat(20_001))).toBe('too long')
})

test('unquoted and outsideParens read words as the shell does', async () => {
  expect(unquoted(`echo 'a & b' "c # d" e # f'`)).toBe(`echo '     ' "     " e     `)
  expect(unquoted(`echo $'it\\'s' x`)).toBe(`echo  '     ' x`)
  expect(unquoted(`echo 'open`)).toBeUndefined()
  expect(outsideParens('a (exit 1) b $(exit 2)')).toBe('a (      ) b $(      )')
})

test('wrapCommand keeps the command whole and on its own lines', async () => {
  const one = wrapCommand(`echo "it's" $X`, '/r/t.txt')
  expect(one.split('\n').length).toBe(1)
  expect(unwrap(one)).toEqual({ original: `echo "it's" $X`, file: '/r/t.txt' })
  const multi = wrapCommand('echo a\necho b # comment', "/r/it's.txt")
  expect(multi.split('\n').length).toBe(3)
  expect(multi).toContain(`exec tee -- '/r/it'\\''s.txt'`)
  expect(multi).toContain('{ echo a\necho b # comment\n}; ')
  expect(wrapCommand('make;  ', '/f')).toContain('{ make; }; ')
})
