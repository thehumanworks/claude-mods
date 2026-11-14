# Eval log

What was measured, in the order it was measured, and what each result decided.
Everything here was run with haiku (`claude -p --model haiku`), which writes the
summaries at low effort, as the mod asks, and answers the probes at medium.
Commands are at the top of `run.ts`; raw results are in `results/`.

## How a summary is scored

1. The mod's own code (`hooks/summary.ts`) renders a synthetic conversation,
   asks the model for the summary, drops made-up ids and appends the user's
   quoted messages, exactly as in a session.
2. A second model call sees only that summary message and answers the
   fixture's probes, with UNKNOWN allowed. Regexes grade the answers.
3. Probes are split by whether the code-appended quotes already hold the
   answer. **"Prompt's own"** probes are the ones they do not: these are what
   the wording of the prompt decides, and what the hill-climb is scored on.
   "As shipped" counts every probe, quotes included.
4. Never-stated probes ask for things the conversation never said: the right
   answer is UNKNOWN. They measure guessing.
5. Mechanical guards: words against the level's limit, replies past the token
   cap, names and numbers in the summary that the conversation nowhere holds,
   and whether the id the answer cites leads to the message that holds it.

## 1. Are the probes sound? (controls)

Each fixture's probes were answered twice: with the whole conversation in
context, and with an empty summary.

| fixture | everything in context | nothing in context | never-stated kept UNKNOWN |
|---|---|---|---|
| flaky-test | 18/18 | 0/18 | 3/3 |
| rate-limiter | 19/19 (17/19 before two questions were reworded) | 0/19 | 3/3 |
| sales-analysis | 19/19 | 0/19 | 3/3 |
| migration | 19/19 | 0/19 | 3/3 |
| docs-rewrite | 19/19 | 0/19 | 3/3 |
| incident | 20/20 | 0/20 | 3/3 |
| long-dev | 57/57 | 0/57 | 9/9 |
| long-held-out | 57/57 | 0/57 | 9/9 |

So a probe is missed because the summary lost the fact, not because the
question cannot be answered or the grader is off.

## 2. Is there anything to climb? (the baseline)

The first prompt, on the three single-task dev fixtures (200k, 250k and 70k
characters as the compaction model reads them), balanced, five repetitions:
**97.8%** of the prompt's own probes right, in 700 words of the 1,200 allowed.
That is a ceiling: one task fits in the budget with room to spare, whatever
the prompt says. Single-task fixtures cannot tell two prompts apart.

The long sessions were built for that reason: three tasks one after the other
in one conversation (300k characters, 66 probes), so that one word budget has
to cover all three. On `long-dev`, five repetitions:

| level | prompt's own | as shipped | words (limit) | spread over repetitions (SD) |
|---|---|---|---|---|
| balanced | 82.2% | 88.8% | 1,162 (1,200) | 3.2 points |
| aggressive | 73.3% | 81.8% | 921 (500) | 4.7 points |

Two things that are not about the prompt came out of this run:

- **The reply cap was too tight.** One baseline reply spent 12,190 output
  tokens (thinking included) on a 1,115-word summary. The mod capped replies at
  4,800 tokens, which would have cut that summary off. The cap is now 24,000
  and a reply that reaches it is treated as a failure, not as a summary.
- **The aggressive level does not hold its limit**: 921 words against 500. The
  length rule is part of what is climbed below.

