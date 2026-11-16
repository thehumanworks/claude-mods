# efficiency

Finds where Claude Code sessions in a repository waste context or calls, and tells you the exact setting that fixes each.

The mod keeps a small record of every session in the repository: which MCP servers (connections to external tools, claude.ai connectors among them) loaded their tools and which of those tools Claude called, which calls failed or exactly repeated an earlier one, which results were large, and how often the conversation was compacted. `/efficiency` turns that into a ranked list. Each entry names the settings file and key to change, or says plainly that no setting fixes it.

One session that prompted this mod listed about 360 MCP tool names from 5 connectors and called 2 of them.

It runs on the account Claude Code is signed in with. The optional recommendation step is one model call made by Claude Code itself; the mod needs no API key and calls no other service.

## Install

```
/plugin install efficiency --marketplace thehumanworks/claude-mods
```

Answer `y` to add the marketplace, then pick a scope. From a checkout, for one session: `claude --plugin-dir ./efficiency`.

## The /efficiency command

```
efficiency for /home/me/app: 7 sessions in the window (the latest 20 are kept; 9 seen in all).
Findings, the ones with an exact settings fix first, then by estimated tokens (est. ≈ characters / 4). Settings paths are relative to /home/me/app; .claude/settings.local.json is personal and not checked in (.claude/settings.json takes the same keys for everyone).

1. claude.ai connectors: 3 loaded (Gmail, Google_Drive, Slack), none called in 7 sessions (~9,800 est. tokens of tool names in all)
   Fix: in .claude/settings.local.json, set "disableClaudeAiConnectors": true. claude.ai connectors are then not fetched or connected in this project.
   Or deny only some: add "mcp__<server>" to "permissions"."deny" there, e.g. "mcp__claude_ai_Gmail".
2. MCP server "github": loaded in 7 of 7 sessions (40 tools, ~170 est. tokens of tool names each), called 0 times
   Fix: in .claude/settings.local.json, add "mcp__github" to "permissions"."deny". Its tools leave Claude's tool list in this project; the server itself still starts.
   Or stop it in this project: run /mcp disable github (Claude Code keeps that under "disabledMcpServers" in this project's entry of ~/.claude.json; /mcp enable github undoes it).
3. Tool "Bash": 5 results of 20,000+ characters in 3 sessions (~31,000 est. tokens)
   Fix: in .claude/settings.local.json, set "bashOutputMaxChars": 10000 (default 30000; 4000 to 128000). Output past it is saved to a file, and Claude gets a preview and the path.
4. Tool "Bash": 12 of 140 calls failed or were refused, in 6 sessions (~2,100 est. tokens of error text)
   No exact settings fix: the calls themselves fail.

Recommendations from opus, drawn only from the fixes above:
1. Turn off the claude.ai connectors you never use here [1] ...
```

The list comes first and is built by code alone. The recommendations follow when the model step is on (below).

### What it finds, and the fix it names

| Finding | When | Fix it names |
| --- | --- | --- |
| claude.ai connectors unused | 2 or more connectors loaded, none called, in 2 or more sessions | `"disableClaudeAiConnectors": true` in `.claude/settings.local.json` |
| MCP server unused | loaded in 2 or more sessions, never called | `"mcp__<server>"` in `"permissions"."deny"` in `.claude/settings.local.json`. To stop the server too: a `.mcp.json` server's name in `"disabledMcpjsonServers"` there; any other, `/mcp disable <name>` (saved as `"disabledMcpServers"` in this project's entry of `~/.claude.json`) when Claude Code told the mod the configured name, else it says it does not know the name |
| MCP server mostly unused | 10 or more of its tools, and at least half, never called | one `"mcp__<server>__<tool>"` rule per uncalled tool in `"permissions"."deny"` |
| Large results | 3 or more results of the threshold (20,000 characters) from one tool | Bash: `"bashOutputMaxChars"`. MCP tools: `"env": { "MAX_MCP_OUTPUT_TOKENS": "…" }`. Other tools: no settings key, said so |
| Failed or refused calls | 3 or more from one tool | none; said so (for an MCP tool, `/mcp` shows whether it is connected and signed in) |
| Exact repeats | 3 or more calls with the same input as an earlier call in the session | none; for repeated failures, the [loop-breaker](../loop-breaker) mod |
| Compactions | 2 or more in the window | none; said so |

Findings with an exact settings fix come first, each group ranked by estimated tokens (characters / 4). At most 10 are shown.

