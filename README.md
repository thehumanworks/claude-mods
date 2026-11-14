# claude-mods

Mods for Claude Code.

| Mod | What it does |
| --- | --- |
| [turn-stats](./turn-stats) | Per-turn usage stats under the last message: tok/s, input/output tokens, cache hit %, total and duration |

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install turn-stats --marketplace thehumanworks/claude-mods
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).

From a shell:

```
claude plugin install turn-stats --marketplace thehumanworks/claude-mods
```

In the desktop app: click **+** next to the prompt box → **Plugins** → **Add marketplace** with `thehumanworks/claude-mods`, then **Add plugin**.