What the baseline loses under pressure: exact identifiers and values from tool
output (a test's name, a count, a channel), details that were only in the
earlier summary it had to fold in, and short instructions given in passing in
the oldest task, once the quotes budget no longer reaches back to them.

## 3. The rule for accepting a change (fixed before any variant was run)

A candidate replaces the incumbent when, on `long-dev` at balanced and
aggressive together (five repetitions each):

- its prompt's-own accuracy is higher by **3 points or more**, paired by
  probe, with the 90% bootstrap interval above zero (the baseline's own
  spread between repetitions is 3 to 5 points, so a smaller gain is noise);
- and none of these gets worse: as-shipped accuracy (by more than 1 point),
  the number of summaries over their limit, never-stated probes kept UNKNOWN,
  and unsupported names (by more than 1.5 points).

A tie keeps the incumbent. The held-out fixtures (`long-held-out` and the
three single-task ones) are not looked at until a winner is chosen; they are
then run once, and the winner stands unless it is more than 3 points below the
baseline there. With 57 stated probes a side, held-out can only say "no
regression", not rank prompts.


## 4. Round 1: four prompts against the baseline

`long-dev`, balanced and aggressive, five repetitions each (`results/round1.json`).
The prompts are in `variants.ts`.

| prompt | what it changes | prompt's own | against baseline (90% interval) | wrong | words | seconds |
|---|---|---|---|---|---|---|
| baseline | six headings: goal, context, work, decisions, state, working together | 77.6% | | 4.6% | 1,042 | 21 |
| dense | baseline, plus "notes, not prose; write the exact token" | 77.6% | +0.0 (-3.2 to 3.7) | 4.7% | 828 | 19 |
| priority | baseline, plus what to drop first when space is short | 76.8% | -0.8 (-4.0 to 2.1) | 4.2% | 998 | 18 |
| tasks | one section per task, oldest first; standing instructions once at the top | 82.1% | +4.5 (1.6 to 7.7) | 1.9% | 950 | 32 |
| **combined** | tasks + dense + priority | **87.5%** | **+9.9 (6.1 to 14.1)** | 2.3% | 965 | 37 |

`combined` passes the rule: +9.9 points on the prompt's own probes (+6.5 as
shipped), 93.3% at balanced and 82.1% at aggressive, no guard worse beyond its
margin (unsupported names 4.2% against 3.8%, never-stated 100%). Neither
"dense" nor "priority" does anything alone; on top of the per-task layout they
add five points. What gains most: values (67% to 81%) and identifiers (46% to
66%). What it costs: the summary takes about 37 seconds to write instead of 21,
because the model thinks longer before it.

## 5. Round 2: three changes on top of `combined`

Same cells, same rule, `combined` as the incumbent (`results/round2.json`).

| prompt | what it changes | prompt's own | against combined (90% interval) |
|---|---|---|---|
| combined-fold | a firmer rule for folding in the earlier summary | 88.3% | +0.8 (-2.7 to 3.5) |
| combined-length | a firmer length rule ("count the words; over the limit is a failure") | 86.7% | -0.8 (-3.7 to 2.1) |
| combined-passing | "instructions given in passing count as standing instructions" | 87.2% | -0.3 (-3.2 to 2.4) |

None clears three points, so `combined` stays. The climb stops here: the
probes it still misses are exact values from tool output and details that sat
only in an earlier summary, which no wording brought back.

## 6. A second pass to hold the aggressive limit: rejected

Haiku treats a word limit as a rough target. Asked for 500 words on a
three-task session it writes about 780, whatever the wording (round 2's firmer
rule: 803). A second request, "this is over the limit, write it again
shorter", brought 784 words to 715, cost 1.6 points and ten seconds
(`results/round2-second-pass.json`). It was removed. The levels' word limits
are documented as targets; what does hold is their order (aggressive is the
shortest, soft the longest).

## 7. Held-out, as run

Run once, as the rule says (`results/held-out-long.json`,
`results/held-out-single.json`), five repetitions on the long session, three
on each single-task fixture.

| fixtures | baseline | combined | against baseline (90% interval) |
|---|---|---|---|
| six single-task fixtures, balanced | 95.4% | 96.0% | +0.6 (-2.3 to 4.0) |
| `long-held-out`, balanced | 73.6% | 84.5% | |
| `long-held-out`, aggressive | 81.0% | 50.7% | |
| `long-held-out`, both levels | 78.4% | 62.5% | **-15.9 (-21.3 to -9.5)** |

