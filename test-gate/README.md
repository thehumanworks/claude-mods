# test-gate

Stops Claude from ending a turn on untested edits.

Sometimes Claude edits code and ends its turn without running a single test or check. When that happens, this mod asks a small model whether the edits need a test run. If the answer is yes, the turn goes on once, with a short note: run the relevant tests, or say in one line why they are not needed.

It runs on the account Claude Code is signed in with. The question is one model call made by Claude Code itself; the mod needs no API key and calls no other service.

## Install

```
/plugin install test-gate --marketplace thehumanworks/claude-mods
```

Answer `y` to add the marketplace, then pick a scope. From a checkout, for one session: `claude --plugin-dir ./test-gate`.

## The model, and what a call costs

| | |
| --- | --- |
| Model | `claude-haiku-5-5` (fast, small, cheap), through Claude Code's own model call |
| When it is called | Only when a turn ends with files edited and no test or check run. At most once per turn. |
| Input | Capped at about 7,200 characters: the instructions (600), the edited paths (1,000), the edits (3,000, each cut to 300), your prompt (1,000) and Claude's last message (1,000). That is at most about 1,800 input tokens; a typical call is 300 to 1,000. |
| Output | Three short lines, about 30 tokens; capped at 200. |
| Time | Given up after 10 seconds by default. |

The call counts toward the session's cost in `/cost`, like any other.

## What Claude reads

```
test-gate: You edited 2 files (parser.ts, lexer.ts) this turn and ran no test or check. Run the relevant tests or checks (for example `npm test`), or say in one line why they are not needed, then finish. Why: parser logic changed.
```

The example command and the reason come from the model. Claude decides what to run.

## Settings

Set on the screen the install shows, and afterwards in `/config`.

| Setting | Default | What it does |
| --- | --- | --- |
| Test gate (`enabled`) | on | Off: turns end as they always do. |
| Model (`model`) | `claude-haiku-5-5` | The model asked whether the edits need a test run: an alias or a full model id. |
| Model timeout (`timeoutSeconds`) | `10` | The call is given up after this long, and the code-only rule decides. 2 to 60. |
| Test and check commands (`testPatterns`) | see below | Bash commands that count as a test or check run, separated by commas. Empty: the defaults. |

A command counts when it, or a part of it after `&&`, `;` or `|`, starts with one of the patterns. Runners in front are skipped, with their flags: `npx`, `npx --yes`, `bunx`, `sudo`, `uv run`, `poetry run`, `bundle exec`, `python -m`, `timeout 60`, `VAR=value`. So `cd pkg && npx tsc --noEmit` and `python -m pytest -q` both count.

The defaults:

| Ecosystem | Patterns |
| --- | --- |
| JavaScript | `npm test`, `npm t`, `npm run check`, `npm run lint`, `npm run typecheck`, `npm run type-check`, `deno test`, `node --test`, `vitest`, `jest`, `mocha`, `playwright test`, `tsc`, `eslint` |
| Python | `pytest`, `tox`, `nox`, `mypy`, `ruff check`, `unittest` |
| Rust, Go | `cargo test`, `cargo check`, `cargo clippy`, `cargo nextest`, `go test`, `go vet` |
| Make, JVM, .NET | `make test`, `make check`, `make lint`, `mvn test`, `mvn verify`, `gradle test`, `./gradlew test`, `dotnet test` |
| Others | `mix test`, `rspec`, `rake test`, `phpunit`, `swift test`, `claude plugin test`, `claude plugin validate` |

A package manager pattern covers the same script under npm, pnpm, yarn and bun, with or without `run`: `npm run lint` also matches `pnpm lint`, `yarn lint` and `bun run lint`, and `npm test` matches `npm run test:unit`. Options that pick a folder or workspace are skipped (`pnpm -C pkg test`, `npm --prefix pkg test`, `yarn workspace x test`, `pnpm --filter web lint`), and so is the package manager in front of a tool (`pnpm vitest run`, `yarn jest`). The string of `bash -c "..."` is read as a command, and so is a part in parentheses (`cd a && (npm test)`).

Not counted: a part that only asks for `--version` or `--help`, and text inside quotes or a heredoc, such as a `git commit -m "..."` message that mentions `npm test`.

## How it works

- **What it tracks.** In each turn of the main loop: the files Claude edited with Edit, Write or NotebookEdit (calls that succeeded), and whether it ran a Bash command that matches a pattern. A test run that fails is still a run.
- **When the turn ends.** If no file was edited, or a test ran, nothing happens. Otherwise the model gets the edited paths, a short summary of each edit, your prompt and Claude's last message, and answers `ANSWER: yes` or `no`, a one-line reason and a suggested command. Docs-only and config-only edits are meant to get a no.
- **How the turn goes on.** The mod answers Claude Code's Stop event with a block, as a Stop hook that blocks does. Claude reads the note and carries on in the same turn.
- **Once per turn.** After one nudge the turn always ends. A Stop that comes after any Stop hook blocked (`stop_hook_active`) is let through, so the mod never blocks a turn more than once, even with other Stop hooks about. When the model says no, it is asked again in the same turn only if more files were edited since.
- **When you say not to test.** A prompt that says "don't run tests", "no tests", "skip the tests", "without testing" and the like is never nudged, and the model is not asked.
- **When the model fails.** If the call fails, times out, or the reply is not a yes or a no, a code-only rule decides: if any edited file is code, the turn goes on once with the same note, without a reason. Docs, config and data files (`.md`, `.json`, `.yaml`, `.toml`, `LICENSE`, images and the like) are not code.
- **Who counts.** Only Claude's own tool calls in the main loop. A subagent's edits and test runs, and tool calls made by other plugins, are left out. A subagent's end is never blocked.

## Limits

- The prompt check is a plain pattern match. "There are no tests for this" also reads as "no tests".
- A test run through a script the patterns do not know (`./run-checks.sh`) does not count. Add it to the patterns.
- If Claude ran the tests in a subagent, the main loop still counts as untested.
- File edits made through Bash (`sed -i`, `printf >> file`, a heredoc into a file) are not tracked. Only Edit, Write and NotebookEdit count as edits.
- If another Stop hook blocks first, the turn goes on for that hook, and this mod does not nudge in that turn.

## Development

```
claude plugin validate .
claude plugin test .
```

`hooks/register.ts` is the hooks module: it tracks the turn, asks the model and blocks the Stop. `hooks/gate.ts` holds the logic, free of the engine: settings, test patterns, what counts as code, the question, how the reply is read, and the note.
