// The compaction prompts the evals compare. Each is what the `prompt` setting
// would hold: the mod adds its own rules (length, ids, folding) after it.
// LOG.md says what each was written to test and what came of it.

import { DEFAULT_PROMPT, type Rules } from '../hooks/prompts.ts'

/** The prompt the mod started with, frozen here so "baseline" keeps its meaning as the default moves. */
const BASELINE = `You write the summary that replaces the older part of a conversation between a user and an AI assistant when its context window fills up. Afterwards the assistant sees only your summary followed by the most recent messages, so whatever you leave out is forgotten.

Write from the assistant's point of view ("the user …", "I …"), under these headings:

1. Goal: what the user is trying to achieve and what they asked for.
2. Context: facts, constraints and preferences the user stated.
3. Work so far: what was done, in order, and what came of it. Name files, functions, commands, URLs and values exactly, and include errors met and how they were fixed.
4. Decisions: what was decided and why, including approaches that were rejected.
5. Current state: what was in progress at the end, and what remains to do.
6. Working together: feedback the user gave about how they want me to work.`

/** A reference point: the nine-section layout common to coding assistants' built-in compaction. */
const STOCK = `Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and the assistant's previous actions. The summary should be thorough in capturing technical details, code patterns and architectural decisions that would be essential for continuing the work without losing context.

Your summary should include the following sections:

1. Primary Request and Intent: all of the user's explicit requests and intents, in detail.
2. Key Technical Concepts: the important technical concepts, technologies and frameworks discussed.
3. Files and Code Sections: the files and code sections examined, modified or created, with why each matters and the important snippets.
4. Errors and fixes: the errors run into and how they were fixed, with any feedback from the user about them.
5. Problem Solving: problems solved and any ongoing troubleshooting.
6. All user messages: every user message that is not a tool result.
7. Pending Tasks: the tasks explicitly asked for that are not done yet.
8. Current Work: precisely what was being worked on immediately before this summary, with file names and code where it applies.
9. Optional Next Step: the next step, only if it is directly in line with the user's most recent explicit request.`

const OPENING = `You write the summary that replaces the older part of a conversation between a user and an AI assistant when its context window fills up. Afterwards the assistant sees only your summary followed by the most recent messages, so whatever you leave out is forgotten.`

/** Round 1: the baseline's headings, written as notes that say each thing once. */
const DENSE = `${BASELINE}

Write notes, not prose: short bullets, one fact each, with no introductions and no filler. Say each thing once, under the heading it fits best, and do not repeat it under another. Where an exact token exists (a name, a path, a command, a flag, a number, an id, an error message), write the token, not a description of it.`

/** Round 1: the baseline plus an order of what goes first when the words run out. */
const PRIORITY = `${BASELINE}

When the conversation holds more than the length allows, keep in this order:
1. What the user told me to do or not to do, and how they want me to work, including a short instruction given in passing.
2. Where the work stands now, and everything still open, for every task and not only the latest.
3. What was decided and why, and what was rejected and why.
4. The values things have now: a name, a number, a path, a setting. When one changed along the way, give the latest and say what it replaced.
5. What was found, with its exact names and numbers.
6. How I got there. Leave out first: steps that led nowhere and taught nothing, and routine output.`

/** Round 1: one section per task, since a session often holds several, with the standing instructions pulled out once. */
const TASKS = `${OPENING}

Write from the assistant's point of view ("the user …", "I …"). A session often holds several tasks, one after the other: give each its own section, oldest first, so none is lost behind the latest.

Standing instructions: the rules and preferences the user gave that still apply, about the work and about how to work with them. Each once, here and not again below.

Then for each task:
- Task: what the user asked for, and why if they said.
- Done: what I did and found, in order, with files, functions, commands and values named exactly; errors met and how they were fixed.
- Decided: what was decided and why, including what was rejected and why.
- Open: what is unfinished or still to do, or "nothing".

Current state: exactly what I was doing when the conversation was cut, and the next step.`