**By the rule, `combined` fails held-out.** The cause is narrow and is not the
quality of its summaries: in two of its five aggressive repetitions haiku did
not write a summary at all. It answered the request instead ("I'm sorry, but I
can't write that summary … send me the transcript again"), in 65 and 136
words, and the probes asked of those two replies score 30%. The other eight
`combined` summaries score 47 to 55 of 57, against the baseline's 48 to 53.

Looking back through every run for such replies (no cited id, or opening as a
refusal) finds three in about 190 summaries: these two, and one from the
nine-section reference prompt in section 2, which carried the conversation on
("I'm picking up at …") instead of summarizing it.

What follows from it:

- **A bug in the mod, whatever the prompt.** It took any non-empty reply for
  the summary, so a refusal would have replaced the conversation. It now
  checks each reply (`isSummaryLike` in `hooks/summary.ts`: a reply that opens
  as a refusal, or cites no message when it was shown eight or more, is not a
  summary), asks once more, and after a second such reply leaves the
  compaction to Claude Code.
- **The eval's model call is not the mod's.** A `claude -p` child is given an
  environment block and an account-context reminder besides the system prompt
  and the request; `$.model.complete`, which the mod uses, sends neither. One
  refusal names that block ("the block above is instead a system-environment
  description"), and one round-1 summary copied the reminder into itself. So
  the refusals may belong to the harness, not to the prompt. Section 8
  measures that.

### The rule for a second look (written before it was run)

Held-out is spent: anything run on it from here is a second look and is
labelled so. It is run with fresh repetitions (numbers 5 to 9) of both
prompts, with the mod's check in place.

- Accuracy is counted over the summaries that were written. A reply that was
  not a summary and was asked for again, and a compaction left to Claude Code,
  are counted in columns of their own, never as probe misses and never
  redrawn beyond the one retry the mod itself makes.
- `combined` becomes the default if, on `long-held-out` at both levels, it is
  not more than 3 points below the baseline over the written summaries, and if
  section 8 does not show it making the real `$.model.complete` call refuse
  more often than the baseline does.
- Otherwise the baseline stays the default and `combined` is documented as
  the better prompt on the dev session that did not hold up.

## 8. Do the refusals belong to the prompt or to the harness?

Three measurements, all on the request that was refused (`long-held-out`,
aggressive) unless said otherwise.

**On the eval's path** (`bun evals/run.ts rate`, summaries only, 20
repetitions per prompt; `results/rate-held-out.json`, `results/rate-dev.json`):

| prompt | session @ level | summaries asked for | first reply not a summary | left to Claude Code |
|---|---|---|---|---|
| baseline | `long-held-out` @ aggressive | 20 | 0 | 0 |
| combined | `long-held-out` @ aggressive | 20 | 2 | 0 |
| baseline | `long-dev` @ aggressive | 20 | 0 | 0 |
| combined | `long-dev` @ aggressive | 20 | 0 | 0 |

Each cell is 20 draws per prompt, repetitions 0 to 19, of which 0 to 4 were
already in the cache from the runs above. On `long-held-out` that leaves 15
new draws per prompt; the two replies that were not summaries are the two
already known (repetitions 1 and 2), and the new draws added none. Asked
again, both gave a summary, so with the check in place nothing was left to
Claude Code. The `long-held-out` cell was run with the rules as they were
before the change described below; `long-dev` opens with an earlier summary,
so its system prompt is the same before and after it.

**On the mod's path.** A scratch plugin (not in this repository) sent the same
system prompt and request through the real `$.model.complete`, haiku at low
effort, the way `hooks/register.ts` does:

| prompt | calls | summaries | refusals or other non-summaries |
|---|---|---|---|
| combined | 20 | 20 | 0 |
| baseline | 10 | 10 | 0 |

Every reply was a summary of 604 to 962 words citing 49 to 78 messages. The
first five `combined` calls were made with the rules as they were, the other
fifteen and the ten `baseline` calls after the change described below.

So through the child session `combined` refused twice in 20 draws of this
request and the baseline never; through the call the mod makes neither did,
in 20 and 10 draws. That is too few to call the rate zero on the mod's path,
but it does not show `combined` refusing more often there than the baseline,
which is what the second-look rule asks of this section. The check stays in
the mod either way.

**A second defect the replay found.** The first five replies on the mod's path
all opened with `<earlier_summary> none </earlier_summary>` or a sentence
saying there was none: the rules told the model what to do with an earlier
summary whether or not the conversation had one, and haiku wrote about it. The
eval's own summaries had it too: 29 of 191 opened with the tag, a few wrapped
the whole summary in it, and a few carried the conversation on after the
summary in the transcript's own format. Two changes, both in the mod:

- The rule about folding an earlier summary in, and the clause of the citing
  rule about its ids, are now added only when the conversation opens with one.
  With an earlier summary the system prompt is byte for byte what it was. The
  25 replies after the change (15 `combined` and the 10 `baseline`, all in
  the table above) have no such opening.
- `cleanReply` in `hooks/transcript.ts` takes off what a model still puts
  around its summary: the tag, and anything from the first line written in
  the transcript's format on.

Both changes are in place for everything run from here on. Results above this
section were scored without them, and are left as they were run.

## 9. Held-out, second look: `combined` becomes the default

Run under the rule written in section 7, before it: fresh repetitions 5 to 9
of both prompts on `long-held-out`, five at each level, with the mod's check
and both changes of section 8 in place
(`results/held-out-long-second-look.json`).

| prompt | balanced | aggressive | both levels | not a summary, asked again | left to Claude Code |
|---|---|---|---|---|---|
| baseline | 65.5% | 76.1% | 72.4% | 0 | 0 |
| combined | 74.5% | 82.4% | 79.7% | 0 | 0 |

`combined` against the baseline, the prompt's own probes: **+7.3 points (90%
interval 2.9 to 11.1)**, 63 probes; as shipped, with the user's own messages
quoted after the summary, +4.0 (2.1 to 6.1), 114 probes.

