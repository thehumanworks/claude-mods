# async-compaction

Asynchronous (background) compaction for Claude Code.

Claude Code compacts when the context reaches its auto-compact limit: it stops, writes a summary of the whole conversation with the session's own model, and carries on from that summary. With this mod the summary is written earlier and off to the side:

1. **At the trigger** (75% of the auto-compact limit by default) a cheap model (haiku by default) summarizes the conversation so far, in the background. The session keeps working on its full history.
2. **At the limit**, when Claude Code would compact, the summary that is already written is swapped in for the messages it covers. Everything said after the trigger stays as it was, word for word, after the summary. No summary is written at that moment, so the swap takes no model call.
3. **Afterwards** the summarized messages can still be read back: the summary cites them by id (`[m412]`) and Claude has a `recall` tool for the cases where the summary is not enough.

It runs on the account Claude Code is signed in with (a Claude subscription included). The summary is one more model call made by Claude Code itself; the mod needs no API key.

## Install

```
/plugin install async-compaction --marketplace thehumanworks/claude-mods
```

Answer `y` to add the marketplace, then pick a scope. From a checkout, for one session: `claude --plugin-dir ./async-compaction`. Loaded that way, the options are read from `pluginConfigs["async-compaction@inline"].options` in your user settings or a `--settings` file (a project's settings file is not read for them), and `/config` lists them too.

`/async-compaction` shows the settings in force, where the trigger and the limit are for this session, whether a summary is ready, and how much can be recalled.

## Settings

Set on the screen the install shows, and afterwards in `/config`.

| Setting | Default | What it does |
| --- | --- | --- |
| Compaction model (`model`) | `haiku` | The model that writes the summary: an alias (`haiku`, `sonnet`, `opus`) or a full model id. |
| Background trigger (`triggerAt`) | `75` | The summary starts once the context reaches this percentage of Claude Code's auto-compact limit. 10 to 95: a value at or past 100 is refused, since the summary would then start only when Claude Code is already compacting. |
| Compaction level (`level`) | `balanced` | `aggressive`, `balanced` or `soft`: see below. |
| Compaction prompt (`prompt`) | built-in | Replaces the instructions the compaction model follows: what to keep and how to lay it out. The level's length limit and the citation rules are added after it, so a custom prompt keeps both. |
| Compaction prompt file (`promptFile`) | none | A file whose text is the compaction prompt; wins over `prompt`. The built-in prompt, to start from, is `DEFAULT_PROMPT` in [`hooks/prompts.ts`](./hooks/prompts.ts). |
| Recall tool (`recall`) | on | Keep the summarized messages on disk, have the summary cite them, and give Claude the `recall` tool. Off: the summary has no ids and points to the transcript file instead. |
| Async compaction (`enabled`) | on | Off: Claude Code compacts as it always does. |

### The three levels

| Level | Summary length asked for | Raw context kept | Each tool input and output read by the compaction model, up to | The user's own messages quoted after the summary |
| --- | --- | --- | --- | --- |
| `aggressive` | 500 words | what came after the trigger | 1,000 characters | 300 characters each, 2,000 in all |
| `balanced` | 1,200 words | what came after the trigger | 1,500 characters | 800 each, 6,000 in all |
| `soft` | 2,500 words | what came after the trigger, and 15% of the limit from before it | 2,500 characters | 2,000 each, 16,000 in all |

The lengths are what the compaction model is asked for, not caps: haiku wrote about 780 words every time it was asked for 500 (see the evals). The user's prompts are quoted by code, not by the model, so their wording survives whatever the summary does with it.

## How it works

- **When the summary starts.** The context is measured at the end of each turn and, inside a turn, at tool calls (at most every ten seconds), so one long autonomous turn is covered too. A resumed session that is already past the trigger starts at once.
- **What is summarized.** Everything up to the latest point where the conversation can be cut cleanly: before a prompt of the user's, or before a reply with no tool call still waiting for its result. A call and its result always fall on the same side of the cut, and a reply's rows stay together.
- **The swap.** At compaction the mod checks that every message the summary covers is still there, hands Claude Code the summary followed by the later messages as they are, and nothing else. If one of Claude's replies ran across the cut (parallel tool calls whose results came in between), that whole reply stays raw as well.
- **A summary that has grown old.** If the conversation goes on for long after the summary (what was said since comes to half the limit), the summary is written again, so the raw part never outgrows it.
- **The next compaction** folds the earlier summary in, and the message ids carry on from where they stopped.
- **`/compact`** uses the ready summary when there is one. `/compact <what to stress>` always writes a new one, with that focus.
- **Long conversations.** More than about 125,000 tokens of rendered conversation is summarized in parts, four at a time, and the part summaries are merged.

### When there is no summary to swap in

The mod never leaves a session without compaction:

| What happened | What the mod does |
| --- | --- |
| The limit is reached while the summary is still being written | waits up to 8 seconds for it; after that it writes one then |
| No summary is ready (the context jumped past trigger and limit in one step, the conversation was rewound, or `/compact <text>`) | writes the summary at that moment with the compaction model, keeping raw what a summary started on time would have |
| The compaction model fails, times out, is cut off at its token cap, or answers with something that is not a summary (a refusal, or a reply that carries on the conversation), twice | leaves this compaction to Claude Code |
| Two background summaries in a row did not finish | stops starting them for this session until the next compaction |
| A subagent compacts | left to Claude Code |

Claude Code's own ahead-of-time summary is skipped while the mod is on: it would be paid for and never used.

## The recall tool

This was a proposal to research and then approve or reject. **Approved, on by default**: in the eval below, details the summary had dropped were answered right 90% of the time with the tool and never without it, and the agent reached for it on 7% of the questions its context already answered.

What is summarized is written, word for word, to `~/.claude/async-compaction/<session id>/`. Each line the compaction model reads opens with its message's id, and the summary cites the ids its statements rest on. The tool (`mcp__async-compaction__recall`) reads them back:

- `ref: "m412"` returns that message, `"m412-m420"` a range, and `around: 2` adds its neighbours.
- `query: "words"` searches everything summarized and lists the messages that hold all the words.

Both the tool's description and the summary message tell Claude to work from the summary and recall only when the task depends on an exact detail the summary does not give. Ids the compaction model made up are removed from the summary before it is used.

How it was tested ([`evals/LOG.md`](./evals/LOG.md), section 13): three real sessions compacted by the mod, the source files then deleted, and 36 questions put to each session as compaction left it, once with the tool and once without, every other way back to the files switched off.

| Where the answer is | Right with the tool | Recalled | Right without the tool |
| --- | --- | --- | --- |
| in the summary | 29/29 | 1/29 | 29/29 |
| in the messages kept raw | 17/17 | 2/17 | 17/17 |
| only in the archive | 55/61 | 55/61 | 0/62 |
| nowhere (never said) | 8/9 | 8/9 | 9/9 |

Every recall of a dropped detail found it, in 1.7 calls on average. The 6 misses are answers where the agent tried to re-read the file instead, found that switched off, and stopped. Without the tool it did not guess: it said it could not tell. One model and three sessions of one shape: this shows the tool works and is not overused, not how often real work needs it.

## How this follows Anthropic's background compaction

The design reference is [Compact in the background](https://platform.claude.com/docs/en/build-with-claude/compaction-background), which describes the same loop for the API: note which messages the compaction request held, keep working on the full history, swap the summary in over exactly those messages, keep everything appended since, and keep the full history if the request fails. The mod does each of those. Where it differs, and why:

| The doc | The mod | Why |
| --- | --- | --- |
| The swap happens when the summary arrives | The swap happens at Claude Code's compaction limit | It is what was asked for: the session keeps its full, raw history for as long as it fits. It also keeps the prompt cache intact until a compaction would have broken it anyway. |
| The API writes the compaction block, with the request's own model | Claude Code writes a plain summary, with any model | A cheaper model can write it. The summary is an ordinary message, so nothing is tied to one model or one API. |
| Custom `instructions` replace the default prompt entirely | The custom prompt replaces the instructions; the length limit and the citation rules are always added | The levels and the recall tool keep working under a custom prompt. |
| One compaction at a time | The same, and a ready summary is written again once the raw part would pass half the limit | A session that runs on for long after the trigger would otherwise swap in a stale summary with too little room left. |
| Thinking in kept turns must be dropped when the summary is written by the client | Nothing extra: kept messages are handed back to Claude Code as it has them | Checked in a Mythos 5.2 session: a kept turn with a thinking block, a request after the swap, no API error, and the right answer at the end. |

Images and documents in summarized messages are lost, as in the doc: the summary is text.

## Evals

The compaction prompt was chosen by measurement, with haiku as both the compaction model and the model that answers the questions. [`evals/LOG.md`](./evals/LOG.md) is the full record, in the order things were run; the short version:

- **Method.** Synthetic conversations (no real transcripts) with facts planted in them: goals, instructions, decisions, values, identifiers, the current state, things superseded or rejected. The mod's own code writes the summary; a second call sees only the summary message and answers questions about the facts; regexes grade the answers. Controls: with the whole conversation in context every question is answered, with an empty summary none.
- **What was climbed.** Single-task conversations do not tell prompts apart (97.8% for the first prompt). Sessions of three tasks in one conversation do: the first prompt kept 82% of the facts at the balanced level and 73% at aggressive.
- **Result, in two steps**, each on a held-out session and on the facts the quoted user messages do not already hold. The rule for accepting a change was written down before the variants were run.
  1. One section per task and notes with exact tokens in place of prose, against the first prompt, at balanced and aggressive: **79.7% against 72.4%, +7.3 points (90% interval 2.9 to 11.1)**. With the quotes counted, +4.0 (2.1 to 6.1).
  2. One more sentence, saying what to put back when the level leaves room, against step 1 at soft: **97.1% against 84.8%, +12.4 points (3.8 to 22.9)**. At balanced and aggressive it changes nothing that can be measured (+0.3, -2.9 to 3.8). This is the default prompt.
- **Tried and not adopted**: a second pass to hold the aggressive word limit, three wordings asking for exact details out of tool output, a merge request that restates the length limit, and the summarization instruction from Anthropic's prompting guide (within noise of the default, written in half the time, weaker on values and decisions).
- **What the prompt does not fix.** Exact values and identifiers that only a tool's output showed are what a summary loses most (60 to 70% kept at balanced). That is what the recall tool is for.

The default prompt at each level, five summaries each, on the held-out session:

| Level | Facts kept (the prompt's own probes) | Words written | Limit |
| --- | --- | --- | --- |
| `aggressive` | 82.4% | 784 | 500 |
| `balanced` | 78.2% | 946 | 1,200 |
| `soft` | 97.1% | 1,505 | 2,500 |

Aggressive runs over its limit every time, and scores above balanced on this session; on the session the prompt was developed on the order is the expected one (83.1%, 91.1%, 96.7%, in 737, 1,123 and 1,457 words). Read the levels as short, medium and long, not as exact sizes.

Two more things measured, at balanced, with the prompt of step 1:

- **The ids cost time, not facts.** A summary that cites its messages takes about twice as long to write (41 s against 21 s) and scores within noise of one that does not (93.3% against 95.5%). The time is spent in the background.
- **A summary merged from parts loses nothing** (96.1% against 93.3% in one pass), but is about 37% longer than the level asks and takes three times as long to write.

To run them (they use `claude -p --model haiku` on the signed-in account; summaries and answers are cached under `evals/.cache/`):

```
bun evals/run.ts controls
bun evals/run.ts summary --name mine --variants baseline,default --fixtures long-dev --levels balanced,aggressive --reps 5
bun evals/run.ts report mine --against baseline
bun evals/recall.ts make && bun evals/recall.ts probe && bun evals/recall.ts report
```

A prompt of your own goes in [`evals/variants.ts`](./evals/variants.ts) next to the others.

## Limits

- Summarized messages accumulate under `~/.claude/async-compaction/`, one folder per session. The mod keeps the index of the 200 most recent sessions and does not delete the files.
- A session forked from another cannot recall what its parent summarized: the archive belongs to the session that wrote it. Its own ids start after the parent's.
- A reply that ran across the summary's cut is both summarized and kept raw, and is archived again, under new ids, at the next compaction.
- A plugin can read the newest 4,096 messages of a session. Past that, with no earlier summary among them, the summary is written at compaction instead of ahead of it.
- A low trigger costs more: the summary covers less, more stays raw after the swap, and the next compaction comes sooner.
- The summary starts only once Claude Code has reported a context size at or past the trigger, so a first prompt that fills the window in one step is compacted without a summary written ahead.
- Now and then haiku answers the request instead of carrying it out. Through `claude -p`, as the evals call it, it refused 2 of 20 summaries in one cell; through Claude Code's model call, as the mod calls it, one reply in about fifty was not a summary. The mod asks again, and after two such replies leaves the compaction to Claude Code.
- A conversation long enough to be summarized in parts gets a summary about a third longer than its level asks.
- With little room between the trigger and the limit (a small auto-compact window, or a trigger above 90), the limit can arrive before the summary is done. Compaction then waits for it, up to 8 seconds, or writes it on the spot.
- `soft` with a low trigger keeps a lot raw: 15% of the limit from before the trigger and everything after it. In a small window that leaves a swap little to free, and compaction comes round again soon (five compactions against two in a 48,000-token test session with the trigger at 60).
- The recall eval starts real sessions, and their transcripts stay under `~/.claude/projects/`.

## Development

```
claude plugin validate .
claude plugin test .
```

`hooks/register.ts` is the hooks module; `transcript.ts`, `summary.ts`, `prompts.ts`, `archive.ts` and `config.ts` hold the logic, free of the engine, so the tests and the evals run the same code.
