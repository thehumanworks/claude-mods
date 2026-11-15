# output-shaper

Gives Claude a better view of a Bash command that prints a lot.

Without this mod, a long output reaches Claude in one of two ways. Up to 30,000 characters, it gets all of it, which can fill its context with log lines it never needed. Past that, Claude Code saves the output to a file and Claude sees only the first 2 KB and the path. A build or test run usually puts its failure at the end, so Claude spends another call reading the file.

With this mod, once the output is over the threshold Claude reads:

- the first 40 lines,
- a marker with the line numbers left out and the total line and character counts,
- the last 60 lines,
- the path of the whole output, with a one-line hint to Grep it or Read a range of it instead of running the command again.

No model calls, no network.

## Install

```
/plugin install output-shaper --marketplace thehumanworks/claude-mods
```

Answer `y` to add the marketplace, then pick a scope. From a checkout, for one session: `claude --plugin-dir ./output-shaper`.

## Settings

Set on the screen the install shows, and afterwards in `/config`.

| Setting | Default | What it does |
| --- | --- | --- |
| Shape output over (`threshold`) | `20000` | Output longer than this many characters is shaped. 2,000 to 200,000. Output Claude Code has already saved to a file is always shaped. The threshold is also the most the kept lines may take, up to 24,000 characters so the shape stays under Claude Code's own inline limit. |
| Lines from the start (`headLines`) | `40` | How many of the first lines Claude reads. 0 to 500. |
| Lines from the end (`tailLines`) | `60` | How many of the last lines Claude reads. 1 to 1,000. |
| Folder for saved output (`saveDir`) | empty | Where the whole output is saved when Claude Code did not save it already. Absolute, or relative to the session's folder. Empty means `.claude/output-shaper/<session id>` in the session's folder. A folder you set is used as it is: the mod writes only the output files there. |

A number out of range keeps its default and says so in the log.

## What Claude Code does today (2.1.325)

Found in the API's types and in what the tool sends the model:

| Case | What the model sees |
| --- | --- |
| Output up to the inline limit | All of it. The limit is the `bashOutputMaxChars` setting: 30,000 characters by default, 4,000 to 128,000. |
| Output over the limit | Claude Code saves the whole output to the session's `tool-results` folder. The Bash record carries `persistedOutputPath` and `persistedOutputSize` (bytes). The model sees `<persisted-output>Output too large (…). Full output saved to: <path>` and a preview of the first 2 KB. Sometimes (`stdoutHoldsOutputEnd`) the preview is a start and an end of about 1.5 KB. There are no line counts. |
| Output over 64 MiB | Only the first 64 MiB are saved, and the notice says so. |
| A command that fails (non-zero exit) | An error result: `Exit code N`, then the output. Past about 10,000 characters it is cut to its first and last 5,000, with `... [N characters truncated] ...` between. If the output went over the inline limit, the error holds the same saved-file notice and 2 KB preview. |

So Claude Code already saves big outputs. This mod builds on that and does not save them a second time:

- **Over Claude Code's limit:** the mod reuses Claude Code's own file. It reads the file for the counts and the last lines, and puts its shape in place of the 2 KB preview.
- **Between the threshold and Claude Code's limit:** Claude Code would send everything. The mod saves the output itself and sends the shape.

## How it works

| Question | Answer |
| --- | --- |
| Which calls | Only Bash calls Claude makes itself in the main loop. Calls another plugin makes are left alone, and so are a subagent's. |
| What is measured | stdout and stderr together, in characters. |
| What Claude reads | The tool's own result, rebuilt with the shaped stdout. Claude Code turns it into the model's text with Bash's own formatting, so its other notes still come through. |
| stderr | Kept whole up to 2,000 characters. Longer, its last lines (up to the `tailLines` setting) are kept. |
| Long lines | A kept line over 500 characters is cut, and says how much is left out. |
| Where the output goes | Claude Code's own file when there is one. Otherwise `.claude/output-shaper/<session id>/<tool_use_id>.txt`, or `<saveDir>/<tool_use_id>.txt` when you set a folder. Only the default `.claude/output-shaper` folder gets a `.gitignore` holding `*`, so git ignores it. |
| Saved files over 4 MiB | The mod cannot read them in one go, so it runs `wc`, `head` and `tail` on them. The size is then given in bytes. If those cannot run, Claude gets what Claude Code sent. |
| Errors | An error result is never cut or rewritten. The exit code, the output and Claude Code's own cut stay as they are. If Claude Code saved the output (its preview only shows the start), the mod adds the last lines and the path as context right after the result. |
| Which saved files it reads for an error | The path is taken from the error text, which also holds the command's own output, so it is trusted only when Claude Code's notice sits where Claude Code puts it (the line right after `Exit code N`), and only for a plain file in this session's own `projects/<project>/<session id>/tool-results/` folder, links followed. A command that prints a notice of its own gets nothing read. |
| Left alone | Output under the threshold, backgrounded commands, images, results with structured content, and calls a hook refused. |
| When something goes wrong | If the mod fails at any step, Claude gets the result Claude Code made, unchanged. |

What Claude reads looks like this (`npm test`, 3,000 lines):

```
> app@1.0.0 test
> jest
...                         (the first 40 lines)
[output-shaper: lines 41 to 2,940 (2,900 lines) left out here; 3,000 lines, 182,331 characters in all]
...                         (the last 60 lines)
Tests:       2 failed, 412 passed, 414 total
[output-shaper: the whole output is in /repo/.claude/output-shaper/3f0c…/toolu_01Ab.txt. To see more, Grep that file for a pattern or Read it with offset and limit (the line numbers above); do not run the command again for it.]
```

## Limits

- The transcript keeps the shaped result too, so the Bash row on your screen shows the shape, not the whole output. The file has all of it.
- The save folder grows and is never pruned: the mod has no way to delete files. Each session has a folder of its own under `.claude/output-shaper`, so old ones are easy to remove by hand, or remove the whole folder whenever you like.
- Claude's first Read of a saved file may ask you for permission, more so with a `saveDir` outside the project.
- The mod writes into `.claude/` in your project. A file watcher (a dev server, a test runner in watch mode) that does not ignore that folder may see the writes.
- When Claude Code cut its own file at 64 MiB, the counts cover only the part it saved.
- An output Claude really wanted whole (`cat` of a file of 20,000 characters) is shaped too. Claude can Read the saved file, or the original file. Raise the threshold if this happens often.
- An error under Claude Code's limit is passed as it is, already cut to 10,000 characters by Claude Code. Its first and last 5,000 characters are there, but the mod has no copy of the middle to save.
- Only Bash. PowerShell and other tools are not shaped.

## Development

```
claude plugin validate .
claude plugin test .
```

`hooks/register.ts` is the hooks module: it picks the calls, reads or saves the whole output and returns the shaped result. `hooks/shape.ts` holds the logic, free of the engine: settings, the cut into first and last lines, and the words Claude reads.