Every key was checked against Claude Code 2.1.325: `permissions.deny` with a server-level rule (`mcp__<server>`, which removes every tool of that server), `disabledMcpjsonServers`, `disableClaudeAiConnectors`, `bashOutputMaxChars` and `MAX_MCP_OUTPUT_TOKENS` are read from settings, and `/mcp disable` writes `disabledMcpServers` in `~/.claude.json`. Server names in tool names are normalized (any character outside `[a-zA-Z0-9_-]` becomes `_`): deny rules use that form, `.mcp.json` and `/mcp disable` the configured name, which the mod only states when it knows it exactly.

## The model, and what a call costs

| | |
| --- | --- |
| Model | `opus` (Claude Opus 5.5 in Claude Code 2.1.325) by default; any alias or full model id in the `model` setting. Called through Claude Code's own model call. |
| When it is called | Only when you run `/efficiency`, at most once per run, and only when there is at least one finding. Never in the background. |
| Input | Capped at 4,000 characters: the instructions (about 770) and the header and findings (the rest, cut at the cap). About 1,000 input tokens at most. |
| Output | At most 5 recommendations, each one or two lines; capped at 600 tokens (thinking included), at low effort. |
| Rough cost | On Opus 5.5 ($4 / $20 per million input / output tokens) at most about $0.02 a run, typically about $0.01. On Haiku 5.5, under $0.001. |
| Time | Given up after 60 seconds by default. |
| On failure | An API error, a timeout, an empty answer, or an answer that names only settings the findings do not: the code-built list is shown alone, with one line saying why. A line of the answer that names a setting the findings do not name is left out. |

The call counts toward the session's cost in `/cost`, like any other.

## What is recorded

Per repository: the git top level of the working directory, or the directory itself outside git. For each session, in the mod's own store:

- the MCP servers whose tools were in the tool list, with how many tools and how many characters their names take, and how many other tools there were;
- Claude's tool calls by tool name (a subagent's included);
- failed or refused calls, exact repeats and large results by tool name, with the characters of what Claude read;
- compactions of the main conversation;
- per repository, the names of each MCP server's tools, and a server's configured name when Claude Code tells it.

Only names, counts and sizes. No prompt, tool input, result or file content is kept; an exact repeat is found by a hash of the input held in memory for the session and never stored. `/efficiency` reads the server names of the repository's `.mcp.json` and nothing else from it.

Caps: the latest 20 sessions per repository (a setting), 25 repositories (past that, the one used longest ago goes), 100 distinct tool names per count in a session (the rest are counted under `(other)`), 50 MCP servers, 200 tool names per server, 120 characters per name.

A session is recorded once it has a turn of its own, after each main-loop turn and at its end. A resumed session keeps its record; after `/clear` the new session gets its own.

## Settings

Set on the screen the install shows, and afterwards in `/config`.

| Setting | Default | What it does |
| --- | --- | --- |
| Efficiency (`enabled`) | on | Off: nothing is recorded and `/efficiency` is not added. |
| Model recommendations (`useModel`) | on | Off: `/efficiency` shows the code-built list alone and makes no model call. |
| Model (`model`) | `opus` | The model `/efficiency` asks: an alias or a full model id. |
| Model timeout (`timeoutSeconds`) | `60` | The call is given up after this long. 5 to 300. |
| Large result (`largeResultChars`) | `20000` | A result of at least this many characters counts as large. 1,000 to 1,000,000. |
| Sessions kept per repository (`windowSessions`) | `20` | The window the findings judge. 2 to 100. |

## How it works

- **Never in the way.** Every hook watches and passes the event on unchanged; a hook that fails is skipped and the event goes on. No turn waits on the mod: the record is written after the turn, off its path. The mod adds nothing to Claude's context.
- **The tool list.** The mod watches the list of tools the engine gives the model (servers that join later too), and reads it once per session after the first turn.
- **The record** is merged into the store per repository, read fresh before each write, so two sessions in one repository do not overwrite each other's sessions.

## Limits

- `/efficiency` prints its report as a command's output. Claude Code keeps a plugin command's output in the conversation, so if you go on in the same session, Claude can read the report.
- Unused MCP tools are counted by their names alone: deferred tools (behind ToolSearch, the default for MCP) cost little more than their names, so the token figures are a floor for servers whose schemas load up front.
- A server's configured name is known only when Claude Code told it in a tool description; otherwise the `/mcp disable` line says the mod does not know it. The deny rule is exact either way.
- A plugin's MCP server is named, but not the plugin, so no key is given to turn the plugin off.
- In a `claude -p` run the record is written at the turn's end and the session's end; Claude Code's short exit bound can cut the last write.
- Two working copies of one repository in different folders are different repositories to the mod.

## Development

```
claude plugin validate .
claude plugin test .
```

`hooks/register.ts` is the hooks module: it watches the tool list, tool calls, turns and compactions, writes the record, and answers `/efficiency`. `hooks/stats.ts` holds the logic, free of the engine: settings, the record and its caps, the findings and their fix text, the question to the model and the check on its answer.
