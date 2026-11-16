import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from './gen-listings.mjs';

function fixture() {
  const r = mkdtempSync(join(tmpdir(), 'listings-'));
  mkdirSync(join(r, '.claude-plugin'));
  writeFileSync(join(r, '.claude-plugin', 'marketplace.json'), '{"name":"x","owner":{"name":"o"},"plugins":[]}');
  writeFileSync(join(r, 'README.md'), '# x\n\n<!-- mods:start -->\n<!-- mods:end -->\n\ntail\n');
  for (const [d, desc] of [['b-mod', 'Bee'], ['a-mod', 'Ay']]) {
    mkdirSync(join(r, d, '.claude-plugin'), { recursive: true });
    writeFileSync(join(r, d, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: d, description: desc }));
  }
  return r;
}
const quiet = (fn) => { const o = [console.log, console.error]; console.log = console.error = () => {}; try { return fn(); } finally { [console.log, console.error] = o; } };

test('check detects drift, write fixes it, and write is idempotent', () => {
  const r = fixture();
  assert.equal(quiet(() => main(['--check'], r)), 1);
  quiet(() => main(['--write'], r));
  assert.equal(quiet(() => main(['--check'], r)), 0);
  const snap = readFileSync(join(r, 'README.md'), 'utf8') + readFileSync(join(r, '.claude-plugin', 'marketplace.json'), 'utf8');
  quiet(() => main(['--write'], r));
  assert.equal(readFileSync(join(r, 'README.md'), 'utf8') + readFileSync(join(r, '.claude-plugin', 'marketplace.json'), 'utf8'), snap);
  assert.match(snap, /a-mod[\s\S]*b-mod/);
  assert.match(snap, /"name": "x"/);
});

test('check detects a hand edit after write', () => {
  const r = fixture();
  quiet(() => main(['--write'], r));
  writeFileSync(join(r, 'README.md'), readFileSync(join(r, 'README.md'), 'utf8').replace('Ay', 'Changed'));
  assert.equal(quiet(() => main(['--check'], r)), 1);
});
