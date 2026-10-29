const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  declinedSet, readPultState, setArchived, setFinalDeclined,
} = require('../scripts/pult/state');
const { addLegacyFolder, makePultRoot } = require('./helpers/pult-projects');

test('archive state starts empty and toggles card ids in order', (t) => {
  const { projectsDir } = makePultRoot(t);
  assert.deepEqual(readPultState(projectsDir), { version: 1, archived: [], finalDeclined: [] });
  setArchived(projectsDir, 'folder:old-test', true);
  setArchived(projectsDir, 'group:agents', true);
  setArchived(projectsDir, 'folder:old-test', true);
  assert.deepEqual(readPultState(projectsDir).archived, ['folder:old-test', 'group:agents']);
  setArchived(projectsDir, 'folder:old-test', false);
  assert.deepEqual(readPultState(projectsDir).archived, ['group:agents']);
});

test('archiving never touches the video folder', (t) => {
  const { projectsDir } = makePultRoot(t);
  const dir = addLegacyFolder(projectsDir, 'old-test', { files: { 'final/x.mp4': 'x' } });
  setArchived(projectsDir, 'folder:old-test', true);
  assert.equal(fs.readFileSync(path.join(dir, 'final', 'x.mp4'), 'utf8'), 'x');
  assert.deepEqual(fs.readdirSync(projectsDir).sort(), ['.pult', 'old-test']);
});

test('invalid card ids are rejected', (t) => {
  const { projectsDir } = makePultRoot(t);
  for (const id of [
    '',
    '../x',
    'folder:',
    'folder:a/b',
    'other:x',
    'folder:.pult',
    'folder:..',
    `folder:${'x'.repeat(300)}`,
  ]) {
    assert.throws(() => setArchived(projectsDir, id, true), /карточк/, id);
  }
});

test('real folder names round-trip through the archive, including NFD Cyrillic', (t) => {
  const { projectsDir } = makePultRoot(t);
  const name = 'ёлка-2026 (финал) + бонус'.normalize('NFD');
  const id = `folder:${name}`;
  setArchived(projectsDir, id, true);
  assert.deepEqual(readPultState(projectsDir).archived, [id]);
});

// Показ терпим к порче файла (пустые списки), а запись поверх неё – нет (ревью #104):
// иначе первая же запись стёрла бы архив и решения о финале. После починки файла запись снова идёт.
test('a corrupted state.json reads as an empty archive and writes again once the file is fixed', (t) => {
  const { projectsDir } = makePultRoot(t);
  fs.mkdirSync(path.join(projectsDir, '.pult'), { recursive: true });
  const statePath = path.join(projectsDir, '.pult', 'state.json');
  for (const broken of ['{ broken', '{"version":2}']) {
    fs.writeFileSync(statePath, broken);
    assert.deepEqual(readPultState(projectsDir), { version: 1, archived: [], finalDeclined: [] }, broken);
    assert.throws(() => setArchived(projectsDir, 'folder:old-test', true), /state\.json/, broken);
    fs.rmSync(statePath);
    setArchived(projectsDir, 'folder:old-test', true);
    assert.deepEqual(readPultState(projectsDir), { version: 1, archived: ['folder:old-test'], finalDeclined: [] }, broken);
    setArchived(projectsDir, 'folder:old-test', false);
  }
});

test('a no-op unarchive on a fresh root creates no .pult folder', (t) => {
  const { projectsDir } = makePultRoot(t);
  setArchived(projectsDir, 'folder:never-archived', false);
  assert.deepEqual(fs.readdirSync(projectsDir), []);
});

// «Финал не нужен» (#104, DECISIONS.md D-050): решение живёт рядом с архивом в собственном
// файле пульта и адресует одну утверждённую версию – папку и точный путь утверждённого brief.
const APPROVED = 'brief/v03-approved.lesson.json';
const fixedNow = () => new Date('2026-10-17T10:00:00.000Z');

test('declining a final is idempotent, bound to folder and brief path, and restorable', (t) => {
  const { projectsDir } = makePultRoot(t);
  setFinalDeclined(projectsDir, { folder: 'clip', briefPath: APPROVED }, true, { now: fixedNow });
  setFinalDeclined(projectsDir, { folder: 'clip', briefPath: APPROVED }, true, { now: () => new Date('2027-01-01T00:00:00Z') });
  const state = readPultState(projectsDir);
  assert.deepEqual(state.finalDeclined, [{ folder: 'clip', briefPath: APPROVED, declinedAt: '2026-10-17T10:00:00.000Z' }]);
  const set = declinedSet(state);
  assert.ok(set.has(`clip\0${APPROVED}`));
  assert.ok(!set.has('clip\0brief/v05-approved.lesson.json'));
  setFinalDeclined(projectsDir, { folder: 'clip', briefPath: APPROVED }, false);
  setFinalDeclined(projectsDir, { folder: 'clip', briefPath: APPROVED }, false);
  assert.deepEqual(readPultState(projectsDir).finalDeclined, []);
});

