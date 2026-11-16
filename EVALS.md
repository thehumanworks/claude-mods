# Live evals

`scripts/live-eval.mjs` runs a mod for real before it is merged: real `claude -p` sessions in a throwaway git repository, with the mod loaded from its folder, then checks on what reached the model. It replaces the setup each reviewer used to rebuild by hand.

It is **not run in CI**: it needs Claude Code auth, and it spends real tokens. CI keeps running `claude plugin validate` and `claude plugin test`, which need no secrets.

## Auth

Each scenario runs with its own empty `CLAUDE_CONFIG_DIR` (see below), so a login saved by `/login` in `~/.claude` (or, on macOS, in the keychain under that config) is **not** found, and the kit never copies credential files or keychain entries. Give it auth through the environment:

```
claude setup-token                          # Claude subscription: prints a long-lived OAuth token
export CLAUDE_CODE_OAUTH_TOKEN=<that token>
# or, with an API account:
export ANTHROPIC_API_KEY=sk-ant-...
```

(`claude setup-token` and `CLAUDE_CODE_OAUTH_TOKEN` are the names in Claude Code 2.1.325.) When a session fails and its output looks like an auth error, the kit says so and repeats these steps. A host that provides auth through its own environment (a cloud session, a provider gateway) needs nothing more.

## Running

Node 22, no dependencies, from the repository root:

```
node scripts/live-eval.mjs                      # every scenario of every mod
node scripts/live-eval.mjs handoff              # every scenario in handoff/evals/
node scripts/live-eval.mjs output-shaper/evals/large-output.json
node scripts/live-eval.mjs --only handoff-after-compact handoff
node scripts/live-eval.mjs --list               # what would run
node scripts/live-eval.mjs --verbose handoff    # also print the claude command lines and each turn's answer
node scripts/live-eval.mjs --keep handoff       # keep everything it made, and print where
```

It prints one line per assertion, then a line per scenario and a total:

```
handoff-note-roundtrip  handoff/evals/note-roundtrip.json
  edit two files [haiku] 1/1 turns, 10s, $0.001
    PASS repo src/math.js ~ /function subtract/  (1/1 file(s) match)
    PASS debug log: the note was written  (1 of 376 lines match)
    ...
  PASS handoff-note-roundtrip  $0.001
```

The exit code is 0 when every assertion passed, 1 when any failed, and 2 when a scenario is invalid (nothing runs then).

## Cost

Haiku by default; Sonnet when a scenario asks for it. **Opus, Fable and Mythos are refused**: a session's `model` must be `haiku` or `sonnet`, a scenario whose plugin options, settings or env mention `opus`, `fable` or `mythos` (a mod's own `model` setting, `ANTHROPIC_MODEL`) does not run, and a `/model` turn is refused. Variables inherited from your shell that remap a model alias (`ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_*_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL`) are removed from the child's environment, and each session only has the tools its scenario lists; `Agent`, `Task` and `Skill` are refused there, so nothing can start work on another model.

A scenario on Haiku costs a few cents at most; the three here reported well under one cent each. The cost printed is what Claude Code reports for the session (`total_cost_usd`); model calls a mod makes itself (the handoff note) count in `/cost` but may not be in that figure.

## What a run does

1. Makes a temp folder with `repo/` (the scenario's files, `git init`, one commit), `artifacts/` (each session's stream-json output and debug log) and `config/`, which every session of the scenario gets as `CLAUDE_CONFIG_DIR`. Transcripts, plugin stores (`config/plugins/store/`), Claude Code's per-session folders and folders a mod keeps beside them (async-compaction's) all land there. Sessions of one scenario share it, so a note stored by session 1 is there for session 2. Your own `~/.claude` is never read or written.
2. Runs the sessions one after another in `repo/`, each as `claude -p --model <m> --plugin-dir <mod> [--plugin-dir <extra>...] --settings '{"pluginConfigs":{...}}' --input-format stream-json --output-format stream-json`. The turns go in on stdin one after another, each when the previous one's result arrives, so a slash command such as `/compact` works as a follow-up turn. Stdin closes after the last result, and the process runs its exit hooks before it ends.
   Sessions run with `--setting-sources ''` and `--strict-mcp-config`, so your own settings, installed plugins and MCP servers stay out (managed settings still apply).
3. Finds each session's transcript under `config/projects/*/<session id>.jsonl` (the id is set with `--session-id`) and checks the assertions after each session.
4. Removes the whole temp folder, pass or fail, and on Ctrl-C (SIGINT, SIGTERM, SIGHUP; not on SIGKILL or a power loss, which leave it in the system temp folder as `live-eval-*`). With `--keep` it stays, and its path is printed.

## Scenarios

One JSON file per scenario in `<mod>/evals/`. Only top-level `*.json` files with a `sessions` array are read, so a mod's other eval tooling can live in the same folder (async-compaction's `evals/` holds a separate summary-quality harness, which this does not touch).

