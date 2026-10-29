const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { pruneMomentSets } = require('../scripts/qa/moment-sets');

function qaDir(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moment-sets-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'qa');
  fs.mkdirSync(dir);
  return { root, dir };
}

// Набор моментов: кадры в папке <name>/, лист, телефонный лист и индекс; время – по индексу.
function writeSet(dir, name, minutesAgo) {
  fs.mkdirSync(path.join(dir, name));
  fs.writeFileSync(path.join(dir, name, '01-0.5.jpg'), 'frame');
  for (const suffix of ['.jpg', '-phone.jpg', '.json']) fs.writeFileSync(path.join(dir, `${name}${suffix}`), 'x');
  const when = new Date(Date.now() - minutesAgo * 60_000);
  fs.utimesSync(path.join(dir, `${name}.json`), when, when);
}

const setFiles = (name) => [name, `${name}-phone.jpg`, `${name}.jpg`, `${name}.json`];
const listing = (dir) => fs.readdirSync(dir).sort();

test('pruneMomentSets: из 5 наборов остаются 2 самых свежих по индексу, вместе с папками кадров', (t) => {
  const { dir } = qaDir(t);
  const names = ['aaaaaaa1', 'aaaaaaa2', 'aaaaaaa3', 'aaaaaaa4', 'aaaaaaa5'].map((sha) => `moments-stills-${sha}`);
  names.forEach((name, index) => writeSet(dir, name, 50 - index * 10));
  const { removed } = pruneMomentSets(dir, { kind: 'stills' });
  assert.deepEqual(listing(dir), [...setFiles(names[3]), ...setFiles(names[4])].sort());
  assert.equal(removed.length, 12);
  assert.ok(removed.every((file) => path.dirname(file) === dir));
});

test('pruneMomentSets: другой вид наборов, отчёты критика и чужие файлы не трогаются', (t) => {
  const { dir } = qaDir(t);
  for (let index = 1; index <= 3; index += 1) writeSet(dir, `moments-stills-bbbbbbb${index}`, 30 - index);
  for (let index = 1; index <= 3; index += 1) writeSet(dir, `moments-cccccc0${index}`, 30 - index);
  const others = ['critic-01.json', 'critic-01.txt', 'sheet-abcd1234.jpg', 'final-x.txt', 'moments-xyz.json', 'moments-abcd1234-old.jpg', 'moments-ABCD1234.json'];
  for (const name of others) fs.writeFileSync(path.join(dir, name), 'keep');
  const { removed } = pruneMomentSets(dir, { kind: 'preview' });
  assert.deepEqual(removed.map((file) => path.basename(file)).sort(), setFiles('moments-cccccc01').sort());
  for (const name of [...others, ...setFiles('moments-stills-bbbbbbb1'), ...setFiles('moments-cccccc03')]) {
    assert.ok(fs.existsSync(path.join(dir, name)), name);
  }
  pruneMomentSets(dir, { kind: 'stills' });
  assert.ok(!fs.existsSync(path.join(dir, 'moments-stills-bbbbbbb1.json')));
  for (const name of others) assert.ok(fs.existsSync(path.join(dir, name)), name);
});

test('pruneMomentSets: симлинк с именем набора не удаляется и цель не трогается', (t) => {
  const { root, dir } = qaDir(t);
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'precious.jpg'), 'precious');
  fs.writeFileSync(path.join(root, 'precious.json'), 'precious');
  writeSet(dir, 'moments-dddddd01', 30);
  writeSet(dir, 'moments-dddddd02', 20);
  writeSet(dir, 'moments-dddddd03', 10);
  fs.symlinkSync(outside, path.join(dir, 'moments-dddddd00'));
  fs.symlinkSync(path.join(root, 'precious.json'), path.join(dir, 'moments-dddddd00.json'));
  const old = new Date(Date.now() - 3_600_000);
  fs.lutimesSync(path.join(dir, 'moments-dddddd00.json'), old, old);
  const { removed } = pruneMomentSets(dir, { kind: 'preview' });
  assert.ok(!removed.some((file) => path.basename(file).startsWith('moments-dddddd00')));
  assert.ok(fs.lstatSync(path.join(dir, 'moments-dddddd00')).isSymbolicLink());
  assert.ok(fs.lstatSync(path.join(dir, 'moments-dddddd00.json')).isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(outside, 'precious.jpg'), 'utf8'), 'precious');
  assert.equal(fs.readFileSync(path.join(root, 'precious.json'), 'utf8'), 'precious');
  assert.ok(!fs.existsSync(path.join(dir, 'moments-dddddd01.json')));
});

test('pruneMomentSets: ошибка ФС – предупреждение без исключения, остальное удаляется', (t) => {
  const { dir } = qaDir(t);
  for (let index = 1; index <= 4; index += 1) writeSet(dir, `moments-eeeeee0${index}`, 40 - index * 10);
  const warnings = [];
  const failing = {
    ...fs,
    unlinkSync(file) {
      if (path.basename(file) === 'moments-eeeeee01.jpg') throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return fs.unlinkSync(file);
    },
  };
  let result;
  assert.doesNotThrow(() => { result = pruneMomentSets(dir, { kind: 'preview', fileSystem: failing, warn: (line) => warnings.push(line) }); });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /moments-eeeeee01\.jpg/u);
  assert.ok(fs.existsSync(path.join(dir, 'moments-eeeeee01.jpg')));
  assert.ok(!fs.existsSync(path.join(dir, 'moments-eeeeee02.json')));
  assert.ok(!result.removed.some((file) => path.basename(file) === 'moments-eeeeee01.jpg'));

  const broken = { ...fs, readdirSync() { throw new Error('EIO'); } };
  const more = [];
  assert.deepEqual(pruneMomentSets(dir, { kind: 'preview', fileSystem: broken, warn: (line) => more.push(line) }), { removed: [] });
  assert.equal(more.length, 1);
});

test('pruneMomentSets: нет папки qa – без исключения, неизвестный вид – ошибка', (t) => {
  const { root } = qaDir(t);
  assert.deepEqual(pruneMomentSets(path.join(root, 'missing'), { kind: 'stills', warn: () => {} }), { removed: [] });
  assert.throws(() => pruneMomentSets(root, { kind: 'x' }), /kind/u);
});

test('pruneMomentSets: только что записанный набор остаётся, даже если старые индексы «из будущего»', (t) => {
  const { dir } = qaDir(t);
  writeSet(dir, 'moments-stills-aaaaaaa1', -60);
  writeSet(dir, 'moments-stills-aaaaaaa2', -30);
  writeSet(dir, 'moments-stills-aaaaaaa3', 0);
  pruneMomentSets(dir, { kind: 'stills', keep: 2, current: 'moments-stills-aaaaaaa3', warn: () => {} });
  const left = listing(dir);
  for (const file of setFiles('moments-stills-aaaaaaa3')) assert.ok(left.includes(file), file);
  for (const file of setFiles('moments-stills-aaaaaaa1')) assert.ok(left.includes(file), file);
  for (const file of setFiles('moments-stills-aaaaaaa2')) assert.ok(!left.includes(file), file);
});
