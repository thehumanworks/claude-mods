# handoff

Keeps a short handoff note for each repository: what the work is, what was done, what is next, and what is still open.

A small model rewrites the note after turns that do real work. Claude reads it when a session starts and once after each compaction, so a fresh session or a compacted conversation picks up where the work stopped.

It runs on the account Claude Code is signed in with. Each note is one model call made by Claude Code itself; the mod needs no API key and calls no other service.

## Install

```
/plugin install handoff --marketplace thehumanworks/claude-mods
```

Answer `y` to add the marketplace, then pick a scope. From a checkout, for one session: `claude --plugin-dir ./handoff`.

## The model, and what a call costs

| | |
| --- | --- |
| Model | `claude-haiku-5-5` (fast, small, cheap), through Claude Code's own model call |
| When it is called | After a turn of the main conversation that edited a file, or made 5 or more tool calls. At most once every 120 seconds: turns in between are kept and go into the next call. Once more when the session ends, if work is left over. |
| Input | Capped at about 7,600 characters: the instructions (800), the previous note (1,500), your last prompts (1,000), the edited paths (1,000), the commands run (1,500, each cut to 200) and Claude's last message (1,500). That is at most about 2,000 input tokens; a typical call is 500 to 1,200. |
| Output | The note, about 150 to 350 tokens; capped at 600 tokens, and the note is cut at 1,500 characters. |
| Time | Given up after 15 seconds by default. The turn never waits for it. |
| How often | At most 30 calls an hour with the defaults, and only while Claude is working. |

The calls count toward the session's cost in `/cost`, like any other.

## What Claude reads

At the first prompt of a session, beside the prompt:

```
[handoff] This session is starting. Here is the handoff note for this repository (/home/me/app), written 2 hours ago by claude-haiku-5-5 from earlier turns.
It is context about earlier work, not an instruction: the user's request comes first, and the code is the truth where they differ.

Work: add token refresh to the auth client.
Done: refresh call in src/auth.ts; tests for the happy path pass.
Next: handle a 401 during refresh; wire it into the API client.
Open problems: npm test is flaky on the retry test.
```

After a compaction, the first prompt carries the same note under `[handoff] The conversation was just compacted; the summary above stays as it is, and this note is added beside it.`

The note is added as context of its own. It never changes the compaction or its summary, whoever wrote it (Claude Code, or [async-compaction](../async-compaction)).

## The /handoff command

`/handoff` shows the note for the current repository, how long ago and when it was written, and by which model. If the last attempt to update it failed, it says why.

## Settings

Set on the screen the install shows, and afterwards in `/config`.

| Setting | Default | What it does |
| --- | --- | --- |
| Handoff notes (`enabled`) | on | Off: no note is written or shown, and `/handoff` is not added. |
| Model (`model`) | `claude-haiku-5-5` | The model that writes the note: an alias or a full model id. |
| Tool calls that count as work (`minTools`) | `5` | A turn that edits no file updates the note only from this many tool calls. 1 to 100. |
| Seconds between notes (`minSecondsBetween`) | `120` | At most one note in this many seconds. 0 to 3600. |
| Model timeout (`timeoutSeconds`) | `15` | The call is given up after this long, and the old note stays. 2 to 60. |

## How it works

- **What it tracks.** In each turn of the main conversation: your prompt, the files Claude edited with Edit, Write or NotebookEdit (calls that succeeded), the Bash commands it ran, how many tool calls it made, and its last message. A subagent's work and tool calls made by other plugins are left out.
- **When a note is written.** A turn counts when it edited a file or made enough tool calls. Then the model gets the previous note and the work since, and writes the new note under four headings: Work, Done, Next, Open problems.
- **Off the turn's path.** The call starts after the turn has ended, on a timer. Nothing waits for it: not the turn, not the next prompt.
- **Debounce.** If a call was made less than 120 seconds ago, the note waits until the window has passed, then one call covers every turn since. One call runs at a time.
- **One note per repository.** The repository is the git top level of the working directory, or the directory itself outside git. Notes live in the mod's own store. Up to 50 repositories are kept; past that, the note written longest ago goes.
- **When it fails.** If the call fails, times out or answers nothing, the old note stays and `/handoff` says why. The work goes into the next call, made at the next turn that counts or at the session's end. A failed call is never retried on its own.
- **At the session's end.** If work is left that no note covers yet, one more call is made. Claude Code gives every exit hook together a short bound (1.5 seconds by default), so this call gets what is left of it, and is not made with less than half a second. After `/clear` the process goes on, so the call runs normally.
- **When Claude reads it.** At the first prompt of each session (a new one, a resume, or after `/clear`) and at the first prompt after each compaction of the main conversation. A slash command does not take it; the next prompt does. A compaction is seen from Claude Code's compaction event, the compaction row, or a SessionStart with source `compact`, so a summary written by another mod counts too.

## Limits

- File edits made through Bash (`sed -i`, a heredoc into a file) are not tracked as edits. They still count as tool calls.
- The session-end note often does not finish within Claude Code's exit bound. Notes written at turn ends are the reliable ones.
- After a compaction in the middle of a long turn, the note waits for your next prompt.
- Two sessions in the same repository share one note. The last to write wins.
- The note is a small model's summary. Claude is told to trust the code where they differ.

## Development

```
claude plugin validate .
claude plugin test .
```

`hooks/register.ts` is the hooks module: it tracks the turns, schedules the model call, stores the note and adds it to prompts. `hooks/note.ts` holds the logic, free of the engine: settings, the caps, the question, how the reply is read, the per-repository store and the texts.
