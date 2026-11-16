import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' });
const gen = (cwd, ...a) => spawnSync('node', ['scripts/gen-listings.mjs', ...a], { cwd, encoding: 'utf8' });

function addMod(r, name) {
  mkdirSync(join(r, name, '.claude-plugin'), { recursive: true });
  writeFileSync(join(r, name, '.claude-plugin', 'plugin.json'), JSON.stringify({ name, description: `Mod ${name}` }));
  assert.equal(gen(r, '--write').status, 0);
  git(r, 'add', '-A'); git(r, 'commit', '-qm', `add ${name}`);
}

test('merge-branch.sh merges two branches that each add a mod', () => {
  const r = mkdtempSync(join(tmpdir(), 'mb-'));
  git(r, 'init', '-q', '-b', 'main');
  git(r, 'config', 'user.email', 't@t'); git(r, 'config', 'user.name', 't');
  mkdirSync(join(r, 'scripts')); mkdirSync(join(r, '.claude-plugin'));
  for (const f of ['gen-listings.mjs', 'merge-branch.sh']) copyFileSync(join(here, f), join(r, 'scripts', f));
  writeFileSync(join(r, '.claude-plugin', 'marketplace.json'), '{"name":"x","owner":{"name":"o"},"plugins":[]}');
  writeFileSync(join(r, 'README.md'), '# x\n\n<!-- mods:start -->\n<!-- mods:end -->\n');
  git(r, 'add', '-A'); git(r, 'commit', '-qm', 'base');
  for (const b of ['one', 'two']) { git(r, 'checkout', '-qb', b, 'main'); addMod(r, `mod-${b}`); }
  git(r, 'checkout', '-q', 'main');

  const run = (b) => spawnSync('bash', ['scripts/merge-branch.sh', b], { cwd: r, encoding: 'utf8' });
  assert.equal(run('one').status, 0);
  const second = run('two');
  assert.equal(second.status, 0, second.stderr);
  assert.equal(git(r, 'status', '--porcelain'), '');
  assert.equal(gen(r, '--check').status, 0);
  assert.match(git(r, 'show', 'HEAD:README.md'), /mod-one[\s\S]*mod-two/);
});

test('merge-branch.sh stops on other conflicts', () => {
  const r = mkdtempSync(join(tmpdir(), 'mb-'));
  git(r, 'init', '-q', '-b', 'main');
  git(r, 'config', 'user.email', 't@t'); git(r, 'config', 'user.name', 't');
  mkdirSync(join(r, 'scripts'));
  copyFileSync(join(here, 'merge-branch.sh'), join(r, 'scripts', 'merge-branch.sh'));
  writeFileSync(join(r, 'f.txt'), 'a\n'); git(r, 'add', '-A'); git(r, 'commit', '-qm', 'base');
  git(r, 'checkout', '-qb', 'x'); writeFileSync(join(r, 'f.txt'), 'x\n'); git(r, 'commit', '-qam', 'x');
  git(r, 'checkout', '-q', 'main'); writeFileSync(join(r, 'f.txt'), 'm\n'); git(r, 'commit', '-qam', 'm');
  const res = spawnSync('bash', ['scripts/merge-branch.sh', 'x'], { cwd: r, encoding: 'utf8' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /f\.txt/);
});

test('merge-branch.sh stops when README text outside the table conflicts, keeps one-sided edits', () => {
  const setup = () => {
    const r = mkdtempSync(join(tmpdir(), 'mb-'));
    git(r, 'init', '-q', '-b', 'main');
    git(r, 'config', 'user.email', 't@t'); git(r, 'config', 'user.name', 't');
    mkdirSync(join(r, 'scripts')); mkdirSync(join(r, '.claude-plugin'));
    for (const f of ['gen-listings.mjs', 'merge-branch.sh']) copyFileSync(join(here, f), join(r, 'scripts', f));
    writeFileSync(join(r, '.claude-plugin', 'marketplace.json'), '{"name":"x","owner":{"name":"o"},"plugins":[]}');
    writeFileSync(join(r, 'README.md'), '# x\n\nintro\n\n<!-- mods:start -->\n<!-- mods:end -->\n');
    git(r, 'add', '-A'); git(r, 'commit', '-qm', 'base');
    git(r, 'checkout', '-qb', 'feat'); addMod(r, 'mod-a');
    return r;
  };
  const edit = (r, text) => {
    const p = join(r, 'README.md');
    writeFileSync(p, readFileSync(p, 'utf8').replace('intro', text));
    git(r, 'commit', '-qam', text);
  };
  const run = (r) => spawnSync('bash', ['scripts/merge-branch.sh', 'feat'], { cwd: r, encoding: 'utf8' });

  // both sides edit the intro differently: stop
  let r = setup(); edit(r, 'theirs intro');
  git(r, 'checkout', '-q', 'main'); addMod(r, 'mod-b'); edit(r, 'ours intro');
  let res = run(r);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /conflicting non-listing edits/);

  // only main edits the intro: our text is kept, mods merged
  r = setup(); git(r, 'checkout', '-q', 'main'); addMod(r, 'mod-b'); edit(r, 'ours intro');
  res = run(r);
  assert.equal(res.status, 0, res.stderr);
  assert.match(readFileSync(join(r, 'README.md'), 'utf8'), /ours intro/);
  assert.equal(gen(r, '--check').status, 0);
});
