// The recall eval: after the mod has compacted a real session, does the agent
// reach for the recall tool when the summary falls short, and only then?
//
//   bun evals/recall.ts make [--only a,b]     three sessions, each compacted by the mod while it runs
//   bun evals/recall.ts probe [--reps N]      every question put to each session, with the tool and without
//   bun evals/recall.ts report [--answers]
//
// A session is a `claude -p` child with the mod loaded and a small auto-compact
// window. It reads twelve generated notes one at a time and says each one's key
// fact; the mod summarizes in the background and swaps the summary in when the
// window fills (or writes it at that moment, when the session got there first). Each question is then asked of the session as compaction left
// it (`--resume`, nothing saved), so every question starts from the same state.
//
// Where a question's answer sits decides what the agent should do:
//   summary   in the summary             answer from it, no recall
//   tail      in the messages kept raw   answer from them, no recall
//   dropped   only in what was archived  recall, then answer
//   never     nowhere                    say so
// The notes are deleted and the file tools are taken away before the questions,
// so the archive is the only way back to a dropped detail: that is the case the
// tool exists for (a command's output, a page, the user's own words).

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { RECALL_TOOL_NAME, SUMMARY_PREFACE, summaryBody, wordCount } from '../hooks/transcript.ts'
import { NOUNS, pick, prose, rng } from './filler.ts'

const MODEL = process.env.EVAL_MODEL ?? 'haiku'
const CONCURRENCY = Number(process.env.EVAL_CONCURRENCY ?? 4)
const MOD = join(import.meta.dir, '..')
const RESULTS = join(import.meta.dir, 'results')
const SESSIONS_FILE = join(RESULTS, 'recall-sessions.json')
const ANSWERS_FILE = join(RESULTS, 'recall.json')
const WORK = join(tmpdir(), 'async-compaction-evals', 'recall')
const PARTS = 12
/** The auto-compact window of a session: 40% of 100k tokens, which twelve notes of 3k tokens fill once or twice. */
const WINDOW = { autocompact: '100k', percent: '40' }
/** The tools that could read the notes again; `make` deletes the notes as well. */
// Everything else that could reach the notes or the transcript on disk is off in both arms, a subagent and any
// other plugin's search over past sessions included: the recall arm differs from the other by the recall tool alone.
const FILE_TOOLS = [
  'Read', 'Bash', 'Grep', 'Glob', 'Write', 'Edit', 'NotebookEdit', 'Agent', 'Task', 'Skill', 'ToolSearch', 'WebSearch', 'WebFetch', 'Workflow', 'Monitor',
  'SendMessage', 'mcp__recall__search', 'mcp__recall__read',
]

const [command, ...rest] = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const at = rest.indexOf(`--${name}`)
  return at === -1 ? undefined : rest[at + 1]
}
const has = (name: string) => rest.includes(`--${name}`)

// The notes.