| right by kind | goal | instruction | value | decision | identifier | state | superseded | rejected | error |
|---|---|---|---|---|---|---|---|---|---|
| baseline | 100.0% | 93.3% | 57.8% | 80.0% | 50.0% | 93.3% | 100.0% | 100.0% | 100.0% |
| combined | 100.0% | 96.7% | 68.9% | 84.0% | 60.0% | 100.0% | 100.0% | 100.0% | 100.0% |

The rule asked that `combined` be no more than 3 points below the baseline at
both levels and that section 8 not show it refusing more often on the mod's
path. It is 9.0 points above at balanced and 6.3 above at aggressive, and
section 8 found no refusal from either prompt on the mod's path. **`combined`
is now `DEFAULT_PROMPT` in `hooks/prompts.ts`.** `baseline` stays frozen in
`variants.ts`.

What to hold against this result:

- It is a second look at a held-out session, not a first. The first look
  failed the rule, for a reason that turned out to be two refusals and not the
  summaries, but the decision to look again was made knowing the first result.
- One model (haiku), one long held-out session, ten summaries per prompt.
- What `combined` still loses most is exact values and identifiers out of tool
  output (69% and 60% here). That is what the recall tool is for.
- Neither prompt holds the word limit as a limit: 5 of 10 `combined` summaries
  and 4 of 10 baseline ones ran over it, most at the aggressive level (limit
  500 words, mean about 700). The limits are targets.

## 10. Round 3: the prompting guide's instruction

Anthropic's prompting guide gives a summarization instruction for compacting
on the client ("Tell the model what to preserve in compaction summaries" in
the Claude Fable 5.1 guide): six things to preserve, completeness on those
over brevity, and the user's words kept closer than the assistant's. It was
not among the sources of rounds 1 and 2, so it is tested here.

Written before the run. Same cells and rule as section 3 (`long-dev`, balanced
and aggressive, five repetitions each), `combined` as the incumbent, rerun in
the same run so that all three are scored with the changes of section 8.

