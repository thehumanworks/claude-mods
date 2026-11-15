# context-gauge

How full the context is, for you and for Claude.

Claude cannot see how full its context is. This mod shows it on the status line, and tells Claude in one short note when the context passes a band (50, 75 and 90% by default). Claude can then plan: finish a step, save notes, or avoid reading huge files before compaction.

It makes no model calls and talks to no endpoint.

## Install

```
/plugin install context-gauge --marketplace thehumanworks/claude-mods
```

Answer `y` to add the marketplace, then pick a scope. From a checkout, for one session: `claude --plugin-dir ./context-gauge`.

## What you see

A status line under the prompt:

```
ctx 134k/267k · 50%
```

That is the context used, Claude Code's auto-compact limit, and the share of the limit used, rounded down. Before the first response of a window (a new session, or just after a compaction) the size is not known yet and the line reads `ctx –/267k`. With auto-compact off, the limit is the window and the line ends `· auto-compact off`.

The limit is not the auto-compact window. The window is what `/autocompact` or `autoCompactWindow` sets, and Claude Code compacts some way below it. The mod reads both numbers from Claude Code each time it measures, as [async-compaction](../async-compaction) does, `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` included. So a `/autocompact` change applies at once.

Each mod has a status line of its own, beside the others, so this one does not replace another mod's.

## What Claude sees

When the context passes a band, Claude's next request carries one note, for example:

```
[context-gauge] Context past 75%: 201,000 tokens used of 267,000, where Claude Code compacts automatically. Finish the current step before starting a new one, and keep decisions and next steps in a notes file or the todo list, where they survive compaction.
```

| Band | Suggestion |
| --- | --- |
| under 70 | There is room left, but read large files in parts rather than whole. |
| 70 to 89 | Finish the current step, and keep decisions and next steps where they survive compaction. |
| 90 and up | Compaction is close: finish or checkpoint the step now, write down what is needed afterwards, avoid large reads. |

- **When.** The size is the one the last response reported. It is checked after each tool call in a turn (once per response, however many calls it made in parallel) and when you send a prompt. The note goes after that tool's result, or beside your prompt.
- **Once per band.** A band is told once between compactions. If one step passes several bands, Claude gets one note, for the highest; the lower ones are not told after.
- **After a compaction** the bands start over. A summary written ahead of time (`precompute`) or a compaction that was skipped resets nothing. A compaction another mod answers, such as async-compaction's, resets them too.
- **Subagents are skipped.** Their tool calls carry no note and use up no band. The figure Claude Code reports is the main conversation's.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| Bands (`bands`) | `50, 75, 90` | Percentages of the auto-compact limit at which Claude is told. Whole numbers from 1 to 99, separated by commas. `off`: the status line only. A value that cannot be used is left out and logged at start. |

## Limits

- The mod keeps its state in memory. After a restart or a resume, a band already told can be told once more.
- A rewind lowers the context without a compaction, so the bands told before it stay told until the next compaction.
- Inside a turn the check runs at tool calls. A turn that grows the context with no tool call (one long answer) is caught at your next prompt.
- `/autocompact` and the auto-compact toggle redraw the line at once. A change to `autoCompactWindow` in a settings file shows at the next measurement.

## Development

```
claude plugin validate .
claude plugin test .
```

`hooks/register.ts` is the hooks module; `hooks/gauge.ts` holds the logic, free of the engine, so the tests cover it.