test('declining a final keeps the archive and archiving keeps declined finals', (t) => {
  const { projectsDir } = makePultRoot(t);
  setArchived(projectsDir, 'folder:clip', true);
  setFinalDeclined(projectsDir, { folder: 'clip', briefPath: APPROVED }, true, { now: fixedNow });
  setArchived(projectsDir, 'group:agents', true);
  const state = readPultState(projectsDir);
  assert.deepEqual(state.archived, ['folder:clip', 'group:agents']);
  assert.equal(state.finalDeclined.length, 1);
});

test('a state file of the old format with only archived keeps working', (t) => {
  const { projectsDir } = makePultRoot(t);
  fs.mkdirSync(path.join(projectsDir, '.pult'), { recursive: true });
  fs.writeFileSync(path.join(projectsDir, '.pult', 'state.json'), JSON.stringify({ version: 1, archived: ['folder:old'] }));
  assert.deepEqual(readPultState(projectsDir), { version: 1, archived: ['folder:old'], finalDeclined: [] });
  setFinalDeclined(projectsDir, { folder: 'clip', briefPath: APPROVED }, true, { now: fixedNow });
  assert.deepEqual(readPultState(projectsDir).archived, ['folder:old']);
});

test('invalid declined entries are dropped on read, a broken list does not erase the archive', (t) => {
  const { projectsDir } = makePultRoot(t);
  fs.mkdirSync(path.join(projectsDir, '.pult'), { recursive: true });
  const file = path.join(projectsDir, '.pult', 'state.json');
  const good = { folder: 'clip', briefPath: APPROVED, declinedAt: '2026-10-17T10:00:00.000Z' };
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    archived: ['folder:old'],
    finalDeclined: [
      good,
      null,
      'clip',
      { folder: '../x', briefPath: APPROVED, declinedAt: 'x' },
      { folder: 'clip', briefPath: '../../etc/passwd', declinedAt: 'x' },
      { folder: 'clip', briefPath: 'brief/../project.json', declinedAt: 'x' },
      { folder: 'clip', briefPath: APPROVED },
    ],
  }));
  assert.deepEqual(readPultState(projectsDir), { version: 1, archived: ['folder:old'], finalDeclined: [good] });
  fs.writeFileSync(file, JSON.stringify({ version: 1, archived: ['folder:old'], finalDeclined: 'oops' }));
  assert.deepEqual(readPultState(projectsDir), { version: 1, archived: ['folder:old'], finalDeclined: [] });
});

test('declining a final rejects unsafe folders and brief paths', (t) => {
  const { projectsDir } = makePultRoot(t);
  for (const folder of ['', '../x', 'a/b', '.pult', undefined, 42]) {
    assert.throws(() => setFinalDeclined(projectsDir, { folder, briefPath: APPROVED }, true), /папка/, String(folder));
  }
  for (const briefPath of ['', '../brief/x.json', '/etc/x.json', 'brief/../x.json', 'brief/x.md', 'brief/sub/x.json', 'brief\\x.json', 'brief/.x.json', null]) {
    assert.throws(() => setFinalDeclined(projectsDir, { folder: 'clip', briefPath }, true), /brief/, String(briefPath));
  }
  assert.deepEqual(fs.readdirSync(projectsDir), []);
});

// Ревью #104: CLI (`inbox --decline-final`) и сервер пульта пишут state.json из разных
// процессов. Без межпроцессного замка read-modify-write одного процесса молча стирал бы
// изменение другого.
const { spawn } = require('node:child_process');
const { acquireProjectMutationLease } = require('../scripts/project/workspace');

