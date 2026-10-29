'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const VERSION = '4.0.536';
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));

const remotionDeps = Object.entries(pkg.dependencies)
  .filter(([name]) => name === 'remotion' || name.startsWith('@remotion/'));

test('все пакеты Remotion закреплены точной версией', () => {
  assert.ok(remotionDeps.length >= 6);
  for (const [name, range] of remotionDeps) {
    assert.equal(range, VERSION, name + ' должен быть ' + VERSION + ', а не ' + range);
  }
});

test('bundler и renderer объявлены явно', () => {
  assert.equal(pkg.dependencies['@remotion/bundler'], VERSION);
  assert.equal(pkg.dependencies['@remotion/renderer'], VERSION);
});

test('lockfile совпадает с package.json', () => {
  for (const [name] of remotionDeps) {
    const entry = lock.packages['node_modules/' + name];
    assert.ok(entry, name + ' есть в lockfile');
    assert.equal(entry.version, VERSION, name + ' в lockfile');
  }
});

test('motion-craft.md называет текущую версию Remotion', () => {
  const doc = fs.readFileSync(
    path.join(ROOT, 'skills/reel-turnkey/references/motion-craft.md'), 'utf8');
  assert.ok(doc.includes('сейчас ' + VERSION), 'документ должен называть ' + VERSION);
});
