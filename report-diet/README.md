# report-diet

Keeps long subagent reports out of the parent's context.

Each subagent's final answer goes into the context of the agent that started it, whole. One orchestrator session took in 21 reports totalling 129,000 characters (about 32,000 tokens) and had to compact. With this mod, when a subagent is about to hand back an answer longer than `maxChars`, its stop is held once with a note. The note asks it to:

1. write the full report to `subagent-<agent id>-full.md`, in its scratchpad directory if it has one, otherwise in the system temp directory;
2. reply with a summary of at most `summaryChars` characters that starts with the conclusion and ends with the file's absolute path.

The parent gets the summary, and can read the file when it needs the detail. No model is called: the mod only measures the answer.

## Install

```
/plugin install report-diet --marketplace thehumanworks/claude-mods
```

From a checkout, for one session: `claude --plugin-dir ./report-diet`.

## Rules

- It uses the `SubagentStop` hook (`classic.SubagentStop`), which sees the subagent's last message and can hold the stop. `turn.complete` sees the answer too, but cannot hold anything.
- Each subagent is held at most once. If its second answer is still long, it goes through.
- The main loop's Stop is never hooked.
- An answer that is an API error or an interruption is never held, nor is a stop the person interrupted. A stop that another hook already holds, or that follows a hold, is let through.
- The file name never starts with `report`: Claude Code's Write tool refuses a subagent's `.md` file whose name starts with REPORT, SUMMARY, FINDINGS or ANALYSIS.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `enabled` | `true` | Off: no hook at all. |
| `maxChars` | `2000` | An answer longer than this is held once. 200 to 100,000. |
| `summaryChars` | `1500` | The longest summary asked for. 100 to 100,000, and no more than `maxChars`. |
| `exclude` | `Explore, Plan` | Subagent types never held, separated by commas, any case. Empty: none. |

`Explore` and `Plan` are skipped by default because they are read-only: they have no Write tool, so they could not write the file. What they find is also meant to be read in full by the agent that asked.

A value out of range keeps its default, and the problem is logged when the session starts.
