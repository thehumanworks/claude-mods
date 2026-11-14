// The evals' command line.
//
//   bun evals/run.ts controls
//   bun evals/run.ts summary --name baseline-x5 --variants baseline --split dev --reps 5
//   bun evals/run.ts report baseline-x5 [--against baseline] [--answers]
//
// `summary` takes --variants a,b  --split dev|held-out|all  --fixtures a,b
// --levels aggressive,balanced,soft  --reps N  --from N (the first repetition's
// number)  --no-refs  --part-chars N.
//
//   bun evals/run.ts rate --name rate-x --variants baseline,default --fixtures long-dev --levels aggressive --reps 20
//
// `rate` writes summaries only and counts the replies that were not one.
// Results are written to evals/results/<name>.json.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LevelName } from '../hooks/config.ts'
import { FIXTURES } from './fixtures.ts'
import { controls, score, summarize, type Scored } from './harness.ts'
import { VARIANTS } from './variants.ts'

const RESULTS = join(import.meta.dir, 'results')
const [command, ...rest] = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const at = rest.indexOf(`--${name}`)
  return at === -1 ? undefined : rest[at + 1]
}
const has = (name: string) => rest.includes(`--${name}`)
const pct = (n: number, of: number) => (of === 0 ? '   –' : `${((100 * n) / of).toFixed(1).padStart(5)}%`)
const mean = (values: number[]) => (values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length)

function chosenFixtures() {
  const names = flag('fixtures')?.split(',')
  const split = flag('split') ?? 'dev'
  return FIXTURES.filter(f => (names ? names.includes(f.name) : split === 'all' || f.split === split))
}

if (command === 'controls') {
  mkdirSync(RESULTS, { recursive: true })
  const out: Record<string, unknown> = {}
  for (const fixture of has('fixtures') || has('split') ? chosenFixtures() : FIXTURES) {
    const result = await controls(fixture)
    if (result === undefined) continue
    out[fixture.name] = result
    const stated = (rows: typeof result.full) => rows.filter(r => r.kind !== 'never-stated')
    const never = (rows: typeof result.full) => rows.filter(r => r.kind === 'never-stated')
    const right = (rows: typeof result.full) => rows.filter(r => r.grade === 'right').length
    console.log(
      `${fixture.name.padEnd(15)} everything in context: ${right(stated(result.full))}/${stated(result.full).length} stated, ${right(never(result.full))}/${never(result.full).length} never-stated` +
        `   nothing in context: ${right(stated(result.empty))}/${stated(result.empty).length} stated, ${right(never(result.empty))}/${never(result.empty).length} never-stated`,
    )
    for (const r of result.full.filter(r => r.grade !== 'right')) console.log(`    with everything, ${r.id} (${r.kind}) ${r.grade}: ${r.answer}`)
    for (const r of stated(result.empty).filter(r => r.grade === 'right')) console.log(`    with nothing, ${r.id} right: ${r.answer}`)
  }
  writeFileSync(join(RESULTS, 'controls.json'), JSON.stringify(out, null, 1))
} else if (command === 'summary') {
  const name = flag('name') ?? `run-${Date.now()}`
  const variants = (flag('variants') ?? 'default').split(',')
  const levels = (flag('levels') ?? flag('level') ?? 'balanced').split(',') as LevelName[]
  const reps = Number(flag('reps') ?? 1)
  const from = Number(flag('from') ?? 0)
  const partChars = flag('part-chars') ? Number(flag('part-chars')) : undefined
  const jobs: Promise<Scored | undefined>[] = []
  for (const variant of variants) {
    const spec = VARIANTS[variant]
    if (spec === undefined) throw new Error(`no variant named ${variant}`)
    for (const fixture of chosenFixtures()) for (const level of levels) {
      for (let rep = from; rep < from + reps; rep++) {
        jobs.push(
          score(fixture, variant, { instructions: spec.prompt, rules: spec.rules, level, refs: !has('no-refs'), rep, partChars }).then(scored => {
            console.error(
              scored === undefined
                ? `  ${variant} ${fixture.name} ${level} #${rep}: failed`
                : scored.fellBack !== undefined
                  ? `  ${variant} ${fixture.name} ${level} #${rep}: no summary (${scored.fellBack})`
                  : `  ${variant} ${fixture.name} ${level} #${rep}: ${scored.words} words, ${scored.probes.filter(p => p.grade === 'right').length}/${scored.probes.length}`,
            )
            return scored
          }),
        )
      }
    }
  }
  const scored = (await Promise.all(jobs)).filter((s): s is Scored => s !== undefined)
  mkdirSync(RESULTS, { recursive: true })
  writeFileSync(join(RESULTS, `${name}.json`), JSON.stringify(scored, null, 1))
  report(scored, variants[0]!)
} else if (command === 'rate') {
  // How often the compaction model's reply is not a summary: summaries only, no probes asked.
  const name = flag('name') ?? 'rate'
  const variants = (flag('variants') ?? 'default').split(',')
  const levels = (flag('levels') ?? 'balanced').split(',') as LevelName[]
  const reps = Number(flag('reps') ?? 20)
  const jobs: Promise<{ variant: string; fixture: string; level: LevelName; rep: number; words: number; rejected: number; fellBack?: string }>[] = []
  for (const variant of variants) {
    const spec = VARIANTS[variant]
    if (spec === undefined) throw new Error(`no variant named ${variant}`)
    for (const fixture of chosenFixtures()) for (const level of levels) {
      for (let rep = 0; rep < reps; rep++) {
        jobs.push(
          summarize(fixture, { instructions: spec.prompt, rules: spec.rules, level, refs: !has('no-refs'), rep }).then(run => {
            const row = { variant, fixture: fixture.name, level, rep, words: 'fellBack' in run ? 0 : run.words, rejected: run.rejected, ...('fellBack' in run ? { fellBack: run.fellBack } : {}) }
            if (row.rejected > 0) console.error(`  ${variant} ${fixture.name} ${level} #${rep}: ${row.rejected} reply(ies) not a summary${row.fellBack ? ', no summary' : ''}`)
            return row
          }),
        )
      }
    }
  }
  const rows = await Promise.all(jobs)
  mkdirSync(RESULTS, { recursive: true })
  writeFileSync(join(RESULTS, `${name}.json`), JSON.stringify(rows, null, 1))
  console.log('\n| variant | fixture @ level | summaries asked for | first reply not a summary | left to Claude Code | words (mean) |')
  console.log('|---|---|---|---|---|---|')
  for (const variant of variants) {
    for (const cell of [...new Set(rows.map(r => `${r.fixture} @ ${r.level}`))]) {
      const mine = rows.filter(r => r.variant === variant && `${r.fixture} @ ${r.level}` === cell)
      console.log(`| ${variant} | ${cell} | ${mine.length} | ${mine.filter(r => r.rejected > 0).length} | ${mine.filter(r => r.fellBack !== undefined).length} | ${Math.round(mean(mine.filter(r => r.fellBack === undefined).map(r => r.words)))} |`)
    }
  }
} else if (command === 'report') {
  const scored = rest.filter(arg => !arg.startsWith('--') && existsSync(join(RESULTS, `${arg}.json`))).flatMap(name => JSON.parse(readFileSync(join(RESULTS, `${name}.json`), 'utf8')) as Scored[])
  report(scored, flag('against') ?? scored[0]?.variant ?? 'baseline')
} else {
  console.log('usage: bun evals/run.ts controls | summary --name <run> [...] | rate --name <run> [...] | report <run>... [--against <variant>] [--answers]')
}