/** Round 1: the three ideas together. */
const COMBINED = `${TASKS}

Write notes, not prose: short bullets, one fact each, with no introductions and no filler, and nothing said twice. Where an exact token exists (a name, a path, a command, a flag, a number, an id, an error message), write the token, not a description of it. When a value or a decision changed along the way, give the latest and say what it replaced.

When the conversation holds more than the length allows, leave out first the steps that led nowhere and routine output, then how I got to a result; never a user instruction, an open item, a decision or the current state.`

/** Round 2: an earlier summary is all that is left of what it covers, so its facts are carried over, not summarized again. */
const FOLD =
  'If the conversation starts with an <earlier_summary>, it is all that is left of the messages it covers: carry its content over into your summary, under the task it belongs to. ' +
  'Keep its facts as they are (names, numbers, versions, times, ids), update what later messages changed, and shorten only its wording. Never drop a detail only because it is old.'

/** Round 2: the limit said as a limit, with a second way to gauge it, since a model counts bullets better than words. */
const FIRM_LENGTH = (maxWords: number) =>
  `Length: at most ${maxWords} words, which is about ${Math.round(maxWords / 14)} short bullets. This is a firm limit, not a size to aim near: a conversation that holds more than fits is not a reason to go over it. ` +
  'Spend the words on specifics rather than generalities. When something has to go, drop the least consequential detail first, and never a user instruction, a decision or the current state.'

/** Round 2: instructions given in passing are still instructions. */
const PASSING = COMBINED.replace(
  'Each once, here and not again below.',
  'Include an instruction given in passing, such as a condition attached to an approval. Each once, here and not again below.',
)

/**
 * Round 3, a reference point: the summarization instruction Anthropic's prompting guide gives for compacting on the
 * client ("Tell the model what to preserve in compaction summaries"), adapted in three ways that LOG.md section 10 lists.
 */
const GUIDE = `${OPENING}

Write from the assistant's point of view ("the user …", "I …"). Include what is needed for the conversation to be continued in a new context window without redoing work and without the user having to give a constraint or a piece of context again. Be sure to preserve:
(1) any difficulties or problems that came up, and how they were handled or resolved;
(2) any possibilities, options or approaches that were raised, tried or set aside, and why;
(3) anything that was asked for, decided, agreed, ruled out, or established as a preference, constraint or boundary, stated exactly;
(4) exactly where things stand now: what has been covered, settled or completed so far;
(5) anything still open, unresolved, promised or expected to happen next;
(6) specific details that would be hard to reconstruct (names, numbers, dates, exact wording, links or references), kept exactly.

Be complete on these six and keep everything else concise. Weight the two voices differently: keep what the user said, asked for, shared or established carefully and close to their own words; the assistant's explanations and reasoning can be condensed much further, to what they concluded or produced, as long as nothing in the six items is dropped.`

/** Round 3: `combined` plus the guide's sixth item, aimed at what `combined` loses most: exact values and identifiers out of tool output. */
const COMBINED_EXACT = `${COMBINED}

Details that would be hard to reconstruct are kept exactly, wherever they appeared, a tool's output included: names, numbers, dates, ids, versions, paths, exact wording, links. One that only a command's output showed counts as much as one the user gave.`

/** A compaction prompt, and with `rules` other wordings of the mod's own rules to go with it. */
export type Variant = { prompt: string; rules?: Partial<Rules> }

/** Round 4: what to put back when the level leaves room, which `combined` does not say. */
const COMBINED_ROOM = `${COMBINED}

When the length allows more than you have written, put back first the exact values, names and identifiers that only a tool's output showed, then the instructions the user gave in passing.`

export const VARIANTS: Record<string, Variant> = {
  /** Whatever the mod ships now. */
  default: { prompt: DEFAULT_PROMPT },
  baseline: { prompt: BASELINE },
  stock: { prompt: STOCK },
  dense: { prompt: DENSE },
  priority: { prompt: PRIORITY },
  tasks: { prompt: TASKS },
  combined: { prompt: COMBINED },
  'combined-fold': { prompt: COMBINED, rules: { fold: FOLD } },
  'combined-length': { prompt: COMBINED, rules: { length: FIRM_LENGTH } },
  'combined-passing': { prompt: PASSING },
  guide: { prompt: GUIDE },
  'combined-exact': { prompt: COMBINED_EXACT },
  'combined-room': { prompt: COMBINED_ROOM },
}
