import './site-nonet.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURE_ROOT, loadFixtureDir } from '../scripts/lib/site/pipeline.mjs';

function sandbox(t) {
  const base = mkdtempSync(join(tmpdir(), 'site-fixture-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'root');
  mkdirSync(join(root, 'set'), { recursive: true });
  mkdirSync(join(root, 'pages'));
  writeFileSync(join(root, 'set', 'overpass.json'), '{"elements":[]}');
  writeFileSync(join(root, 'pages', 'ok.html'), '<p>ok</p>');
  writeFileSync(join(base, 'secret.txt'), 'outside the root');
  const pages = value => writeFileSync(join(root, 'set', 'pages.json'), JSON.stringify(value));
  return { base, root, pages };
}

test('the default root is the repo fixtures directory, and the shipped job set loads', () => {
  assert.match(FIXTURE_ROOT.replaceAll('\\', '/'), /tests\/fixtures\/site$/);
  const f = loadFixtureDir('job');
  assert.ok(Object.keys(f.pageHtml).length > 0);
});

test('a fixture name inside an injected root loads, pages may use .. while staying inside the root', t => {
  const s = sandbox(t);
  s.pages({ 'https://a.example/': '../pages/ok.html' });
  const f = loadFixtureDir('set', { root: s.root });
  assert.equal(f.pageHtml['https://a.example/'], '<p>ok</p>');
});

test('an absolute fixture path or one that climbs out of the root is refused', t => {
  const s = sandbox(t);
  s.pages({});
  assert.throws(() => loadFixtureDir(join(s.root, 'set'), { root: s.root }), /absolute/);
  assert.throws(() => loadFixtureDir('../', { root: s.root }), /outside/);
  assert.throws(() => loadFixtureDir('set/../..', { root: s.root }), /outside/);
  assert.throws(() => loadFixtureDir('/etc'), /absolute/);
});

test('pages.json cannot name a file outside the root, absolutely, by .., or through a symlink', t => {
  const s = sandbox(t);
  s.pages({ 'https://a.example/': join(s.base, 'secret.txt') });
  assert.throws(() => loadFixtureDir('set', { root: s.root }), /absolute/);
  s.pages({ 'https://a.example/': '../../secret.txt' });
  assert.throws(() => loadFixtureDir('set', { root: s.root }), /outside/);
  symlinkSync(join(s.base, 'secret.txt'), join(s.root, 'pages', 'link.html'));
  s.pages({ 'https://a.example/': '../pages/link.html' });
  assert.throws(() => loadFixtureDir('set', { root: s.root }), /outside/);
});

test('a fixture directory that is a symlink out of the root is refused', t => {
  const s = sandbox(t);
  mkdirSync(join(s.base, 'elsewhere'));
  symlinkSync(join(s.base, 'elsewhere'), join(s.root, 'escape'));
  assert.throws(() => loadFixtureDir('escape', { root: s.root }), /outside/);
});