```jsonc
{
  "name": "handoff-note-roundtrip",          // default: the file name
  "description": "...",
  "plugin": "..",                            // the mod folder, relative to this file; default: the folder above evals/
  "setup": {
    "git": true,                             // git init + add (default true)
    "commit": true,                          // one commit after setup (default true)
    "files": { "src/math.js": "export function add(a, b) {\n  return a + b\n}\n" }
  },
  "sessions": [                              // run in order, in the same repo
    {
      "name": "edit two files",
      "model": "haiku",                      // "haiku" (default) or "sonnet" only
      "prompt": "...",                       // or "turns": ["...", "/compact", "..."]
      "allowedTools": ["Read", "Edit", "Bash(seq:*)"],  // approved, and the only tools that exist; [] for none
      "options": { "minTools": 1 },          // pluginConfigs for the mod under test
      "pluginDirs": ["async-compaction"],    // more mods to load, relative to the repo root
      "pluginOptions": { "async-compaction": { } },     // pluginConfigs for those
      "settings": { },                       // more --settings keys
      "env": { "CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS": "20000" },
      "debug": "hooks",                      // true, a --debug filter, or false; on by itself when a debug assertion is present
      "timeoutSeconds": 300,
      "allowErrors": false,                  // true: a turn that ends in an error is not a failure
      "strictMcp": true,
      "worktree": "probe",                   // run isolated in a new git worktree of the repo (claude --worktree probe)
      "assert": [ ... ]
    }
  ]
}
```

### Assertions

Each assertion names a source in `in` and checks it with `matches` and/or `notMatches` (JavaScript regexes, with optional `flags` such as `i`, `m` or `s`; `g` and `y` are refused), `count`, or `exists`. In a regex, `{{repo}}` stands for the temp repo's path. `label` replaces the printed description.

| `in` | What is checked, item by item |
| --- | --- |
| `transcript` | Each line of the session's transcript JSONL, raw |
| `rows` | Each transcript row as JSON text; `type` filters on the row's type (`user`, `assistant`, `attachment`, `system`, ...) |
| `attachments` | The content of each attachment row (what hooks and Claude Code add beside a prompt); `type` filters, e.g. `hook_additional_context` |
| `toolResults` | The text of each tool result, as the model got it |
| `assistant` | Each text block Claude wrote |
| `result` | The final answer of each turn |
| `debug` | Each line of the debug log (`$.ui.log(..., { to: 'debug' })` from a mod lands here) |
| `repo` | Files in the temp repo matching the glob `path` (`*`, `**`, `?`) |
| `store` | The mod's store files in the scenario's own config (`plugin` to name another mod) |

- `matches` alone: at least one item matches.
- `notMatches` alone: no item matches.
- `count`: how many items match (all items when there is no regex), as a number or `{ "min": 1, "max": 2 }`. With both regexes, an item counts when it matches the first and not the second.
- `exists` (`repo`, `store`): `true` needs at least one file, `false` needs none. For `repo` without a regex, `count` counts files.

## The scenarios here

| Scenario | What it shows |
| --- | --- |
| `handoff/evals/note-roundtrip.json` | Session 1 edits two files with `minTools` 1, `minSecondsBetween` 0 and `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS=20000`: the note is written at the exit (debug log) and stored for the temp repo. Session 2 gets the `[handoff]` session-start note exactly once, and uses it. |
| `handoff/evals/after-compact.json` | The same note; then a session with async-compaction loaded beside handoff runs a prompt, `/compact` and a prompt: the note arrives once at the start and once after the compaction, two `[handoff]` attachments in all. |
| `output-shaper/evals/large-output.json` | `seq 1 5000` (over the 20,000 threshold, under Claude Code's inline limit) is shaped and saved by the mod under `.claude/output-shaper/`; `seq 1 30000` is shaped in place of Claude Code's `<persisted-output>` preview and points at Claude Code's own `tool-results` file; `seq 1 50` is left alone. |
| `worktree-coach/evals/chained-git.json` | A session started with `"worktree": "coach-on"` (`claude --worktree`) runs `cd src && git log -1 --oneline $(git rev-parse --abbrev-ref HEAD)`, which Claude Code's worktree guard refuses. The mod's note (trigger, then the `git -C` rewrite) reaches the model and Claude recovers with `git -C`. A second session with `enabled: false` gets the refusal with no note. |

## Limits

- The model is still a model: a scenario that needs Claude to make particular tool calls words its prompt tightly and allows only the tools needed. Rerun a failure once before reading much into it.
- Sessions always run with `--setting-sources ''`; a scenario cannot load your own settings (`settingSources` is refused, and so is `CLAUDE_CONFIG_DIR` in `env`).
- Files a mod writes outside `CLAUDE_CONFIG_DIR` and the repo (for example, under a fixed path in your home folder) are not isolated.