/** Mean rightness of each (fixture, probe) over a variant's repetitions. */
function perProbe(rows: Scored[], keep: (p: Scored['probes'][number]) => boolean): Map<string, number> {
  const sums = new Map<string, { right: number; n: number }>()
  for (const row of rows) {
    for (const probe of row.probes) {
      if (!keep(probe)) continue
      const key = `${row.fixture}@${row.level}/${probe.id}`
      const sum = sums.get(key) ?? { right: 0, n: 0 }
      sum.right += probe.grade === 'right' ? 1 : 0
      sum.n++
      sums.set(key, sum)
    }
  }
  return new Map([...sums].map(([key, sum]) => [key, sum.right / sum.n]))
}

/** The mean paired difference over probes, in points, with a 90% bootstrap interval. */
function paired(a: Map<string, number>, b: Map<string, number>): { diff: number; low: number; high: number; n: number } {
  const diffs = [...a.keys()].filter(key => b.has(key)).map(key => 100 * (a.get(key)! - b.get(key)!))
  let seed = 12345
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed / 2147483648)
  const means: number[] = []
  for (let i = 0; i < 4000; i++) means.push(mean(diffs.map(() => diffs[Math.floor(random() * diffs.length)]!)))
  means.sort((x, y) => x - y)
  return { diff: mean(diffs), low: means[Math.floor(means.length * 0.05)] ?? 0, high: means[Math.floor(means.length * 0.95)] ?? 0, n: diffs.length }
}

