# report-diet

Keeps long subagent reports from filling the parent's context.

Each subagent's report goes into the context of the agent that started it, whole. In one orchestrator session, 21 reports came to 129,000 characters (about 32,000 tokens), and the session had to compact. With this mod, a report longer than `maxChars` is saved whole to a file, and the parent reads three parts:

1. the first `headChars` characters (reports usually lead with the conclusion);
2. a marker: `[report-diet: N of M characters cut here. The whole report is in <path>; Read it if you need the part cut out.]`
3. the last `tailChars` characters (often the file list or next steps).

No model is called, and the subagent is never asked to do anything differently.

## What Claude loses, and how to get it back

Claude does not see the middle of a long report. If it needs that part, it reads the file named in the marker with the Read tool. The file holds the whole report, under a one-line comment that names the subagent type and the task.

## Where the files go

They go in `claude-report-diet/` in the system temp folder (`$TMPDIR`, else `/tmp`; `%TEMP%` on Windows). That folder is outside the repository, so nothing is committed by accident. Each file is named after the Agent call's `tool_use_id`: `agent-<tool_use_id>.md`. Files older than 7 days, and any past the newest 200, are removed at most once an hour. Only files with that name pattern are removed. If the folder is a symbolic link, nothing is saved.

## What is cut, and what is left whole

- **Cut:** the result of the model's own Agent call (also named `Task`), and the `<result>` of a background agent's `<task-notification>` for a call the mod saw launched. Background is the default for agents, so both paths matter.
- **Left whole:**
  - a report of `maxChars` or less;
  - an error result;
  - a notification whose status is not `completed`;
  - a subagent type in `exclude`;
  - a call another plugin made;
  - any report the mod could not save. On any failure, the result goes through unchanged.

## Why it no longer asks subagents to write files

An earlier version held the subagent's stop and asked it to write its report to a file. That design was dropped. Claude Code deliberately blocks a subagent from writing report `.md` files ("Subagents should return findings as text, not write report files"), and the subagent's system prompt says the same. Working around that would override a product decision. This version works only on the parent's side, after the report has been handed back.

## Install

```
/plugin install report-diet --marketplace thehumanworks/claude-mods
```

From a checkout, for one session: `claude --plugin-dir ./report-diet`.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `enabled` | `true` | Off: no hook at all. |
| `maxChars` | `4000` | A report longer than this is cut. 1,000 to 100,000. |
| `headChars` | `2500` | Characters of the start kept. |
| `tailChars` | `800` | Characters of the end kept; 0 keeps none. |
| `exclude` | `Explore, Plan` | Subagent types never cut, separated by commas, any case. Empty: none. |

Why 4,000: in the session above, reports averaged 6,000 characters and reached 8,800 at most. With this limit, most of them are cut, while short answers are never touched. A cut report comes to about 3,500 characters, roughly half an average report. If `headChars` plus `tailChars` is more than 90% of `maxChars`, both are scaled down to 60% and 20% of it. A value out of range keeps its default, and the problem is logged when the session starts.

`Explore` and `Plan` are left whole because their answers (search results and plans) are meant to be read in full by the agent that asked.
