# loop-breaker

Stops Claude from running the same failing tool call again and again.

Sometimes Claude retries a command that keeps failing, unchanged, several times. With this mod, when the same call has failed 3 times in a row, Claude reads a short note right after the failing result: which call keeps failing, its last error, and that it should stop retrying and change approach or ask you. You see a toast at the same moment.

No model calls, no network. Everything is counted in memory.

## Install

```
/plugin install loop-breaker --marketplace thehumanworks/claude-mods
```

Answer `y` to add the marketplace, then pick a scope. From a checkout, for one session: `claude --plugin-dir ./loop-breaker`.

## Settings

Set on the screen the install shows, and afterwards in `/config`.

| Setting | Default | What it does |
| --- | --- | --- |
| Failures before the note (`threshold`) | `3` | How many times in a row the same call may fail before Claude gets the note. 2 to 20. A value outside that keeps 3, and says so in the log. |

## How it works

| Question | Answer |
| --- | --- |
| What is a failure | A tool result marked as an error (`isError`). Bash reports a non-zero exit code this way, so a failing command counts. A call a permission rule or a hook refused never ran, so it does not count. |
| What is the same call | The same tool with the same input, whitespace collapsed and key order ignored. For Bash only the command counts: `npm  test` and `npm test` are one call, a different description or timeout does not make another. |
| When the count goes up | At each failure of that call. Failures of other calls in between do not reset it. |
| When the count resets | At any success in the same loop, of that call or of a different one. Claude did something that worked, so the next run of the failing call is a fresh try. |
| When the note comes | Once, at the failure that reaches the threshold. Later failures of the same call add nothing until its count has reset. |
| Subagents | Each subagent (and teammate) is counted on its own, apart from the main conversation. A success in one does not reset another. |

The note is attached to the failing result as context the model reads after it, so it is in Claude's very next request. You do not see it in the transcript; the toast tells you it was sent. It reads like this:

```
loop-breaker: The Bash command `npm run build` has now failed 3 times in a row. Last error: Exit code 1 error TS2304: Cannot find name 'foo'.
Do not run it again as it is. Work out why it fails and change approach (another command, other input, or a different way to the goal), or ask the user how to proceed.
```

The last error is quoted with its whitespace collapsed, up to 300 characters.

## Limits

- The counts live in memory: a restart or a resumed session starts from zero.
- A loop where Claude changes the command a little each time (another flag, another path) is not caught: those are different calls.
- A loop where a successful call sits between each retry (run the build, read a file, run the build) is not caught either: the success resets the count.
- A command that fails but exits 0 is a success to the mod.

## Development

```
claude plugin validate .
claude plugin test .
```

`hooks/register.ts` is the hooks module; `hooks/loops.ts` holds the counting, free of the engine, so the tests cover it directly.