type Fact = {
  id: string
  /** key: the note's headline, which the agent repeats. detail: a line in the body. task: a detail asked for as a piece of work. */
  kind: 'key' | 'detail' | 'task' | 'never'
  q: string
  accept: RegExp
}
type Scenario = { name: string; notes: string[]; facts: Fact[] }

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const pad2 = (n: number) => String(n).padStart(2, '0')
/** What an honest "the notes never said" looks like. */
const NOT_STATED =
  /\bnot (?:stated|mentioned|given|specified|included|covered|recorded|documented|provided|available|listed|something)|\bno (?:mention|record|information|such|details?|data)\b|\b(?:do|did|does)(?: not|n['’]t) (?:have|see|know|say|mention|state|specify|include|appear|contain|give|list|cover|record)|\bunknown\b|\b(?:can(?:not|['’]t)|could(?: not|n['’]t)|unable to|wasn['’]t able to) (?:find|tell|determine|locate|answer|confirm)|\bnever (?:stated|mentioned|given|said|specified)|\bnothing (?:about|on|in)\b|\bisn['’]t (?:stated|mentioned|given|in|something|recorded|covered)/i

/** One note: a headline fact, two details and a near-miss of one of them, in nine thousand characters of filler. */
function note(title: string, topic: string, seed: number, lines: { key: string; detail: string; nearMiss: string; task: string }): string {
  const r = rng(seed)
  const paragraphs = Array.from({ length: 12 }, (_, i) => prose(seed * 31 + i, 7, topic))
  const into = (at: number, sentence: string) => {
    const sentences = paragraphs[at]!.split('. ')
    sentences.splice(1 + Math.floor(r() * (sentences.length - 2)), 0, sentence.replace(/\.$/, ''))
    paragraphs[at] = sentences.join('. ')
  }
  const detailAt = 4 + Math.floor(r() * 3)
  into(detailAt, lines.detail)
  into(detailAt === 8 ? 9 : 8, lines.nearMiss)
  paragraphs.splice(9 + Math.floor(r() * 2), 0, lines.task)
  paragraphs.splice(1 + Math.floor(r() * 3), 0, lines.key)
  return `# ${title}\n\n${paragraphs.join('\n\n')}\n`
}

function services(seed: number): Scenario {
  const r = rng(seed)
  const names = ['ledger-sync', 'quota-gate', 'mail-relay', 'thumb-cache', 'geo-index', 'audit-sink', 'cart-merge', 'token-mint', 'feed-rank', 'blob-sweep', 'rate-shaper', 'doc-render']
  const pools = ['amber', 'birch', 'cedar', 'dune', 'ember', 'flint']
  const facts: Fact[] = []
  const notes = names.map((svc, i) => {
    const start = `${pad2(1 + i)}:${pick(r, ['10', '20', '40', '50'])}`
    const end = `${pad2(2 + i)}:${pick(r, ['05', '15', '35', '55'])}`
    const alias = `oncall-${pick(r, NOUNS)}-${100 + Math.floor(r() * 900)}`
    const grace = 15 + Math.floor(r() * 80)
    const pool = `pool-${pick(r, pools)}-${1 + Math.floor(r() * 8)}`
    facts.push(
      { id: `${svc}/window`, kind: 'key', q: `Between which times (UTC) must ${svc} never be restarted?`, accept: new RegExp(escape(start)) },
      { id: `${svc}/alias`, kind: 'detail', q: `What is the escalation alias for ${svc}?`, accept: new RegExp(escape(alias)) },
      { id: `${svc}/drain`, kind: 'task', q: `Give me the exact command to drain ${svc} safely.`, accept: new RegExp(`${svc}\\s+--grace ${grace}s\\s+--pool ${escape(pool)}`) },
    )
    return note(`Runbook: ${svc}`, 'the runbook', seed * 100 + i, {
      key: `KEY FACT: ${svc} must never be restarted between ${start} and ${end} UTC, while its nightly batch runs.`,
      detail: `The escalation alias for ${svc} is ${alias}.`,
      nearMiss: `The older alias oncall-${pick(r, NOUNS)}-${1000 + Math.floor(r() * 900)} was retired last year and pages nobody.`,
      task: `To drain ${svc} safely, run: svcctl drain ${svc} --grace ${grace}s --pool ${pool}`,
    })
  })
  facts.push(
    { id: 'never/budget', kind: 'never', q: `What is the monthly cloud budget for ${names[1]}?`, accept: NOT_STATED },
    { id: 'never/author', kind: 'never', q: `Which team originally wrote ${names[4]}?`, accept: NOT_STATED },
    { id: 'never/latency', kind: 'never', q: `What is the p99 latency target for ${names[7]}?`, accept: NOT_STATED },
  )
  return { name: 'services', notes, facts }
}

function vendors(seed: number): Scenario {
  const r = rng(seed)
  const names = ['Norvale Freight', 'Kestrel Print', 'Ombra Cloud', 'Tallis Catering', 'Verdane Legal', 'Pikeworth Security', 'Lumen Fleet', 'Harrow Paper', 'Ostley Telecom', 'Quenby Translation', 'Brackmoor Storage', 'Sable Analytics']
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
  const firsts = ['Ines', 'Tobias', 'Marit', 'Dario', 'Solveig', 'Anselm', 'Petra', 'Ruben', 'Livia', 'Casimir', 'Odile', 'Fenn']
  const lasts = ['Varga', 'Lindqvist', 'Okafor', 'Brandl', 'Castellan', 'Moreau', 'Hartwell', 'Szabo', 'Ferreira', 'Dunmore', 'Achterberg', 'Islington']
  const formers = ['Halloran', 'Petrakis', 'Vandermeer', 'Oyelaran', 'Krantz', 'Belmonte', 'Thackeray', 'Nakagawa', 'Lowenthal', 'Abernethy', 'Zielinski', 'Marchetti']
  const facts: Fact[] = []
  const notes = names.map((vendor, i) => {
    const day = 2 + ((i * 7 + Math.floor(r() * 3)) % 26)
    const month = months[(i * 5 + 2) % 12]!
    const last = lasts[i]!
    const po = `PO-${10000 + Math.floor(r() * 89999)}`
    const centre = `CC-${100 + Math.floor(r() * 899)}`
    facts.push(
      { id: `${vendor}/renewal`, kind: 'key', q: `On what date does the contract with ${vendor} renew automatically?`, accept: new RegExp(`\\b${day}(?:st|nd|rd|th)?(?: of)? ${month}|${month} ${day}(?:st|nd|rd|th)?\\b`) },
      { id: `${vendor}/manager`, kind: 'detail', q: `Who is the account manager at ${vendor}?`, accept: new RegExp(last) },
      { id: `${vendor}/invoice`, kind: 'task', q: `Write the reference line an invoice from ${vendor} must carry: the purchase order and the cost centre.`, accept: new RegExp(`${po}[\\s\\S]*${centre}|${centre}[\\s\\S]*${po}`) },
    )
    return note(`Supplier file: ${vendor}`, 'the supplier file', seed * 100 + i, {
      key: `KEY FACT: the contract with ${vendor} renews automatically on ${day} ${month} 2027 unless it is cancelled in writing.`,
      detail: `The account manager at ${vendor} is ${firsts[i]} ${last}.`,
      nearMiss: `${firsts[(i + 5) % 12]} ${formers[i]} managed the account until 2024 and has since left ${vendor}.`,
      task: `Every invoice from ${vendor} must quote purchase order ${po} and cost centre ${centre}.`,
    })
  })
  facts.push(
    { id: 'never/penalty', kind: 'never', q: `What is the late-payment penalty rate in the contract with ${names[2]}?`, accept: NOT_STATED },
    { id: 'never/city', kind: 'never', q: `In which city is ${names[5]} headquartered?`, accept: NOT_STATED },
    { id: 'never/discount', kind: 'never', q: `What discount did ${names[9]} offer for a three-year term?`, accept: NOT_STATED },
  )
  return { name: 'vendors', notes, facts }
}

function instruments(seed: number): Scenario {
  const r = rng(seed)
  const names = ['Halden centrifuge', 'Orrin spectrometer', 'Vesper autoclave', 'Tarn incubator', 'Lyle sequencer', 'Merrow microscope', 'Castell freezer', 'Brandt titrator', 'Elsin shaker', 'Quoyle pipetting robot', 'Rooke plate reader', 'Sennet fume hood']
  const spares = ['rotor seal', 'lamp', 'door gasket', 'filter', 'drive belt', 'lens cap', 'fuse', 'nozzle', 'sensor', 'valve', 'tray', 'fan']
  const solvents = ['ethanol', 'isopropanol', 'acetone', 'deionised-water', 'methanol']
  const facts: Fact[] = []
  const notes = names.map((name, i) => {
    const slug = name.split(' ')[0]!.toLowerCase()
    const runs = 12 + i * 7 + Math.floor(r() * 5)
    const cabinet = `${pick(r, [...'BCDEFGH'])}${10 + Math.floor(r() * 89)}`
    const solvent = pick(r, solvents)
    const minutes = 5 + Math.floor(r() * 40)
    facts.push(
      { id: `${slug}/recalibration`, kind: 'key', q: `After how many runs must the ${name} be recalibrated?`, accept: new RegExp(`\\b${runs}\\b`) },
      { id: `${slug}/spare`, kind: 'detail', q: `In which cabinet is the spare ${spares[i]} for the ${name} kept?`, accept: new RegExp(`\\b${cabinet}\\b`) },
      { id: `${slug}/cleaning`, kind: 'task', q: `Write the exact command that starts the cleaning cycle of the ${name}.`, accept: new RegExp(`${slug}\\s+--solvent ${solvent}\\s+--minutes ${minutes}\\b`) },
    )
    return note(`Protocol: the ${name}`, 'the protocol', seed * 100 + i, {
      key: `KEY FACT: the ${name} must be recalibrated after every ${runs} runs.`,
      detail: `The spare ${spares[i]} for the ${name} is kept in cabinet ${cabinet}, shelf ${1 + Math.floor(r() * 6)}.`,
      nearMiss: `Cabinet A${10 + Math.floor(r() * 89)} held the spares before the move and stands empty now.`,
      task: `Its cleaning cycle is started with: labctl clean ${slug} --solvent ${solvent} --minutes ${minutes}`,
    })
  })
  facts.push(
    { id: 'never/price', kind: 'never', q: `What did the ${names[0]} cost to buy?`, accept: NOT_STATED },
    { id: 'never/officer', kind: 'never', q: `Who is the named safety officer for the ${names[3]}?`, accept: NOT_STATED },
    { id: 'never/serial', kind: 'never', q: `What is the serial number of the ${names[6]}?`, accept: NOT_STATED },
  )
  return { name: 'instruments', notes, facts }
}

const SCENARIOS: Scenario[] = [services(11), vendors(12), instruments(13)]

// Child sessions.

type Child = { result: string; isError: boolean; tools: { name: string; input: unknown }[]; turns: number; seconds: number; costUsd: number }

let running = 0
const waiting: (() => void)[] = []
async function slot<T>(work: () => Promise<T>): Promise<T> {
  if (running >= CONCURRENCY) await new Promise<void>(resolve => waiting.push(resolve))
  running++
  try {
    return await work()
  } finally {
    running--
    waiting.shift()?.()
  }
}

/** One `claude -p` run with the mod loaded, the prompt on stdin. */
async function child(cwd: string, prompt: string, args: string[], timeoutMs: number): Promise<Child> {
  const started = Date.now()
  const proc = Bun.spawn(
    [
      'claude', '-p', '--model', MODEL, '--autocompact', WINDOW.autocompact, '--plugin-dir', MOD, '--setting-sources', 'project,local', '--strict-mcp-config',
      '--permission-mode', 'bypassPermissions', '--output-format', 'stream-json', '--verbose', ...args,
    ],
    { cwd, stdin: new Blob([prompt]), stdout: 'pipe', stderr: 'pipe', env: { ...process.env, CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: WINDOW.percent } },
  )
  const timer = setTimeout(() => proc.kill(), timeoutMs)
  const out = await new Response(proc.stdout).text()
  await proc.exited
  clearTimeout(timer)
  const run: Child = { result: '', isError: true, tools: [], turns: 0, seconds: (Date.now() - started) / 1000, costUsd: 0 }
  for (const line of out.split('\n')) {
    if (line.trim() === '') continue
    let event: Record<string, unknown>
    try {
      event = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (event.type === 'assistant') {
      const content = (event.message as { content?: unknown } | undefined)?.content
      for (const block of Array.isArray(content) ? (content as Record<string, unknown>[]) : []) {
        if (block.type === 'tool_use') run.tools.push({ name: String(block.name), input: block.input })
      }
    } else if (event.type === 'result') {
      run.result = typeof event.result === 'string' ? event.result : ''
      run.isError = event.is_error === true || typeof event.result !== 'string'
      run.turns = Number(event.num_turns ?? 0)
      run.costUsd = Number(event.total_cost_usd ?? 0)
    }
  }
  return run
}

// What compaction left of a session.

type Where = 'summary' | 'tail' | 'dropped' | 'never'
type Session = {
  name: string
  sid: string
  cwd: string
  compactions: number
  /** Whether the summary in context is the mod's, with its pointer to the recall tool. */
  isMods: boolean
  summaryWords: number
  tailChars: number
  where: Record<string, Where>
  /** Dropped facts the archive does not hold either: the tool could not find these. */
  notArchived: string[]
  summary: string
}

/** Every string inside a JSON value, one per line. */
function strings(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(strings).join('\n')
  if (value !== null && typeof value === 'object') return Object.values(value).map(strings).join('\n')
  return ''
}

function transcriptOf(sid: string): string | undefined {
  const projects = join(homedir(), '.claude', 'projects')
  for (const dir of readdirSync(projects)) {
    const file = join(projects, dir, `${sid}.jsonl`)
    if (existsSync(file)) return file
  }
  return undefined
}

function inspect(scenario: Scenario, sid: string, cwd: string): Session {
  const file = transcriptOf(sid)
  if (file === undefined) throw new Error(`no transcript for ${sid}`)
  const rows = readFileSync(file, 'utf8')
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => JSON.parse(line) as Record<string, unknown>)
    .filter(row => row.type === 'user' || row.type === 'assistant' || row.type === 'system')
  const boundaries = rows.flatMap((row, i) => (row.subtype === 'compact_boundary' ? [i] : []))
  if (boundaries.length === 0) throw new Error(`${scenario.name}: the session was never compacted`)
  const after = rows.slice(boundaries.at(-1)! + 1)
  const first = strings((after[0]?.message as { content?: unknown } | undefined)?.content)
  if (!first.startsWith(SUMMARY_PREFACE)) throw new Error(`${scenario.name}: no summary after the last compaction`)
  const summary = summaryBody(first)
  const tail = after.slice(1).map(row => strings((row.message as { content?: unknown } | undefined)?.content)).join('\n')
  const archiveDir = join(homedir(), '.claude', 'async-compaction', sid)
  const archive = existsSync(archiveDir)
    ? readdirSync(archiveDir).map(name => strings(JSON.parse(readFileSync(join(archiveDir, name), 'utf8')))).join('\n')
    : ''
  const where: Record<string, Where> = {}
  const notArchived: string[] = []
  for (const fact of scenario.facts) {
    where[fact.id] = fact.kind === 'never' ? 'never' : fact.accept.test(summary) ? 'summary' : fact.accept.test(tail) ? 'tail' : 'dropped'
    if (where[fact.id] === 'dropped' && !fact.accept.test(archive)) notArchived.push(fact.id)
  }
  return {
    name: scenario.name,
    sid,
    cwd,
    compactions: boundaries.length,
    isMods: first.includes(RECALL_TOOL_NAME),
    summaryWords: wordCount(summary.split("\n## The user's own words")[0]!),
    tailChars: tail.length,
    where,
    notArchived,
    summary,
  }
}

const count = <T>(items: readonly T[], keep: (item: T) => boolean) => items.filter(keep).length
const pct = (n: number, of: number) => (of === 0 ? '–' : `${((100 * n) / of).toFixed(0)}% (${n}/${of})`)
const mean = (values: number[]) => (values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length)

type Answered = {
  session: string
  probe: string
  kind: Fact['kind']
  where: Where
  arm: 'recall' | 'no-recall'
  rep: number
  isRight: boolean
  recalls: number
  recallInputs: unknown[]
  otherTools: string[]
  turns: number
  seconds: number
  costUsd: number
  answer: string
}

if (command === 'make') {
  mkdirSync(RESULTS, { recursive: true })
  const only = flag('only')?.split(',')
  const kept: Session[] = existsSync(SESSIONS_FILE) ? (JSON.parse(readFileSync(SESSIONS_FILE, 'utf8')) as Session[]) : []
  const made = await Promise.all(
    SCENARIOS.filter(s => only === undefined || only.includes(s.name)).map(async scenario => {
      const cwd = join(WORK, scenario.name)
      rmSync(cwd, { recursive: true, force: true })
      mkdirSync(join(cwd, 'notes'), { recursive: true })
      scenario.notes.forEach((text, i) => writeFileSync(join(cwd, 'notes', `part${i + 1}.md`), text))
      const sid = crypto.randomUUID()
      const run = await child(
        cwd,
        `Work through notes/part1.md to notes/part${PARTS}.md strictly one file at a time. For each file: Read it in full, then tell me its KEY FACT in one sentence, ` +
          `then go on to the next file. Never read two files in one step. When all ${PARTS} are done, reply with the single word DONE.`,
        ['--session-id', sid, '--allowedTools', 'Read'],
        20 * 60_000,
      )
      // From here on only the summary, the raw tail and the archive hold what the notes said.
      rmSync(join(cwd, 'notes'), { recursive: true, force: true })
      if (run.isError) throw new Error(`${scenario.name}: the session failed: ${run.result.slice(0, 200)}`)
      const session = inspect(scenario, sid, cwd)
      const places = Object.values(session.where)
      console.log(
        `${scenario.name}: ${session.compactions} compaction(s), summary of ${session.summaryWords} words${session.isMods ? '' : " (NOT the mod's)"}, ` +
          `${count(places, w => w === 'summary')} facts in the summary, ${count(places, w => w === 'tail')} in the raw tail, ${count(places, w => w === 'dropped')} dropped` +
          `${session.notArchived.length > 0 ? ` (${session.notArchived.length} of them not in the archive)` : ''}, ${Math.round(run.seconds)}s`,
      )
      return session
    }),
  )
  writeFileSync(SESSIONS_FILE, JSON.stringify([...kept.filter(k => !made.some(m => m.name === k.name)), ...made], null, 1))
} else if (command === 'probe') {
  const sessions = JSON.parse(readFileSync(SESSIONS_FILE, 'utf8')) as Session[]
  const reps = Number(flag('reps') ?? 1)
  const done: Answered[] = existsSync(ANSWERS_FILE) ? (JSON.parse(readFileSync(ANSWERS_FILE, 'utf8')) as Answered[]) : []
  const jobs: Promise<void>[] = []
  for (const session of sessions) {
    const scenario = SCENARIOS.find(s => s.name === session.name)!
    for (const fact of scenario.facts) for (const arm of ['recall', 'no-recall'] as const) {
      for (let rep = 0; rep < reps; rep++) {
        if (done.some(d => d.session === session.name && d.probe === fact.id && d.arm === arm && d.rep === rep)) continue
        jobs.push(
          slot(async () => {
            const run = await child(
              session.cwd,
              fact.q,
              ['--resume', session.sid, '--no-session-persistence', '--disallowedTools', [...FILE_TOOLS, ...(arm === 'recall' ? [] : [RECALL_TOOL_NAME])].join(',')],
              5 * 60_000,
            )
            if (run.isError) return console.error(`  ${session.name} ${fact.id} ${arm}: failed: ${run.result.slice(0, 120)}`)
            const recalls = run.tools.filter(t => t.name === RECALL_TOOL_NAME)
            done.push({
              session: session.name,
              probe: fact.id,
              kind: fact.kind,
              where: session.where[fact.id]!,
              arm,
              rep,
              isRight: fact.accept.test(run.result),
              recalls: recalls.length,
              recallInputs: recalls.map(t => t.input),
              otherTools: run.tools.filter(t => t.name !== RECALL_TOOL_NAME).map(t => t.name),
              turns: run.turns,
              seconds: Math.round(run.seconds * 10) / 10,
              costUsd: run.costUsd,
              // Without the machine's own temporary folder, which an answer now and then spells out.
              answer: run.result.replace(/\/\S*?async-compaction-evals\/recall\/[\w-]+/g, '.'),
            })
            writeFileSync(ANSWERS_FILE, JSON.stringify(done, null, 1))
            const last = done.at(-1)!
            console.error(`  ${session.name} ${fact.id} [${last.where}] ${arm}: ${last.isRight ? 'right' : 'WRONG'}, ${last.recalls} recall(s)`)
          }),
        )
      }
    }
  }
  await Promise.all(jobs)
  report(done)
} else if (command === 'report') {
  report(JSON.parse(readFileSync(ANSWERS_FILE, 'utf8')) as Answered[])
} else {
  console.log('usage: bun evals/recall.ts make [--only a,b] | probe [--reps N] | report [--answers]')
}

function report(rows: Answered[]): void {
  if (existsSync(SESSIONS_FILE)) {
    console.log('\n| session | compactions | summary (words) | facts in the summary | in the raw tail | dropped | never stated |')
    console.log('|---|---|---|---|---|---|---|')
    for (const s of JSON.parse(readFileSync(SESSIONS_FILE, 'utf8')) as Session[]) {
      const places = Object.values(s.where)
      console.log(`| ${s.name} | ${s.compactions} | ${s.summaryWords} | ${count(places, w => w === 'summary')} | ${count(places, w => w === 'tail')} | ${count(places, w => w === 'dropped')} | ${count(places, w => w === 'never')} |`)
    }
  }
  const table = (title: string, groups: [string, (r: Answered) => boolean][]) => {
    console.log(`\n| ${title} | questions | right with the tool | recalled | calls when it did | seconds | right without the tool | seconds |`)
    console.log('|---|---|---|---|---|---|---|---|')
    for (const [label, keep] of groups) {
      const on = rows.filter(r => keep(r) && r.arm === 'recall')
      const off = rows.filter(r => keep(r) && r.arm === 'no-recall')
      if (on.length + off.length === 0) continue
      const used = on.filter(r => r.recalls > 0)
      console.log(
        `| ${label} | ${on.length} | ${pct(count(on, r => r.isRight), on.length)} | ${pct(used.length, on.length)} | ${used.length > 0 ? mean(used.map(r => r.recalls)).toFixed(1) : '–'} | ` +
          `${mean(on.map(r => r.seconds)).toFixed(0)} | ${pct(count(off, r => r.isRight), off.length)} | ${mean(off.map(r => r.seconds)).toFixed(0)} |`,
      )
    }
  }
  table('where the answer is', [
    ['in the summary', r => r.where === 'summary'],
    ['in the raw tail', r => r.where === 'tail'],
    ['dropped (archive only)', r => r.where === 'dropped'],
    ['never stated', r => r.where === 'never'],
  ])
  table('dropped, by kind of question', [
    ['the headline fact', r => r.where === 'dropped' && r.kind === 'key'],
    ['a detail, asked as a question', r => r.where === 'dropped' && r.kind === 'detail'],
    ['a detail, asked as a task', r => r.where === 'dropped' && r.kind === 'task'],
  ])
  table('dropped, by session', [...new Set(rows.map(r => r.session))].map(name => [name, (r: Answered) => r.where === 'dropped' && r.session === name]))

  const of = (where: Where, arm: Answered['arm']) => rows.filter(r => r.where === where && r.arm === arm)
  const droppedOn = of('dropped', 'recall')
  const droppedOff = of('dropped', 'no-recall')
  const kept = [...of('summary', 'recall'), ...of('tail', 'recall')]
  const withTool = (100 * count(droppedOn, r => r.isRight)) / Math.max(1, droppedOn.length)
  const without = (100 * count(droppedOff, r => r.isRight)) / Math.max(1, droppedOff.length)
  const needless = (100 * count(kept, r => r.recalls > 0)) / Math.max(1, kept.length)
  console.log(
    `\nThe rule: dropped details right with the tool at least 80% (${withTool.toFixed(0)}%), at least 30 points above without it (${without.toFixed(0)}%), ` +
      `and a recall on at most 15% of the questions the context already answers (${needless.toFixed(0)}%): ` +
      `${withTool >= 80 && withTool - without >= 30 && needless <= 15 ? 'APPROVE' : 'REJECT'}`,
  )
  const strays = rows.filter(r => r.otherTools.length > 0)
  // Claude Code refuses a call to a tool that is off ("No such tool available"), so these are attempts, not reads.
  console.log(`Answers in which a tool that is off in both arms was tried, and refused: ${strays.length}${strays.length > 0 ? ` (${[...new Set(strays.flatMap(r => r.otherTools))].join(', ')})` : ''}`)
  if (has('answers')) {
    for (const r of rows.filter(r => r.arm === 'recall' && (!r.isRight || (r.recalls > 0 && (r.where === 'summary' || r.where === 'tail'))))) {
      console.log(`\n${r.session} ${r.probe} [${r.where}] ${r.isRight ? 'right' : 'WRONG'}, ${r.recalls} recall(s) ${JSON.stringify(r.recallInputs)}\n  ${r.answer.replace(/\s+/g, ' ').slice(0, 300)}`)
    }
  }
}
