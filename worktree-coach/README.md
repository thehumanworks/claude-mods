# worktree-coach

Helps Claude recover when Claude Code refuses a git command in a worktree.

A subagent started with `isolation: worktree`, or a session started with `claude --worktree`, may only run git against its own worktree. Before each Bash command, Claude Code checks that the command stays inside the worktree. If it can't check, it refuses the command:

```
This agent is isolated in the worktree <path>, but this command is too complex to verify that it stays inside the worktree. Refusing to run it — a worktree-isolated agent's git operations must target its own worktree. Split it into plain, separate commands and run them from <path>.
```

Each refusal costs Claude a turn, and Claude has to guess what to change. With this mod, Claude reads a short note right after the refusal. The note gives Claude Code's reason and remedy, quoted as they are, then the agent's worktree path and a few fixed tips that are safe in every case.

The mod uses no model calls and no network. It never changes the command or any permission. It only adds the note. The note never repeats any part of the refused command as a suggestion. The guard is there on purpose, and the mod only helps Claude comply with it.

## Install

```
/plugin install worktree-coach --marketplace thehumanworks/claude-mods
```

Answer `y` to add the marketplace, then pick a scope. To try it from a checkout for one session: `claude --plugin-dir ./worktree-coach`.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| Worktree coach (`enabled`) | on | When off, the mod adds no hooks. Refusals reach Claude with only Claude Code's own text. |

## What Claude reads

Take a worktree agent that runs `cd src && git log -1 --oneline $(git rev-parse --abbrev-ref HEAD)`. Claude Code refuses it, and Claude then reads:

```
worktree-coach: Claude Code refused this command because "this command names git in a form too complex to verify that it stays inside the worktree". Its remedy: "Split it into plain, separate commands and run them from /repo/.claude/worktrees/agent-a1."
Your worktree: /repo/.claude/worktrees/agent-a1
- Run each git command as its own Bash call.
- Use `git -C /repo/.claude/worktrees/agent-a1` with exactly this path.
- Use no `cd` chains, `$(...)`, pipes into git, or GIT_* variables.
- If you need data from one command, run it first and use its output in the next call.
Do not resend the same command.
```

The tips are the same for every command. An earlier version also suggested a rewritten command, but a mechanical rewrite of shell commands can't be made safe against every form, so it was removed.

## How it works

| Question | Answer |
| --- | --- |
| Which results | Results of the Bash tool whose text is one of Claude Code's worktree refusals. The mod checks Claude Code 2.1.325's wording: the git guard ("…but this command <reason>. Refusing to run it — … git operations must target its own worktree.") and the working-directory check ("…this command's working directory … is in a different worktree" or "… resolved to the shared checkout"). Other errors get no note. |
| Patterns | The reason in the refusal sorts it into a pattern, so that each kind of refusal is counted on its own: `too-complex`, `git-twice`, `shell-wrapper` (sh -c, xargs, eval before git), `chdir`, `runtime-value` (globs, variables, words filled in at run time), `git-env` (GIT_DIR, `-c` config, env flags), `cwd-outside` and `other`. |
| How often | The first refusal of a pattern gets the full note. The second gets nothing, because the note is still just above it. From the third on, each refusal gets a one-line reminder of the tips. |
| Subagents | Counts are kept separately for each agent (by `agentId`) and for the main loop. The guard mostly fires in subagents, so each one gets its own first note. |
| Whose calls | Only calls the model made: calls the engine raised that carry the model's `tool_use_id`. A plugin's own `$.tool.call` is skipped, because its result goes back to that plugin and never reaches Claude. |
| What it changes | Only `context` on the result, which is the text the model reads after the result. The command, the result and permissions are left as they are. If the hook fails, the call is answered as Claude Code answered it. |

## Limits

- The mod matches Claude Code 2.1.325's exact wording. If a later version rewords the refusal, no note is added until the patterns are updated.
- The note doesn't say which part of the command caused the refusal, beyond Claude Code's own reason.
- Counts are kept in memory, so a restart or a resumed session starts from zero.
- The PowerShell tool has no such guard, so the mod does nothing there.

## Development

```
claude plugin validate .
claude plugin test .
node scripts/live-eval.mjs worktree-coach     # from the repo root; needs auth, see EVALS.md
```

`hooks/register.ts` is the hooks module. `hooks/coach.ts` holds the parsing, the note and the counting. It doesn't depend on the engine, so the tests cover it directly. The live eval `evals/chained-git.json` starts a real `claude --worktree` session on Haiku and runs a command that the guard refuses. It checks that the note reaches the model and repeats nothing of the command, that Claude recovers with `git -C`, and that no note is added when `enabled` is off.
