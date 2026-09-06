const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

test('batch manual covers the complete workflow without inventing a CLI', () => {
  const manual = read('docs/BATCH-REELS-WORKFLOW.md');
  for (const heading of [
    'Inventory',
    'Hook families',
    'Vector explainers',
    'Captions and safe zones',
    'Music and sidechain',
    'Batch QA',
    'Covers',
    'Delivery',
  ]) {
    assert.match(manual, new RegExp(`^## ${heading}`, 'mu'));
  }
  assert.doesNotMatch(manual, /automontage batch/u);

  const slash = '/';
  const backslash = '\\\\';
  const localPath = new RegExp([
    [slash, 'Users', slash].join(''),
    [slash, 'var', slash, 'folders', slash].join(''),
    ['[A-Za-z]:', backslash, 'Users', backslash].join(''),
  ].join('|'), 'u');
  assert.doesNotMatch(manual, localPath);
});

test('batch rules are synchronized with the turnkey skill and QA checklist', () => {
  const combined = [
    read('skills/reel-turnkey/SKILL.md'),
    read('skills/reel-turnkey/references/brief-package.md'),
    read('skills/reel-turnkey/references/qa-checklist.md'),
  ].join('\n');

  for (const contract of [
    /первые (?:две|2).*(?:три|3) секунд/iu,
    /сомнительн.*повтор.*остав/iu,
    /блок.*соединител.*следующ.*блок/iu,
    /общ.*шкал/iu,
    /субтитр.*(?:скры|убир)/iu,
    /sidechain/iu,
    /общ.*(?:тело|основ)/iu,
    /облож/iu,
    /пакет.*QA/iu,
  ]) {
    assert.match(combined, contract);
  }
});
