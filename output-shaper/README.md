# output-shaper

Gives Claude a better view of a Bash command that prints a lot.

Without this mod, a long output reaches Claude in one of two ways. Up to 30,000 characters, it gets all of it, which can fill its context with log lines it never needed. Past that, Claude Code saves the output to a file and Claude sees only the first 2 KB and the path. A build or test run usually puts its failure at the end, so Claude spends another call reading the file.

With this mod, once the output is over the threshold Claude reads:

- the first 40 lines,
- a marker with the line numbers left out and the total line and character counts,
- the last 60 lines,
- the path of the whole output, with a one-line hint to Grep it or Read a range of it instead of running the command again.

When a command fails and Claude Code cuts its output, Claude also reads the real last lines and the path of the whole output (see [Keeping the end of a failing command](#keeping-the-end-of-a-failing-command)). For that, the mod rewrites the command line of Claude's Bash calls.

No model calls, no network.

## Install

```
/plugin install output-shaper --marketplace thehumanworks/claude-mods
```

Answer `y` to add the marketplace, then pick a scope. From a checkout, for one session: `claude --plugin-dir ./output-shaper`.

## Settings

Set on the screen the install shows, and afterwards in `/config`.

| Setting | Default | What it does |
| --- | --- | --- |
| Shape output over (`threshold`) | `20000` | Output longer than this many characters is shaped. 2,000 to 200,000. Output Claude Code has already saved to a file is always shaped. The threshold is also the most the kept lines may take, up to 24,000 characters so the shape stays under Claude Code's own inline limit. |
| Lines from the start (`headLines`) | `40` | How many of the first lines Claude reads. 0 to 500. |
| Lines from the end (`tailLines`) | `60` | How many of the last lines Claude reads. 1 to 1,000. |
| Folder for saved output (`saveDir`) | empty | Where the whole output is saved when Claude Code did not save it already. Absolute, or relative to the session's folder. Empty means `.claude/output-shaper/<session id>` in the session's folder, and `.claude/output-shaper/tails` for the files of failing commands. A folder you set is used as it is: the mod writes only the output files there (`tail-<tool_use_id>.txt` for failing commands). |
| Keep the end of failing commands (`keepFailingTail`) | on | Wraps Claude's Bash commands so a failing command's whole output is kept and its real end reaches Claude. Off: every command runs exactly as Claude wrote it, and the mod behaves as it did before this setting existed. |

A number out of range keeps its default and says so in the log.

## What Claude Code does today (2.1.325)

Found in the API's types and in what the tool sends the model:

| Case | What the model sees |
| --- | --- |
| Output up to the inline limit | All of it. The limit is the `bashOutputMaxChars` setting: 30,000 characters by default, 4,000 to 128,000. |
| Output over the limit | Claude Code saves the whole output to the session's `tool-results` folder. The Bash record carries `persistedOutputPath` and `persistedOutputSize` (bytes). The model sees `<persisted-output>Output too large (…). Full output saved to: <path>` and a preview of the first 2 KB. Sometimes (`stdoutHoldsOutputEnd`) the preview is a start and an end of about 1.5 KB. There are no line counts. |
| Output over 64 MiB | Only the first 64 MiB are saved, and the notice says so. |
| A command that fails (non-zero exit) | An error result: `Exit code N`, then the output. Past about 10,000 characters it is cut to its first and last 5,000, with `... [N characters truncated] ...` between. Output over the inline limit is first cut to that limit, and no file is saved. So for a failing command with 49,000 characters of output (exit 3), Claude got `Exit code 3`, the first 5,000 characters, `... [20012 characters truncated] ...`, and the last 5,000 characters of the first 30,000. The real end of the output, where the failure usually is, was lost, and no saved-file notice or tool-results file was made. Claude Code saves a failing command's output only when its feature flag `tengu_parallel_sunrise` is on (it is off by default), and never for a `!` command you type. |

So Claude Code already saves big outputs. This mod builds on that and does not save them a second time:

- **Over Claude Code's limit:** the mod reuses Claude Code's own file. It reads the file for the counts and the last lines, and puts its shape in place of the 2 KB preview.
- **Between the threshold and Claude Code's limit:** Claude Code would send everything. The mod saves the output itself and sends the shape.

## How it works

| Question | Answer |
| --- | --- |
| Which calls | Only Bash calls Claude makes itself in the main loop. Calls another plugin makes are left alone, and so are a subagent's. |
| What is measured | stdout and stderr together, in characters. |
| What Claude reads | The tool's own result, rebuilt with the shaped stdout. Claude Code turns it into the model's text with Bash's own formatting, so its other notes still come through. |
| stderr | Kept whole up to 2,000 characters. Longer, its last lines (up to the `tailLines` setting) are kept. |
| Long lines | A kept line over 500 characters is cut, and says how much is left out. |
| Where the output goes | Claude Code's own file when there is one. Otherwise `.claude/output-shaper/<session id>/<tool_use_id>.txt`, or `<saveDir>/<tool_use_id>.txt` when you set a folder. Only the default `.claude/output-shaper` folder gets a `.gitignore` holding `*`, so git ignores it. |
| Saved files over 4 MiB | The mod cannot read them in one go, so it runs `wc`, `head` and `tail` on them. The size is then given in bytes. If those cannot run, Claude gets what Claude Code sent. |
| Errors | An error result is never cut or rewritten. The exit code, the output and Claude Code's own cut stay as they are. If Claude Code saved the output (its preview only shows the start), the mod adds the last lines and the path as context right after the result. That happens only when Claude Code saves a failing command's output, which needs its `tengu_parallel_sunrise` flag; the flag is off by default. Otherwise, when the command was wrapped (below) and Claude Code's cut lost the real end, the mod adds the real last lines and the path as context. |
| Which saved files it reads for an error | The path is taken from the error text, which also holds the command's own output, so it is trusted only when Claude Code's notice sits where Claude Code puts it (the line right after `Exit code N`), and only for a plain file in this session's own `projects/<project>/<session id>/tool-results/` folder, links followed. A command that prints a notice of its own gets nothing read. |
| Left alone | Output under the threshold, backgrounded commands, images, results with structured content, and calls a hook refused. |
| When something goes wrong | If the mod fails at any step, Claude gets the result Claude Code made, unchanged. |

What Claude reads looks like this (`npm test`, 3,000 lines):

```
> app@1.0.0 test
> jest
...                         (the first 40 lines)
[output-shaper: lines 41 to 2,940 (2,900 lines) left out here; 3,000 lines, 182,331 characters in all]
...                         (the last 60 lines)
Tests:       2 failed, 412 passed, 414 total
[output-shaper: the whole output is in /repo/.claude/output-shaper/3f0c…/toolu_01Ab.txt. To see more, Grep that file for a pattern or Read it with offset and limit (the line numbers above); do not run the command again for it.]
```

## Keeping the end of a failing command

Claude Code cuts a Bash call's output at 30,000 characters before any hook sees it, and saves no file for a failing command. A failing test run with 49,000 characters of output reached Claude as `Exit code 1`, its first 5,000 characters and the last 5,000 of its first 30,000: the failed test at the very end was lost.

So the mod has the shell keep a copy. **It rewrites the command line** of each Bash call Claude makes in the main conversation (not a subagent's, not another plugin's), before Claude Code runs it. The command stays byte for byte as Claude wrote it, inside a `{ ...; }` group in the same shell, on its own lines:

```
if <bash 4.4 or later> && command -v tee >/dev/null 2>&1; then exec {o}>&1 {e}>&2 > >(exec tee -- '<file>' 2>/dev/null) 2>&1; p=$!; else p=; fi; { <the command>; }; rc=$?; if [ -n "$p" ]; then exec 1>&$o 2>&$e {o}>&- {e}>&-; <wait up to 3 s for tee to finish>; fi; unset -v o e p i; (exit "$rc")
```

The real variable names start with `__output_shaper_`. When the command's last line holds a `#` (it may be a comment), the closing `}` goes on a line of its own. What this keeps:

- **Exit code:** the group's status is restored last with `(exit "$rc")`, so 0, 1, 2, 127 or any other comes back unchanged, and Claude Code's own `&& pwd -P` after it runs exactly when it did.
- **`cd`, `export` and the rest:** the group runs in the session's own shell, not a subshell, so a `cd` moves the working directory as before.
- **Output:** stdout and stderr go into one pipe in the order they were written, which is how Claude Code shows them already (merged). `tee` writes them on to Claude Code and to `<file>`. stdin is untouched.
- **Error messages:** the command keeps its line numbers, so `bash: line 1: ...` reads as before.
- **Other shells:** under zsh, bash before 4.4 or without `tee`, the group runs with no redirection and nothing is kept.

`<file>` is `.claude/output-shaper/tails/tail-<tool_use_id>.txt` in the session's folder (or `<saveDir>/tail-<tool_use_id>.txt`). After the call:

| Case | What happens |
| --- | --- |
| The command failed, and Claude Code's cut lost the real end (its `... [N characters truncated] ...` marker with a shorter result, or the file's last line missing from the result's end) | The result stays as Claude Code made it. Claude also reads, as context: the line and character counts, the path, and the real last lines (the `tailLines` setting, 60 by default, within 10,000 characters). The file stays. |
| The command failed with nothing lost | The file is removed. |
| The command succeeded | The file is removed: Claude Code or the shaper above keeps a copy of big output. If the output was cut and no other copy exists, the file stays and Claude reads its path. |
| Old files | Removed after a call, at most every 10 minutes: those older than a day, and all but the newest 20. Only `tail-<id>.txt` files are touched. |

A command is **never wrapped** (it runs exactly as written) when any of these holds. When in doubt the mod leaves the command alone.

- It runs in the background: `run_in_background`, or any `&` that is not `&&`, `|&`, `>&`, `<&` or `&>`, even a quoted one.
- It has a heredoc (`<<`; a `<<<` here-string is fine), process substitution (`<(` or `>(`), an open quote, or a line continuation at its end.
- It reads stdin or the terminal (`read`, `select`, `mapfile`, `coproc`, `/dev/stdin`, `/dev/tty`), or starts something interactive: an editor, a pager, `ssh`, `sudo`, a database shell, a REPL with no script, `git commit`/`rebase`/`merge`/`tag`, `git add -p`, `docker`/`kubectl` `run`/`exec` with `-i` or `-t`.
- It uses, outside a `( ... )` subshell, a builtin that acts on the shell itself: `exit`, `exec`, `return`, `trap`, `set`, `shopt`, `wait`, `eval`, job control and the like.
- `bash -n` refuses the command or its wrap, the command is over 20,000 characters, or the sandbox is on (its excluded commands are matched by command line).
- The session would not run the command as written with nobody asked (`$.tool.check` says anything but `allow`). So a permission prompt only ever shows the command Claude wrote.

Permissions: Claude Code checks the wrapped line, which a rule such as `Bash(npm test:*)` does not match. Since the command itself was allowed, the mod answers the same for the wrapped line when the check would only ask; if something stronger refuses the wrapped line (a deny rule, a hook's ask or deny, an option's own ask such as `permissions.blockReadsOutsideWorkingDirectories`), the call runs again as Claude wrote it, and only when that refusal stood: if a hook placed above the mod answers over it and the wrapped line runs, the command is not run a second time. The transcript and Claude both keep the command as Claude wrote it.

## Limits

- The transcript keeps the shaped result too, so the Bash row on your screen shows the shape, not the whole output. The file has all of it.
- The save folder for shaped output grows and is never pruned. Each session has a folder of its own under `.claude/output-shaper`, so old ones are easy to remove by hand, or remove the whole folder whenever you like. Only the failing-command files in `tails` are pruned (with `rm -f`).
- Claude's first Read of a saved file may ask you for permission, more so with a `saveDir` outside the project.
- The mod writes into `.claude/` in your project. A file watcher (a dev server, a test runner in watch mode) that does not ignore that folder may see the writes.
- When Claude Code cut its own file at 64 MiB, the counts cover only the part it saved.
- An output Claude really wanted whole (`cat` of a file of 20,000 characters) is shaped too. Claude can Read the saved file, or the original file. Raise the threshold if this happens often.
- An error is passed as Claude Code made it: cut to its first and last 5,000 characters, and when the output went over the inline limit, cut at that limit first. Only a wrapped command gets its real end back, as a note beside the result; a command left unwrapped (see the list above) gets nothing more.
- The wrap is a different command line from the one Claude wrote, so anything in Claude Code that reads the command line sees the wrap: the permission check (handled above), a `PreToolUse` hook of your own, and the classifier of auto mode. A hook that matches a command by its start (`^npm test`) no longer matches; one that matches a part of it still does. In plan mode a wrapped read-only command may be asked about where the command itself was not.
- A program the command leaves running in the background that keeps the output open (a daemon that does not close stdout) delays the end of the call by up to 3 seconds, and output it writes after that is not in the file.
- Not on Windows, and not under the sandbox: commands there are never wrapped.
- Only Bash. PowerShell and other tools are not shaped.

## Development

```
claude plugin validate .
claude plugin test .
node --experimental-strip-types --test tests/wrap-bash.mjs
```

The last one runs the wrap through real bash (the plugin test kit cannot start processes): for each command it compares the command and its wrap, run as Claude Code runs a Bash call, on output, order, exit code and working directory after it.

`hooks/register.ts` is the hooks module: it picks the calls, wraps their command line, reads or saves the whole output and returns the shaped result. `hooks/shape.ts` holds the logic, free of the engine: settings, the cut into first and last lines, and the words Claude reads. `hooks/wrap.ts` holds the wrap and the rules for which commands are left alone.