function report(all: Scored[], against: string): void {
  const variants = [...new Set(all.map(s => s.variant))]
  // Accuracy is over the summaries that were written; a compaction left to Claude Code is counted beside it.
  const scored = all.filter(s => s.fellBack === undefined)
  const everyRow = (variant: string) => all.filter(s => s.variant === variant)
  const stated = (p: Scored['probes'][number]) => p.kind !== 'never-stated'
  // What the prompt decides: probes the code-appended quotes do not already answer.
  const own = (p: Scored['probes'][number]) => stated(p) && !p.isQuoted
  console.log(`\n| variant | summaries | right, prompt's own | right, as shipped | wrong | unknown | never-stated kept unknown | words (mean / max) | over the limit | not a summary, asked again | left to Claude Code | cite leads to source | unsupported names | compression | seconds |`)
  console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
  for (const variant of variants) {
    const rows = scored.filter(s => s.variant === variant)
    const probes = rows.flatMap(r => r.probes)
    const count = (keep: (p: Scored['probes'][number]) => boolean, g?: string) => probes.filter(p => keep(p) && (g === undefined || p.grade === g)).length
    const cited = probes.filter(p => p.isCiteHit !== undefined)
    console.log(
      `| ${variant} | ${rows.length} | ${pct(count(own, 'right'), count(own))} | ${pct(count(stated, 'right'), count(stated))} | ${pct(count(stated, 'wrong'), count(stated))} | ${pct(count(stated, 'unknown'), count(stated))} | ` +
        `${pct(count(p => !stated(p), 'right'), count(p => !stated(p)))} | ${Math.round(mean(rows.map(r => r.words)))} / ${Math.max(...rows.map(r => r.words))} | ` +
        `${rows.filter(r => r.words > r.maxWords * 1.2 || r.isOverTokens).length} | ${everyRow(variant).some(r => r.rejected !== undefined) ? everyRow(variant).reduce((n, r) => n + (r.rejected ?? 0), 0) : 'not checked'} | ${everyRow(variant).filter(r => r.fellBack !== undefined).length} | ${pct(cited.filter(p => p.isCiteHit).length, cited.length)} | ` +
        `${pct(rows.reduce((n, r) => n + r.unsupported.length, 0), rows.reduce((n, r) => n + r.unsupportedTotal, 0))} | ${mean(rows.map(r => r.renderedChars / r.summaryChars)).toFixed(0)}x | ${mean(rows.map(r => r.seconds)).toFixed(0)} |`,
    )
  }
  const cellOf = (s: Scored) => `${s.fixture} @ ${s.level}`
  const fixtures = [...new Set(scored.map(cellOf))]
  console.log(`\n| variant | ${fixtures.join(' | ')} | per-repetition spread (SD, points) |`)
  console.log(`|---|${fixtures.map(() => '---').join('|')}|---|`)
  for (const variant of variants) {
    const rows = scored.filter(s => s.variant === variant)
    const cells = fixtures.map(fixture => {
      const cell = rows.filter(r => cellOf(r) === fixture)
      const probes = cell.flatMap(r => r.probes).filter(own)
      if (cell.length === 0) return '–'
      return `${pct(probes.filter(p => p.grade === 'right').length, probes.length)}, ${Math.round(mean(cell.map(r => r.words)))} words`
    })
    const reps = [...new Set(rows.map(r => r.rep))].map(rep => {
      const probes = rows.filter(r => r.rep === rep).flatMap(r => r.probes).filter(own)
      return (100 * probes.filter(p => p.grade === 'right').length) / Math.max(1, probes.length)
    })
    const sd = Math.sqrt(mean(reps.map(x => (x - mean(reps)) ** 2)) * (reps.length / Math.max(1, reps.length - 1)))
    console.log(`| ${variant} | ${cells.join(' | ')} | ${reps.length > 1 ? sd.toFixed(1) : '–'} (${reps.map(x => x.toFixed(0)).join(', ')}) |`)
  }
  const kinds = [...new Set(scored.flatMap(s => s.probes.map(p => p.kind)))].filter(kind => kind !== 'never-stated')
  console.log(`\n| right by kind, prompt's own | ${kinds.join(' | ')} |`)
  console.log(`|---|${kinds.map(() => '---').join('|')}|`)
  for (const variant of variants) {
    const probes = scored.filter(s => s.variant === variant).flatMap(r => r.probes).filter(own)
    console.log(`| ${variant} | ${kinds.map(kind => pct(probes.filter(p => p.kind === kind && p.grade === 'right').length, probes.filter(p => p.kind === kind).length)).join(' | ')} |`)
  }
  if (variants.length > 1 && variants.includes(against)) {
    console.log(`\n| against ${against} | prompt's own probes: difference in points (90% interval) | as shipped |`)
    console.log('|---|---|---|')
    const base = scored.filter(s => s.variant === against)
    for (const variant of variants.filter(v => v !== against)) {
      const rows = scored.filter(s => s.variant === variant)
      const a = paired(perProbe(rows, own), perProbe(base, own))
      const b = paired(perProbe(rows, stated), perProbe(base, stated))
      const show = (x: typeof a) => `${x.diff >= 0 ? '+' : ''}${x.diff.toFixed(1)} (${x.low.toFixed(1)} to ${x.high.toFixed(1)}), ${x.n} probes`
      console.log(`| ${variant} | ${show(a)} | ${show(b)} |`)
    }
  }
  if (has('answers')) {
    for (const variant of variants) {
      const rows = scored.filter(s => s.variant === variant)
      const misses = new Map<string, string[]>()
      for (const row of rows) for (const p of row.probes) if (p.grade !== 'right') misses.set(`${row.fixture}/${p.id} (${p.kind}${p.isQuoted ? ', quoted' : ''})`, [...(misses.get(`${row.fixture}/${p.id} (${p.kind}${p.isQuoted ? ', quoted' : ''})`) ?? []), `${p.grade}: ${p.answer.slice(0, 90)}`])
      console.log(`\n${variant}: probes missed`)
      for (const [key, list] of [...misses].sort((x, y) => y[1].length - x[1].length)) console.log(`  ${list.length}x ${key}  e.g. ${list[0]}`)
    }
  }
}