function runWriter(projectsDir, prefix, count) {
  const script = `
    const { setArchived, setFinalDeclined } = require(${JSON.stringify(path.resolve(__dirname, '../scripts/pult/state'))});
    const [dir, prefix, count] = process.argv.slice(1);
    for (let i = 0; i < Number(count); i += 1) {
      setFinalDeclined(dir, { folder: prefix, briefPath: 'brief/v' + i + '-approved.lesson.json' }, true);
      setArchived(dir, 'folder:' + prefix + '-' + i, true);
    }
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script, projectsDir, prefix, String(count)], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`writer ${prefix} exited ${code}: ${stderr}`))));
  });
}

test('concurrent writers from separate processes never lose each other\'s changes', async (t) => {
  const { projectsDir } = makePultRoot(t);
  const count = 25;
  await Promise.all(['a', 'b', 'c'].map((prefix) => runWriter(projectsDir, prefix, count)));
  const state = readPultState(projectsDir);
  assert.equal(state.finalDeclined.length, 3 * count);
  assert.equal(state.archived.length, 3 * count);
  assert.equal(fs.readdirSync(path.join(projectsDir, '.pult')).filter((name) => /lock|tmp/.test(name)).length, 0);
});

test('a state write waits for a live lock holder and then gives up with a busy error', (t) => {
  const { projectsDir } = makePultRoot(t);
  fs.mkdirSync(path.join(projectsDir, '.pult'));
  const lease = acquireProjectMutationLease(path.join(projectsDir, '.pult'));
  try {
    assert.throws(
      () => setArchived(projectsDir, 'folder:clip', true, { lockWaitMs: 150 }),
      (error) => error.code === 'PULT_STATE_BUSY' && /занят/.test(error.message),
    );
    assert.throws(
      () => setFinalDeclined(projectsDir, { folder: 'clip', briefPath: APPROVED }, true, { lockWaitMs: 150 }),
      (error) => error.code === 'PULT_STATE_BUSY',
    );
  } finally {
    lease.release();
  }
  setArchived(projectsDir, 'folder:clip', true);
  assert.deepEqual(readPultState(projectsDir).archived, ['folder:clip']);
});

test('a lock left by a dead process does not block state writes', (t) => {
  const { projectsDir } = makePultRoot(t);
  fs.mkdirSync(path.join(projectsDir, '.pult'));
  // Владелец с заведомо несуществующим pid – брошенный замок упавшего процесса.
  acquireProjectMutationLease(path.join(projectsDir, '.pult'), { pid: 2147483646 });
  setFinalDeclined(projectsDir, { folder: 'clip', briefPath: APPROVED }, true, { lockWaitMs: 150 });
  assert.equal(readPultState(projectsDir).finalDeclined.length, 1);
});

// Ревью #104: терпимое чтение нужно для показа, но запись поверх нечитаемого файла стёрла
// бы и архив, и решения о финале. Отсутствующий файл – по-прежнему нормальное начало.
test('setters refuse to overwrite an unreadable or invalid state file', (t) => {
  const { projectsDir } = makePultRoot(t);
  fs.mkdirSync(path.join(projectsDir, '.pult'));
  const file = path.join(projectsDir, '.pult', 'state.json');
  for (const broken of [
    '{ broken',
    '{"version":2,"archived":["folder:old"]}',
    '{"version":1}',
    '{"version":1,"archived":"x"}',
    '{"version":1,"archived":["folder:old"],"finalDeclined":"oops"}',
    'null',
  ]) {
    fs.writeFileSync(file, broken);
    for (const write of [
      () => setArchived(projectsDir, 'folder:clip', true),
      () => setFinalDeclined(projectsDir, { folder: 'clip', briefPath: APPROVED }, true),
    ]) {
      assert.throws(write, (error) => error.code === 'PULT_STATE_UNREADABLE' && /state\.json/.test(error.message), broken);
      assert.equal(fs.readFileSync(file, 'utf8'), broken, broken);
    }
  }
  assert.equal(fs.readdirSync(path.join(projectsDir, '.pult')).filter((name) => name !== 'state.json').length, 0);
});

test('setters refuse to write over a state file they are not allowed to read', {
  skip: process.platform === 'win32' || process.getuid?.() === 0,
}, (t) => {
  const { projectsDir } = makePultRoot(t);
  setArchived(projectsDir, 'folder:old', true);
  const file = path.join(projectsDir, '.pult', 'state.json');
  fs.chmodSync(file, 0o200);
  try {
    assert.deepEqual(readPultState(projectsDir).archived, []);
    assert.throws(() => setArchived(projectsDir, 'folder:clip', true), (error) => error.code === 'PULT_STATE_UNREADABLE');
  } finally {
    fs.chmodSync(file, 0o644);
  }
  assert.deepEqual(readPultState(projectsDir).archived, ['folder:old']);
});
