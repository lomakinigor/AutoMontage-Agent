'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { coverFrameGate, COVER_EDGE_SHARE_MIN, COVER_LUMA_MIN } = require('../scripts/qa/cover-frame-gate');
const { SHARE_THRESHOLD } = require('../scripts/qa/empty-frame-gate');
const { frameStats } = require('../scripts/layer/sheet');
const { runFinalQa } = require('../scripts/qa/final-qa');

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

test('пороги: доля краёв – тот же SHARE_THRESHOLD, что у G12', () => {
  assert.equal(COVER_EDGE_SHARE_MIN, SHARE_THRESHOLD);
  assert.equal(COVER_LUMA_MIN, 20);
});
test('чёрный кадр 0 – warn с подсказкой и span в нуле', () => {
  const g = coverFrameGate({ edgeShare: 0, meanLuma: 2 });
  assert.equal(g.id, 'G13');
  assert.equal(g.title, 'Обложка – кадр 0');
  assert.equal(g.status, 'warn');
  assert.deepEqual(g.spans.map((s) => [s.fromSec, s.toSec]), [[0, 0]]);
  assert.match(g.hint, /начните с кадра со спикером или заголовком/);
});
test('однотонный светлый кадр – warn (нет деталей)', () => assert.equal(coverFrameGate({ edgeShare: 0.0002, meanLuma: 200 }).status, 'warn'));
test('обычный кадр – pass', () => assert.equal(coverFrameGate({ edgeShare: 0.05, meanLuma: 110 }).status, 'pass'));
test('замер не удался (null) – warn', () => assert.equal(coverFrameGate(null).status, 'warn'));

test('frameStats: чёрный кадр темнее порога, тестовая сетка даёт края', { skip: !hasFfmpeg }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cover-gate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const make = (name, src) => {
    const file = path.join(dir, name);
    const r = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', src, '-frames:v', '1', '-pix_fmt', 'yuv420p', file]);
    assert.equal(r.status, 0);
    return file;
  };
  const black = frameStats(make('black.mp4', 'color=black:s=320x240:r=5'), 0);
  assert.ok(black.meanLuma < COVER_LUMA_MIN);
  const grid = frameStats(make('grid.mp4', 'testsrc2=s=320x240:r=5'), 0);
  assert.ok(grid.edgeShare > SHARE_THRESHOLD);
  assert.equal(frameStats(path.join(dir, 'нет.mp4'), 0), null);
});

test('runFinalQa с check cover: в отчёте есть G13; сбой замера – warn, не исключение', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cover-qa-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const finalPath = path.join(dir, 'f.mp4');
  fs.writeFileSync(finalPath, 'x');
  const { FINAL_CHECKS } = require('../scripts/qa/final-qa');
  const checks = FINAL_CHECKS.filter((c) => c.id === 'cover');
  const seen = [];
  let r = await runFinalQa({ finalPath, checks, write: false }, { frameStatsImpl: (f, t0) => { seen.push([f, t0]); return { edgeShare: 0.05, meanLuma: 100 }; } });
  assert.equal(r.report.gates.find((g) => g.id === 'G13').status, 'pass');
  assert.deepEqual(seen, [[finalPath, 0]]);
  r = await runFinalQa({ finalPath, checks, write: false }, { frameStatsImpl: () => { throw new Error('boom'); } });
  assert.equal(r.report.gates.find((g) => g.id === 'G13').status, 'warn');
  assert.equal(r.report.error, null);
});
