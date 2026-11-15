# edit-check

Catches Claude's mistakes in the same turn.

After Claude edits files, the mod runs your project's own check command (a type checker, a linter, a fast test) in the background. When the check finds errors in the files Claude just touched, Claude reads them at its next request, next to the result of its next tool call. It can fix them before it says it is done.

No model calls, no network. The mod runs only the command you give it.

## Install

```
/plugin install edit-check --marketplace thehumanworks/claude-mods
```

Answer `y` to add the marketplace, then pick a scope. From a checkout, for one session: `claude --plugin-dir ./edit-check`.

The mod is off until you set a check command, on the screen the install shows or in `/config`.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| Check command (`command`) | empty | The command to run after edits, through the shell (`sh -c`, or `cmd /c` on Windows), in the session's folder. Empty: the mod is off. |
| Files it applies to (`globs`) | empty | Globs of the edited files that start a check, separated by commas. A glob with a slash is matched against the path in the session's folder (`src/**/*.ts`), one without against the file name (`*.py`). Empty: every file. |
| Timeout (`timeoutSeconds`) | `60` | A check still running after this long is stopped. 1 to 600. |
| Max characters of output (`maxChars`) | `4000` | What Claude is handed of the errors is cut to this length. 200 to 50,000. |

Some commands to start from:

| Project | Command | Globs |
| --- | --- | --- |
| TypeScript | `npx tsc --noEmit -p .` | `**/*.{ts,tsx}` |
| ESLint | `npx eslint --cache .` | `**/*.{js,jsx,ts,tsx}` |
| Python | `ruff check .` | `*.py` |
| Python types | `mypy .` | `*.py` |
| Rust | `cargo check --quiet` | `*.rs` |
| Go | `go vet ./...` | `*.go` |

## How it works

- **When it runs.** After each Edit, Write or NotebookEdit call that succeeded on a matching file, by the main loop or a subagent. Edits less than 1.5 seconds apart start one check, after the last. The tool call is never held up: the check runs on its own.
- **One at a time.** Edits made while a check runs start the next one when it ends. A check that had a file edited under it is dropped, and the next one covers its files too.
- **What Claude reads.** Only the error lines that name a file edited since the last check, with the command and its exit code. A line counts when it names the file by its path in the session's folder or its absolute path. Indented lines stay with the line above them, so an error keeps its notes (tsc, rustc) and a file heading keeps the errors listed under it (eslint).
- **When no line names those files.** Claude reads the first 30 lines instead. Errors the last check also had are left out, so failures that were there before the edits are not handed over again at each check.
- **When it reads it.** At its next request: after its next tool call, or with the next prompt when the turn has ended. Each result is handed over once. A newer result replaces one not yet handed over, so an error already fixed is never told.
- **When the check passes.** Nothing is said. After a failure Claude was told of, one short note: `` edit-check: `<command>` passes again. `` If the check still fails, but only on errors it had before the edits, the note says that instead.
- **Timeouts and commands that cannot start.** The check is stopped and nothing reaches Claude. You see one notice per session.

## Limits

- The check runs over the whole project, as your command does. A slow command (a full test suite) makes the results come late; pick a fast one, or one that checks less.
- A result reaches Claude at its next tool call or prompt. If Claude ends its turn before the check is done, it reads the errors with your next prompt.
- Errors are matched to files by their paths. A tool that prints only file names, or paths relative to another folder, falls back to the first lines.
- What a subagent edits is checked, but what the check finds goes to the main loop.

## Development

```
claude plugin validate .
claude plugin test .
```

`hooks/register.ts` is the hooks module: it watches the edits, runs the command and hands over the result. `hooks/check.ts` holds the logic, free of the engine: settings, globs, and what of the output Claude reads.
