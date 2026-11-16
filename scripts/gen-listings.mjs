#!/usr/bin/env node
// Generates the marketplace `plugins` array and the README mod table from each
// mod's .claude-plugin/plugin.json. Usage: gen-listings.mjs --check | --write [--root <dir>]
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const START = '<!-- mods:start -->';
const END = '<!-- mods:end -->';

export function discover(root) {
  const dirs = readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .filter((d) => existsSync(join(root, d, '.claude-plugin', 'plugin.json')));
  // mods.order pins the legacy order; mods not listed follow, sorted by folder name.
  const orderFile = join(root, 'mods.order');
  const pinned = existsSync(orderFile)
    ? readFileSync(orderFile, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean)
    : [];
  const rank = (d) => (pinned.includes(d) ? pinned.indexOf(d) : pinned.length);
  dirs.sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
  return dirs.map((dir) => {
    const p = JSON.parse(readFileSync(join(root, dir, '.claude-plugin', 'plugin.json'), 'utf8'));
    if (!p.name || !p.description) throw new Error(`${dir}: plugin.json needs name and description`);
    return { dir, name: p.name, description: p.description };
  });
}

export function render(root) {
  const mods = discover(root);
  const mpPath = join(root, '.claude-plugin', 'marketplace.json');
  const mp = JSON.parse(readFileSync(mpPath, 'utf8'));
  mp.plugins = mods.map((m) => ({ name: m.name, source: `./${m.dir}`, description: m.description }));
  const marketplace = JSON.stringify(mp, null, 2) + '\n';

  const rows = mods.map((m) => `| [${m.name}](./${m.dir}) | ${m.description.replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|')} |`);
  const table = [START, '| Mod | What it does |', '| --- | --- |', ...rows, END].join('\n');
  const readmePath = join(root, 'README.md');
  const readme = readFileSync(readmePath, 'utf8');
  const s = readme.indexOf(START);
  const e = readme.indexOf(END);
  if (s < 0 || e < s) throw new Error(`README.md needs ${START} and ${END} markers`);
  const newReadme = readme.slice(0, s) + table + readme.slice(e + END.length);
  return [
    { path: mpPath, label: '.claude-plugin/marketplace.json', next: marketplace },
    { path: readmePath, label: 'README.md', next: newReadme },
  ];
}

function summary(cur, next) {
  const a = cur.split('\n'), b = next.split('\n');
  const sa = new Set(a), sb = new Set(b);
  const out = [];
  for (const l of a) if (!sb.has(l)) out.push(`  - ${l.trim().slice(0, 100)}`);
  for (const l of b) if (!sa.has(l)) out.push(`  + ${l.trim().slice(0, 100)}`);
  return out.slice(0, 10).join('\n') || '  (whitespace/order only)';
}

export function main(argv, root) {
  const mode = argv.includes('--write') ? 'write' : argv.includes('--check') ? 'check' : null;
  if (!mode) { console.error('usage: gen-listings.mjs --check | --write'); return 2; }
  let files;
  try { files = render(root); } catch (err) { console.error(`gen-listings: ${err.message}`); return 2; }
  let stale = 0;
  for (const f of files) {
    const cur = readFileSync(f.path, 'utf8');
    if (cur === f.next) continue;
    stale++;
    if (mode === 'write') { writeFileSync(f.path, f.next); console.log(`updated ${f.label}`); }
    else console.error(`${f.label} is out of date:\n${summary(cur, f.next)}`);
  }
  if (mode === 'check' && stale) { console.error('Run: node scripts/gen-listings.mjs --write'); return 1; }
  if (mode === 'check') console.log('listings up to date');
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--root');
  const root = i > 0 ? resolve(process.argv[i + 1]) : resolve(dirname(fileURLToPath(import.meta.url)), '..');
  process.exitCode = main(process.argv.slice(2), root);
}