| prompt | what it is |
|---|---|
| guide | the guide's instruction as a reference point, with three adaptations: no `<summary>` tags (the mod takes the reply as the summary); "your own explanations" becomes "the assistant's", since a second model reads the transcript; "even at the cost of length" is left out, since the level's length rule follows the prompt. Its six items and its weighting of the two voices are kept word for word. |
| combined-exact | `combined` plus the guide's sixth item, reworded to say what `combined` does not already: details hard to reconstruct are kept exactly wherever they appeared, tool output included. Aimed at values and identifiers, 69% and 60% in section 9. |

What to expect: the weighting of the two voices should show more on the
prompt's own probes than as shipped, because the mod already quotes the
user's messages after the summary. Held-out has been looked at twice, so a
prompt that clears the rule here is confirmed on a new held-out session
written for the purpose, or not adopted.

**As run** (`results/round3.json`):

| prompt | prompt's own | against combined (90% interval) | as shipped | balanced | aggressive | unsupported names | seconds |
|---|---|---|---|---|---|---|---|
| combined | 87.2% | | 91.6% | 93.3% | 81.5% | 4.1% | 37 |
| guide | 85.1% | -2.1 (-6.9 to 1.3) | 90.2% | 83.9% | 86.2% | 2.5% | 18 |
| combined-exact | 85.9% | -1.3 (-4.8 to 1.9) | 90.7% | 91.1% | 81.0% | 4.2% | 43 |

Neither clears the rule, so `combined` stays and no new held-out session is
written. What the run shows besides:

- The guide's instruction, a paragraph with no layout asked for, is within
  noise of `combined` and is written in half the time. It keeps the user's
  instructions better (91% against 83%: its weighting of the two voices) and
  invents fewer names, and loses on goals, decisions and values, most at the
  balanced level (84% against 93%), where the per-task layout pays.
- Its summaries are as long at the aggressive level as at balanced (995 and
  987 words): it takes the length rule least seriously of the three.
- Saying once more that exact details are to be kept, tool output included,
  brings back none: values 79% against 81%, identifiers 62% against 66%.
  Three wordings have now failed to (sections 5 and 10). Those details are
  the recall tool's to bring back, not the prompt's.

## 11. Real sessions: is the summary written ahead the one swapped in?

Everything above scores summaries. This checks the mechanism: a `claude -p`
session with the mod loaded and a small window (auto-compact limit 48,000
tokens, trigger at 36,000) reads generated notes one file at a time, notes a
finding after each, and lists every note's key fact at the end.

| session | model | compactions | summary swapped in was written | the compaction took | key facts right at the end |
|---|---|---|---|---|---|
| 12 notes | haiku | 3 | ahead, 29 to 31 s before, all 3 | 13 to 18 ms | 12/12 |
| 12 notes | Mythos 5.2 | 3 | **at the limit, all 3** | 4.3 to 6.3 s | 12/12 |
| 6 notes | Mythos 5.2 | 1 | **at the limit** | 10.1 s | 6/6 |
| 6 notes, after the fix below | Mythos 5.2 | 1 | ahead, 14 s before | 17 ms | 6/6 |
| 6 notes, after the fix below | haiku | 1 | ahead, 12 s before | 12 ms | 6/6 |

The Mythos sessions are the only runs here not made with haiku: the swap had
to be seen on the model whose kept turns carry thinking, which the API docs
single out as the case that can fail after a summary written by the client.
It does not fail: a kept turn with a thinking block went back out after the
swap with no API error.

**The bug.** On Mythos the summary was ready every time and never used; a
second one was written at the limit, which is the wait the mod exists to
remove. The mod recognised "the same conversation" by one hash over the first
N messages, and the two places it reads the conversation from do not list the
messages in the same order. Mythos makes its tool calls three at a time; for
one such reply:

