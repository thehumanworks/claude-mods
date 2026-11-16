// Runs the wrap through real bash, the way Claude Code runs a Bash call
// (`eval '<command>' < /dev/null && pwd -P >| <cwd file>`, stdout and stderr to
// one file), and checks that the wrapped command behaves as the command itself:
// the same output in the same order, the same exit code, the same working
// directory after it, and the whole output in the wrap's file.
//
// The plugin test kit cannot start processes, so this is a node test of its own:
//   node --experimental-strip-types --test output-shaper/tests/wrap-bash.mjs
// (Node 22.18 and later strip types without the flag.)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { skipReason, wrapCommand, shellQuote } from '../hooks/wrap.ts'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'output-shaper-wrap-')))
mkdirSync(join(root, 'sub dir'))
writeFileSync(join(root, 'sub dir', 'x.txt'), 'in sub\n')
process.on('exit', () => rmSync(root, { recursive: true, force: true }))

let n = 0
/** Runs `command` as Claude Code would: output (2>&1, one file), exit code, the cwd it records. */
function run(command) {
  n += 1
  const out = join(root, `out-${n}.txt`)
  const cwdFile = join(root, `cwd-${n}.txt`)
  const script = `cd ${shellQuote(root)} && eval ${shellQuote(command)} < /dev/null && pwd -P >| ${shellQuote(cwdFile)}`
  let code = 0
  try {
    execFileSync('bash', ['-c', `{ ${script}
} > ${shellQuote(out)} 2>&1`], { stdio: 'ignore', timeout: 20_000 })
  } catch (err) {
    code = err.status ?? -1
  }
  return { output: readFileSync(out, 'utf8'), code, cwd: existsSync(cwdFile) ? readFileSync(cwdFile, 'utf8').trim() : undefined }
}

/** The command and its wrap give the same result, and the wrap's file holds the whole output. */
function same(command, expected = {}) {
  assert.equal(skipReason(command), undefined, `should be wrapped: ${command}`)
  const file = join(root, `tail-${n + 1}.txt`)
  const plain = run(command)
  const wrapped = run(wrapCommand(command, file))
  assert.equal(wrapped.output, plain.output, `output of ${command}`)
  assert.equal(wrapped.code, plain.code, `exit code of ${command}`)
  assert.equal(wrapped.cwd, plain.cwd, `cwd after ${command}`)
  assert.equal(readFileSync(file, 'utf8'), plain.output, `the file of ${command}`)
  if (expected.code !== undefined) assert.equal(plain.code, expected.code)
  if (expected.output !== undefined) assert.equal(plain.output, expected.output)
  return plain
}

test('exit codes 0, 1, 2 and 127 are kept', () => {
  same('echo ok', { code: 0, output: 'ok\n' })
  same('echo bad; false', { code: 1 })
  same('ls /nonexistent-output-shaper-path', { code: 2 })
  same('no-such-command-output-shaper', { code: 127 })
  same('(exit 42)', { code: 42 })
})

test('quoting: single and double quotes, $, backticks and newlines', () => {
  same(`echo 'it'"'"'s' "a \\"b\\" \$HOME-free" '$HOME' \`echo tick\` "$(echo sub)"`)
  same(`X='a b'; echo "$X" '$X' \\$X`)
  same(`printf '%s\\n' "line one
line two" 'three
four'`)
  same(`echo "}" '}' \\}; echo { }`)
  same(`echo "# not a comment" # a comment with ' an open quote`)
  same(`echo $'tab\\there' "back\\\\slash"`)
})

test('cd inside the command moves the working directory as it does unwrapped', () => {
  const r = same(`cd 'sub dir' && cat x.txt`, { output: 'in sub\n' })
  assert.equal(r.cwd, join(root, 'sub dir'))
  same('cd /tmp; pwd')
  // A failing command records no cwd, wrapped or not.
  same(`cd 'sub dir' && false`, { code: 1 })
})

test('&& and || chains', () => {
  same('true && echo yes || echo no')
  same('false && echo yes || echo no')
  same('false || (echo err >&2; exit 3)', { code: 3 })
  same('echo a && echo b >&2 && echo c', { output: 'a\nb\nc\n' })
})

test('subshells, pipes and groups', () => {
  same('(cd /; pwd); pwd')
  same('{ echo one; echo two >&2; } | sort')
  same('echo x | grep -q y', { code: 1 })
  same('for i in 1 2 3; do echo "n=$i"; done; if true; then echo t; fi')
})

test('stdout and stderr keep their order', () => {
  same('for i in $(seq 1 200); do echo "out $i"; echo "err $i" >&2; done')
})

test('a long failing output: the wrap file holds the real end', () => {
  const r = same('seq 1 20000 | sed "s/^/test_case_/"; echo "FAILED: test_widget_overflow"; (exit 1)', { code: 1 })
  assert.ok(r.output.endsWith('FAILED: test_widget_overflow\n'))
  assert.ok(r.output.length > 200_000)
})

test('a file that cannot be written leaves the output and exit code as they were', () => {
  const command = 'echo still here; (exit 4)'
  const plain = run(command)
  const wrapped = run(wrapCommand(command, '/nonexistent-dir-output-shaper/x.txt'))
  assert.deepEqual(wrapped, { ...plain, cwd: plain.cwd })
  assert.equal(wrapped.code, 4)
})

test('the variables and file descriptors of the wrap are gone afterwards', () => {
  const file = join(root, 'tail-clean.txt')
  const r = run(`${wrapCommand('echo hi', file)}\necho "[\${__output_shaper_p-unset}\${__output_shaper_o-}]"; ls /proc/$$/fd | wc -l`)
  const plain = run('echo hi\necho "[unset]"; ls /proc/$$/fd | wc -l')
  assert.equal(r.output, plain.output)
})

test('comments, trailing semicolons and trailing newlines', () => {
  same('echo a # trailing comment')
  same('echo a;')
  same('echo a\n\n')
  same('echo one\n# a comment line\necho two # and one more')
  same('echo "#not" a#b')
})

test('the shell numbers lines in its messages as it does unwrapped', () => {
  same('no-such-command-output-shaper', { code: 127 })
  same('echo ok\nno-such-command-output-shaper\necho after', { code: 0 })
})

test('a child left holding the output delays the end by 3 seconds at most', () => {
  const file = join(root, 'tail-daemon.txt')
  const started = Date.now()
  const r = run(wrapCommand(`bash -c 'sleep 8 &'; echo done; (exit 6)`, file))
  const took = Date.now() - started
  assert.equal(r.code, 6)
  assert.ok(r.output.startsWith('done\n'))
  assert.ok(took < 7_000, `took ${took} ms`)
})

test('under zsh-like shells without bash the command still runs unwrapped', () => {
  const file = join(root, 'tail-sh.txt')
  // bash in POSIX sh mode still has BASH_VERSION; an unset one stands for another shell.
  const r = run(`BASH_VERSION= ; ${wrapCommand('echo plain; exit 5', file)}`)
  assert.equal(r.output, 'plain\n')
  assert.equal(r.code, 5)
  assert.equal(existsSync(file), false)
})
