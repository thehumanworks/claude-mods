# claude-mods

Mods for Claude Code.

| Mod | What it does |
| --- | --- |
| [turn-stats](./turn-stats) | Per-turn usage stats under the last message: tok/s, input/output tokens, cache hit %, total and duration |
| [async-compaction](./async-compaction) | Background compaction: a cheap model summarizes the conversation ahead of time, and at the compaction limit the summary is swapped in with the latest messages kept raw |
| [loop-breaker](./loop-breaker) | Notices when Claude repeats the same failing tool call and tells it to stop retrying and change approach |
| [context-gauge](./context-gauge) | Context used against the auto-compact limit on the status line, and a short note to Claude when it passes 50, 75 and 90% |

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