| read from | rows of one reply |
|---|---|
| `session.compact` (`e.messages`) | thinking, call, call, call, result, result, result |
| `$.session.messages()` | thinking, call, call, result, call, result, result |
| `$.session.messages()`, a quicker tool | thinking, call, result, call, call, result, result |

The second and third are the order the rows arrived in, so they vary with how
fast each tool answers, and nothing in them marks where a reply ends: no
reordering of one list gives the other. Haiku called one tool at a time, the
two lists agreed, and the bug stayed hidden there.

**The fix** (`fitSummary` in `hooks/transcript.ts`): the summary keeps one key
per message it covers (role, text, each call with its id, each result by the
id of the call it answers), and at compaction those messages are matched as a
set. The cut is always chosen on compaction's own list: the latest clean cut
with only summarized messages before it. If a reply ran across the summary's
cut, the whole reply stays raw. Tests cover both arrival orders, a reply
across the cut, and one changed message among the same number.

One more thing the last session showed: the compaction model's first reply was
not taken for a summary and was asked for again (7.7 s lost, the second reply
used). That is the first such reply on the mod's own path, among roughly
fifty summaries written there (section 8's 30, which had none, and these
sessions'): rare, not absent.

### Last check, with everything as shipped

Run after round 4 (section 12), with the final prompt and code, all on haiku:

| session | settings | compactions | summary swapped in was written | the compaction took | key facts right at the end |
|---|---|---|---|---|---|
| 6 notes | defaults | 1 | ahead, 13 s before | 10 ms | 6/6 |
| 12 notes | defaults | 2 | ahead, 11 and 28 s before | 9 ms | 12/12 |
| 12 notes | defaults | 2 | ahead, 13 and 31 s before | 9 to 11 ms | 12/12 |
| 12 notes | `level: soft`, `triggerAt: 60` | 5 | ahead by 11 to 46 s, 3; still being written at the limit and waited for, 2 | 8 to 11 ms; 5.1 and 6.5 s | 12/12 |

- **Compactions in a row work with the set matching**: each later summary
  folds the earlier one in, none was turned down ("is not used" appears in no
  log), and the archive's ids carry on (m0 to m19, then m20 to m34).
- **Settings arrive and change what happens**: the trigger moved to 28,800
  tokens (60% of 48,000) and soft kept 17 to 23 messages raw where balanced
  kept 6 to 10. The options went in through `--settings`; the first try put
  them in the project's `.claude/settings.json`, which Claude Code does not
  read plugin options from, and that session (the third row) ran on defaults.
- **Soft with a low trigger in this small window compacts too often**: five
  times against two, and twice the limit came while the summary was still
  being written (the mod waited 5 to 7 s for it). Claude Code's own prompt
  and tools take some 45% of a 48,000-token window, soft keeps 15% of the
  limit from before the trigger and the trigger at 60 leaves 40% after it, so
  a swap frees almost nothing. In a window of ordinary size the fixed part is
  about a tenth and the same settings leave a third of the window free; this
  was not run there.

## 12. The three levels, merged parts, and what the ids cost

The default prompt against the first one on `long-dev`, five repetitions a
cell, now at all three levels (`results/levels.json`); then the default alone
with the conversation split in four parts and merged (`--part-chars 80000`,
`results/merge.json`), and with ids off (`--no-refs`, `results/no-refs.json`),
both at balanced. In this section and its results files "the default" is
`combined`, the default when these were run; round 4, at its end, replaces it.

| level (limit) | first prompt | default | default against it (90% interval) |
|---|---|---|---|
| aggressive (500 words) | 73.3%, 921 words | 81.5%, 784 words | +8.2 (3.6 to 12.8) |
| balanced (1,200) | 82.2%, 1,162 words | 93.3%, 1,146 words | +11.1 (4.4 to 17.8) |
| soft (2,500) | 94.4%, 1,644 words | 91.1%, 1,287 words | -3.3 (-7.2 to 0.6) |

| default at balanced | prompt's own | against one pass with ids (90% interval) | words | seconds |
|---|---|---|---|---|
| one pass, ids (as shipped) | 93.3% | | 1,146 | 41 |
| four parts merged | 96.1% | +2.8 (-1.7 to 8.3) | 1,641 | 131 |
| ids off | 95.5% | +2.2 (-1.7 to 7.2) | 1,291 | 21 |

What this says:

- **The levels are three different summaries**, 82%, 93% and 91% of the facts
  kept in 784, 1,146 and 1,287 words. Aggressive still runs over its limit
  (all five), as before.
- **At soft the default prompt is no better than the first one**, and may be
  worse. It leaves half its room unused (1,287 of 2,500 words): the prompt
  says what to leave out when there is too little room and nothing about what
  to put back when there is plenty. Round 4 below tries that.
- **Merging works**, and loses nothing against one pass, but the merged
  summary runs 37% over the level's limit (all five) and takes three times as
  long. In the mod it happens only past some 125,000 tokens of rendered
  conversation. The merge request is tried with the limit restated, below.
- **The ids cost time, not facts**: a summary with citations takes twice as
  long to write (41 s against 21 s) and scores within noise of one without.
  The time is spent in the background.

### Round 4 (written before it was run)

| candidate | what it is | accepted if |
|---|---|---|
| `combined-room` | the default prompt plus one sentence after its last paragraph: when the length allows more than was written, put back first the exact values, names and identifiers that only a tool's output showed, then the instructions given in passing | on `long-dev` at soft it is 3 points or more above the default with the interval above zero, and at balanced and aggressive together it is not below the default by more than 3 points and no more summaries run over their limit. Then `long-held-out` at soft, which has not been looked at at this level: it stands unless it is more than 3 points below the default there. |
| merge request with the limit restated | "The length limit is for the merged summary as a whole, not for each part." added to the merge request | the merged summaries average within 10% of the limit (1,320 words) and score no more than 3 points below one pass (93.3%) |

**As run on dev** (`results/merge-limit.json`, `results/round4.json`):

- The merge request with the limit restated: 1,653 words on average against
  1,641 without the sentence, all five over the limit again (97.8% right).
  **Rejected**; the sentence is taken out. A merged summary is longer than its
  level asks, and saying so in the request does not change it.
- `combined-room`: at soft 96.7% against 91.1%, **+5.6 (2.2 to 8.9)**, in
  1,457 words against 1,287; at balanced and aggressive together -0.3 (-3.7 to
  3.5), with as many summaries over their limit (the five aggressive ones and
  one balanced, for both). It clears the dev half of the rule.

Added before the held-out run: `long-held-out` is run at all three levels,
not only at soft. Soft is the test as written above. Balanced and aggressive
are a guard with the same bar as on dev (together not more than 3 points below
the default), since the sentence goes into the prompt at every level.

**As run on held-out** (`results/round4-held-out.json`; `default` in this file
and in `round4.json` is the prompt of section 9, `combined`):

| level | `combined` | `combined-room` | difference (90% interval) |
|---|---|---|---|
| soft | 84.8%, 1,135 words | 97.1%, 1,505 words | **+12.4 (3.8 to 22.9)**, 21 probes |
| balanced | 77.3%, 941 words | 78.2%, 946 words | +0.9 (-3.6 to 6.4) |
| aggressive | 82.4%, 669 words | 82.4%, 784 words | 0.0 (-3.9 to 4.4) |
| balanced and aggressive together | | | +0.3 (-2.9 to 3.8), 63 probes |

It stands at soft and passes the guard at the other two, with no summary of
either prompt refused or left to Claude Code. **`combined-room` is now
`DEFAULT_PROMPT`.** `combined` stays in `variants.ts` as it was.

What to hold against it:

- The gain is at one level. At balanced and aggressive the sentence changes
  nothing that can be measured, as intended: there is no room to put anything
  back.
- At aggressive it made the held-out summaries longer (784 words against 669,
  limit 500), where on dev they were shorter (737 against 784). All five are
  over the limit with either prompt.
- Soft summaries still use 60% of their room (1,505 of 2,500 words).
- At soft, 21 held-out probes are the prompt's own: the quotes budget is
  larger there, so more probes are answered by the quoted messages.
- Five summaries a cell, one model.

### Where the prompt stands

| on the held-out session, prompt's own probes | aggressive | balanced | soft |
|---|---|---|---|
| first prompt (`baseline`, section 9, repetitions 5 to 9) | 76.1% | 65.5% | not run |
| `combined` (section 9, repetitions 5 to 9) | 82.4% | 74.5% | |
| `combined` (this section, repetitions 0 to 4) | 82.4% | 77.3% | 84.8% |
| `combined-room`, the default | 82.4% | 78.2% | 97.1% |

## 13. The recall tool: approve or reject

The tool was a proposal to research and then approve or reject. The rule is
in `recall.ts` and was fixed before the run: **approve** if details the
summary dropped are answered right at least 80% of the time with the tool, at
least 30 points more often than without it, and the agent recalls on at most
15% of the questions its context already answers.

Three real sessions (`recall.ts make`): haiku with the mod loaded reads twelve
generated notes one at a time in a small window, and the mod compacts each
session four times as it runs. The notes are then deleted. Each of 36
questions per session is put to the session as compaction left it
(`--resume`, nothing saved, so every question starts from the same state),
once with the recall tool and once without. File tools, subagents and every
other way back to the notes or the transcript are off in both arms, so the
two differ by the recall tool alone. Where each answer sits (in the summary,
in the messages kept raw, only in the archive, nowhere) is read off the
compacted session, not assumed.

| where the answer is | questions | right with the tool | recalled | calls when it did | seconds | right without the tool | seconds |
|---|---|---|---|---|---|---|---|
| in the summary | 29 | 100% (29/29) | 3% (1/29) | 1.0 | 7 | 100% (29/29) | 7 |
| in the raw tail | 17 | 100% (17/17) | 12% (2/17) | 1.0 | 6 | 100% (17/17) | 5 |
| dropped (archive only) | 61 | 90% (55/61) | 90% (55/61) | 1.7 | 13 | 0% (0/62) | 13 |
| never stated | 9 | 89% (8/9) | 89% (8/9) | 3.0 | 16 | 100% (9/9) | 13 |

Dropped details: 90% with the tool, 0% without. Needless recalls: 3 of 46
(7%). **Approved**: the tool stays, on by default (`results/recall.json`).

What the numbers do and do not say:

- **Every recall of a dropped detail found it** (55 of 55), in 1.7 calls. The
  6 misses are answers where the agent never called the tool: all in one
  session, it tried to read the note again, was told Read is off, and stopped
  there. In ordinary use it would have re-read the file, which is the better
  move when the file still exists. The eval takes that away on purpose, to
  measure the case the archive is the only way back (a command's output, a
  page, something the user said).
- **Without the tool the agent did not guess**: 0 of 62 right and none
  invented; it said it could not tell. In 112 answers it tried a tool that
  was off and was refused ("No such tool available"), which is the same
  finding from the other side: it looks for the detail and has no way to it.
- **Asked about something never said**, the agent with the tool searches the
  archive before saying so (3 calls, 16 s against 13 s). The one answer graded
  wrong says the note names no such person, which is right; the regex wanted
  other words.
- **The summary's ids are used**: of the 95 calls made for dropped details,
  33 were by `ref` (an id or a range the summary cites) and 62 by `query`.
- One of the 216 questions failed with an API error and is not counted.
- One model (haiku), three sessions of one shape, and details of exactly the
  kind a summary drops. It shows the tool works and is not overused, not how
  often real work needs it.
- These sessions' window was small enough (8,000 tokens between trigger and
  limit, less than three notes) that the limit came before the summary was
  done; their compactions took 4 to 6 s each, waiting for it or writing
  it. That is the mod's fallback at work and no part of this result.
