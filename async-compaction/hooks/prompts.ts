// What the compaction model is told. The first part, DEFAULT_PROMPT, is what
// the `prompt` setting replaces; the rules after it are the mod's own and are
// always added, so a custom prompt keeps the level's length limit and the ids.

/**
 * The built-in compaction prompt: what to keep and how to lay it out. Chosen
 * by the evals in ../evals (LOG.md there; it is `combined-room` in
 * variants.ts): one section per task, so an earlier task is not lost behind
 * the latest, notes with exact tokens in place of prose, and what to put back
 * when the level leaves room.
 */
export const DEFAULT_PROMPT = `You write the summary that replaces the older part of a conversation between a user and an AI assistant when its context window fills up. Afterwards the assistant sees only your summary followed by the most recent messages, so whatever you leave out is forgotten.

Write from the assistant's point of view ("the user …", "I …"). A session often holds several tasks, one after the other: give each its own section, oldest first, so none is lost behind the latest.

Standing instructions: the rules and preferences the user gave that still apply, about the work and about how to work with them. Each once, here and not again below.

Then for each task:
- Task: what the user asked for, and why if they said.
- Done: what I did and found, in order, with files, functions, commands and values named exactly; errors met and how they were fixed.
- Decided: what was decided and why, including what was rejected and why.
- Open: what is unfinished or still to do, or "nothing".

Current state: exactly what I was doing when the conversation was cut, and the next step.

Write notes, not prose: short bullets, one fact each, with no introductions and no filler, and nothing said twice. Where an exact token exists (a name, a path, a command, a flag, a number, an id, an error message), write the token, not a description of it. When a value or a decision changed along the way, give the latest and say what it replaced.

When the conversation holds more than the length allows, leave out first the steps that led nowhere and routine output, then how I got to a result; never a user instruction, an open item, a decision or the current state.

When the length allows more than you have written, put back first the exact values, names and identifiers that only a tool's output showed, then the instructions the user gave in passing.`

/**
 * The mod's own rules, added after the instructions whatever they are. The
 * evals pass other wordings of them to compare; the mod itself never does.
 */
export type Rules = {
  length: (maxWords: number) => string
  /** Added when the summarized messages are archived for the recall tool. `hasEarlier`: the conversation opens with an earlier summary. */
  cite: (hasEarlier: boolean) => string
  /** The render cuts long tool inputs and outputs; the compaction model must not take the cut for the tool's own. */
  clip: string
  /** Added only when the conversation opens with an earlier summary: told about one that is not there, the model writes about it. */
  fold: string
  output: string
}

export const RULES: Rules = {
  length: maxWords =>
    `Length: at most ${maxWords} words. Spend them on specifics rather than generalities. When something has to go, drop the least consequential detail first, and never a user instruction, a decision or the current state.`,
  cite: hasEarlier =>
    'Each line of the conversation opens with the id of its message, like [m412]. After a statement that rests on a specific message (a fact, a value, a decision, a piece of work), ' +
    'cite that message in the same brackets, like [m412], or several, like [m412][m431]. The assistant can read a cited message back word for word, ' +
    'so for long output cite the message that holds it rather than copying it out. ' +
    (hasEarlier ? 'Copy ids exactly, never make one up, and keep the ids an <earlier_summary> already has.' : 'Copy ids exactly and never make one up.'),
  clip:
    'Long tool inputs and outputs are shortened here, with a mark like "… [2400 characters left out] …" where text was taken out. ' +
    'The assistant saw them whole at the time: never describe them as truncated or incomplete, and do not mention the marks.',
  fold: 'If the conversation starts with an <earlier_summary>, fold it in: keep everything in it that is still true, update what changed, and never drop a detail only because it is old.',
  output: 'Do not invent anything, do not address the user and do not continue the conversation. Output only the summary.',
}

/** The compaction model's system prompt: the instructions, then the mod's own rules. */
export function systemPrompt(instructions: string, options: { maxWords: number; refs: boolean; hasEarlier: boolean; rules?: Partial<Rules> }): string {
  const rules = { ...RULES, ...options.rules }
  const { hasEarlier } = options
  return [instructions.trim() || DEFAULT_PROMPT, rules.length(options.maxWords), options.refs ? rules.cite(hasEarlier) : '', rules.clip, hasEarlier ? rules.fold : '', rules.output]
    .filter(part => part !== '')
    .join('\n\n')
}

/** The one user message the compaction model answers. `part` when the conversation is summarized in several parts. */
export function summaryRequest(transcript: string, options: { focus?: string; part?: { index: number; of: number } } = {}): string {
  const { focus, part } = options
  return (
    (part === undefined
      ? 'Here is the earlier part of a conversation between a user and an AI assistant. Write the summary as instructed.'
      : `Here is part ${part.index} of ${part.of} of the earlier conversation between a user and an AI assistant, split because it is long. ` +
        'Write the summary of this part as instructed; the parts are merged afterwards.') +
    (focus ? `\n\nThe user asked this summary to focus on: ${focus}` : '') +
    `\n\n<conversation>\n${transcript}\n</conversation>`
  )
}

/** The request that merges the summaries of consecutive parts into one. */
export function mergeRequest(partials: readonly string[], focus?: string): string {
  const parts = partials.map((text, i) => `<part_summary index="${i + 1}">\n${text.trim()}\n</part_summary>`).join('\n\n')
  return (
    `Here are summaries of ${partials.length} consecutive parts of one earlier conversation between a user and an AI assistant, oldest first. ` +
    'Merge them into the one summary, as instructed: where parts disagree the later one is the current truth, and the current state is the last part\'s. ' +
    'Keep the bracketed ids on the statements you keep.' +
    (focus ? `\n\nThe user asked this summary to focus on: ${focus}` : '') +
    `\n\n${parts}`
  )
}
