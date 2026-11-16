# claude-mods

Mods for Claude Code.

<!-- mods:start -->
| Mod | What it does |
| --- | --- |
| [turn-stats](./turn-stats) | Per-turn usage stats under the last message: tok/s, input/output tokens, cache hit %, total and duration |
| [async-compaction](./async-compaction) | Asynchronous (background) compaction: a cheap model summarizes the conversation ahead of time, and at the compaction limit the summary is swapped in with the latest messages kept raw |
| [loop-breaker](./loop-breaker) | Notices when Claude repeats the same failing tool call and tells it to stop retrying and change approach |
| [context-gauge](./context-gauge) | The context's fill against Claude Code's auto-compact limit on the status line, and a short note to Claude when it passes 50, 75 and 90% |
| [edit-check](./edit-check) | After Claude edits files, runs the project's own check command in the background and hands Claude the new errors at its next request |
| [test-gate](./test-gate) | When Claude ends a turn after editing code without running a test or check, claude-haiku-5-5 decides whether it should, and if so the turn goes on once with a note asking Claude to run the tests or say why not |
| [output-shaper](./output-shaper) | When a Bash command prints a lot, Claude reads its first and last lines, the line and character counts, and the path of the whole output with a hint to Grep or Read it |
| [handoff](./handoff) | Keeps a short handoff note per repository (the work, what was done, what is next, open problems), written by claude-haiku-5-5 after turns that do real work, and hands it to Claude at session start and after each compaction |
| [efficiency](./efficiency) | Records per repository, across sessions, where Claude Code wastes context or calls (MCP servers loaded but never called, failed and repeated calls, large results, compactions), and /efficiency ranks it with the exact settings file and key to change; on /efficiency only, opus adds up to 5 recommendations drawn from those fixes |
| [report-diet](./report-diet) | When a subagent's report reaching the agent that started it is long, the whole text is saved to a file in the system temp folder and the parent reads its start, its end and the file's path, so its context stays small |
<!-- mods:end -->

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install turn-stats --marketplace thehumanworks/claude-mods
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session). Any mod in the table installs the same way, by its name.

From a shell:

```
claude plugin install turn-stats --marketplace thehumanworks/claude-mods
```

In the desktop app: click **+** next to the prompt box → **Plugins** → **Add marketplace** with `thehumanworks/claude-mods`, then **Add plugin**.

## Development

CI (`.github/workflows/validate.yml`) runs `claude plugin validate` and `claude plugin test` on every mod listed in `.claude-plugin/marketplace.json`, for pull requests and pushes to main. It needs no secrets. A new mod is covered once it has a marketplace entry; to run the same checks locally use `claude plugin validate ./<mod>` and `claude plugin test ./<mod>`.

## Adding a mod

Create the mod's folder with a `.claude-plugin/plugin.json` that has a `name` and a `description`, then run `node scripts/gen-listings.mjs --write`. It rebuilds the `plugins` array in `.claude-plugin/marketplace.json` and the mod table above from every mod's `plugin.json`. Don't edit the table or the marketplace by hand; CI runs `node scripts/gen-listings.mjs --check` and fails when they are out of date. New mods are listed after the existing ones, by folder name (`mods.order` only pins the original order). Merge mod branches with `scripts/merge-branch.sh <branch>`: when only the marketplace and README conflict, it takes the incoming side, re-runs `--write` and commits. On a GitHub-side conflict in those two files, take either side and re-run `node scripts/gen-listings.mjs --write`. Run `node --test "scripts/*.test.mjs"` for the generator's own tests.

Before merging a mod, run its live evals: `node scripts/live-eval.mjs <mod>` runs real Haiku sessions with the mod loaded and checks what reached the model. They need Claude Code auth from the environment (`CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`, or `ANTHROPIC_API_KEY`), so CI does not run them. See [EVALS.md](./EVALS.md).
