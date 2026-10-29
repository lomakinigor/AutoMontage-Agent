const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { toolAvailable, runTool } = require('./helpers/media-fixtures');
const { makeLayerProject } = require('./helpers/layer-project');
const { manifestFixture } = require('./helpers/manifest-fixtures');
const { writeProjectManifest } = require('../scripts/project/workspace');
const { hashFile } = require('../scripts/pult/files');
const { buildMomentSheet, frameFormat, phoneWidth, run } = require('../scripts/layer/sheet');

const hasFfmpeg = toolAvailable('ffmpeg') && toolAvailable('ffprobe');

function dims(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim();
  const [width, height] = out.split(',').map(Number);
  return { width, height };
}

// Проект с preview 540x960 и ТЗ из двух сцен по 2 с (в глобальном времени: начиная с fromSec).
function scaffold(t, { seconds = 4, fromSec = 0, scenes } = {}) {
  const { projectDir, workspace } = makeLayerProject(t, { seconds: 6 });
  const previewRelative = 'previews/preview.mp4';
  const previewPath = path.join(projectDir, previewRelative);
  fs.mkdirSync(path.dirname(previewPath), { recursive: true });
  runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=540x960:r=25:d=${seconds}`, '-pix_fmt', 'yuv420p', previewPath]);
  const briefRelative = 'brief/v01-draft.lesson.json';
  fs.mkdirSync(path.join(projectDir, 'brief'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, briefRelative), JSON.stringify({
    scenes: scenes || [{ scene: 'fullscreen', start: fromSec, end: fromSec + 2, caption: 'Первая' }, { scene: 'split', start: fromSec + 2, end: fromSec + 4, caption: 'Вторая' }],
  }));
  const sha256 = hashFile(previewPath);
  const nextManifest = { ...workspace.manifest, currentPreview: { filePath: previewRelative, briefPath: briefRelative, kind: fromSec ? 'excerpt' : 'full',
    fromSec, toSec: fromSec + seconds, width: 540, height: 960, fps: 25, generatedAt: new Date().toISOString(), sha256 } };
  writeProjectManifest(projectDir, nextManifest, { expectedManifest: workspace.manifest });
  return { projectDir, previewPath, sha256 };
}

const readIndex = (projectDir, sha256) => JSON.parse(fs.readFileSync(path.join(projectDir, 'qa', `moments-${sha256.slice(0, 8)}.json`), 'utf8'));

test('buildMomentSheet: кадры 720 px, лист 4 колонки, телефонный лист 360 px и индекс', { skip: !hasFfmpeg }, (t) => {
  const { projectDir, previewPath } = scaffold(t);
  const outDir = path.join(projectDir, 'qa');
  fs.mkdirSync(outDir, { recursive: true });
  const moments = [
    { timeSec: 0.3, kind: 'event', ref: 'title-1', label: 'a' },
    { timeSec: 1.5, kind: 'hold', ref: 'title-1', label: 'b' },
    { timeSec: 3.9, kind: 'event', ref: 'insert-1', label: 'c' },
  ];
  const result = buildMomentSheet({ videoPath: previewPath, width: 540, height: 960, duration: 4, fps: 25, moments, outDir, name: 'moments-test', log: () => {} });
  const frames = fs.readdirSync(result.framesDir).sort();
  assert.equal(frames.length, 3);
  assert.match(frames[0], /^01-0\.3\.jpg$/);
  for (const f of frames) assert.equal(dims(path.join(result.framesDir, f)).height, 720, 'длинная сторона 720 px');
  assert.equal(dims(result.sheetPath).width, 270 * 4, 'лист: 4 колонки по 270 px');
  assert.equal(dims(result.phonePath).width, 360 * 4, 'телефонный лист: 4 колонки по 360 px');
  assert.equal(result.gate.id, 'G12');
  const index = JSON.parse(fs.readFileSync(result.indexPath, 'utf8'));
  assert.equal(index.version, 1);
  assert.deepEqual(index.format, { aspect: 'vertical', width: 540, height: 960 }, 'индекс несёт формат для критика');
  assert.equal(index.moments.length, 3);
  assert.deepEqual(Object.keys(index.moments[0]).sort(), ['file', 'kind', 'label', 'ref', 'timeSec']);
  assert.ok(!path.isAbsolute(index.moments[0].file));
  assert.ok(fs.existsSync(path.join(projectDir, index.moments[0].file)));
});

test('run --mode moments: ТЗ без манифеста, имя moments-<sha8>, индекс с previewSha256', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir, sha256 } = scaffold(t);
  const lines = [];
  assert.equal(await run({ 'project-dir': projectDir, mode: 'moments', source: 'preview' }, { log: (l) => lines.push(l) }), 0);
  const name = `moments-${sha256.slice(0, 8)}`;
  const qa = path.join(projectDir, 'qa');
  for (const f of [`${name}.jpg`, `${name}-phone.jpg`, `${name}.json`, name]) assert.ok(fs.existsSync(path.join(qa, f)), f);
  const index = readIndex(projectDir, sha256);
  assert.equal(index.previewSha256, sha256);
  assert.equal(index.source, 'preview');
  assert.deepEqual(index.moments.filter((m) => m.kind !== 'even').map((m) => m.timeSec), [0.3, 1, 2.3, 3]);
  assert.ok(index.moments.length >= 6, 'ТЗ из двух сцен дополнено равномерными кадрами');
  assert.ok(lines.some((l) => l.includes('G12')));
  assert.ok(lines.some((l) => l.includes(`${name}.jpg`)));
});

test('run --mode moments: в отрывке сцены ТЗ сдвигаются на fromSec', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir, sha256 } = scaffold(t, { fromSec: 10 });
  assert.equal(await run({ 'project-dir': projectDir, mode: 'moments', source: 'preview' }, { log: () => {} }), 0);
  assert.deepEqual(readIndex(projectDir, sha256).moments.filter((m) => m.kind !== 'even').map((m) => m.timeSec), [0.3, 1, 2.3, 3]);
});

test('run --mode moments: манифест слоя из реестра в приоритете над ТЗ', { skip: !hasFfmpeg }, async (t) => {
  const reference = 'assets/broll/video/layer-x/media.mp4';
  const { projectDir, sha256 } = scaffold(t, { scenes: [{ scene: 'broll', start: 0, end: 4, headCream: 'x', brollMedia: { kind: 'video', src: reference } }] });
  fs.mkdirSync(path.join(projectDir, 'motion-v01', 'out'), { recursive: true });
  const texts = [{ id: 'title-1', from: 25, frames: Array.from({ length: 50 }, () => ({})) }];
  fs.writeFileSync(path.join(projectDir, 'motion-v01', 'out', 'manifest.json'), JSON.stringify(manifestFixture({ seconds: 4, texts })));
  fs.mkdirSync(path.join(projectDir, 'qa'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'qa', 'layer-imports.json'), JSON.stringify({ version: 1, imports: [{ layer: 'motion-v01', reference }] }));
  assert.equal(await run({ 'project-dir': projectDir, mode: 'moments', source: 'preview' }, { log: () => {} }), 0);
  const index = readIndex(projectDir, sha256);
  assert.deepEqual(index.moments.map((m) => m.ref), ['title-1', 'title-1']);
  assert.deepEqual(index.moments.map((m) => m.timeSec), [1.3, 2]);
});

test('run --mode even даёт прежний sheet-<sha8>.jpg', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir, sha256 } = scaffold(t);
  assert.equal(await run({ 'project-dir': projectDir, mode: 'even' }, { log: () => {} }), 0);
  assert.ok(fs.existsSync(path.join(projectDir, 'qa', `sheet-${sha256.slice(0, 8)}.jpg`)));
});

test('run --mode x: код 2 и подсказка по-русски, без обращения к проекту', async () => {
  const errors = [];
  const code = await run({ 'project-dir': '/nonexistent', mode: 'x' }, { log: () => {}, warn: (l) => errors.push(l) });
  assert.equal(code, 2);
  assert.match(errors.join('\n'), /even.*moments/u);
});

test('моменты в последней доле секунды не выходят за длительность', { skip: !hasFfmpeg }, (t) => {
  const { projectDir, previewPath } = scaffold(t);
  const outDir = path.join(projectDir, 'qa');
  fs.mkdirSync(outDir, { recursive: true });
  const moments = [{ timeSec: 3.999, kind: 'event', ref: 'e', label: 'e' }, { timeSec: 4, kind: 'event', ref: 'f', label: 'f' }];
  const result = buildMomentSheet({ videoPath: previewPath, width: 540, height: 960, duration: 4, fps: 25, moments, outDir, name: 'moments-end', log: () => {} });
  assert.equal(fs.readdirSync(result.framesDir).length, 2);
  for (const f of fs.readdirSync(result.framesDir)) assert.ok(fs.statSync(path.join(result.framesDir, f)).size > 0);
});

test('phoneWidth и frameFormat: вертикаль 360 px, горизонталь 640 px', () => {
  assert.equal(phoneWidth(1080, 1920), 360);
  assert.equal(phoneWidth(1920, 1080), 640);
  assert.deepEqual(frameFormat(1080, 1920), { aspect: 'vertical', width: 1080, height: 1920 });
  assert.deepEqual(frameFormat(1920, 1080), { aspect: 'horizontal', width: 1920, height: 1080 });
});

test('buildMomentSheet 16:9: телефонный лист 640 px на кадр и формат horizontal в индексе', { skip: !hasFfmpeg }, (t) => {
  const { projectDir } = scaffold(t);
  const video = path.join(projectDir, 'previews', 'wide.mp4');
  runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=960x540:r=25:d=2', '-pix_fmt', 'yuv420p', video]);
  const outDir = path.join(projectDir, 'qa');
  fs.mkdirSync(outDir, { recursive: true });
  const moments = [{ timeSec: 0.3, kind: 'event', ref: 'a', label: 'a' }, { timeSec: 1.5, kind: 'hold', ref: 'a', label: 'b' }];
  const result = buildMomentSheet({ videoPath: video, width: 1920, height: 1080, duration: 2, fps: 25, moments, outDir, name: 'moments-wide', log: () => {} });
  assert.equal(dims(result.phonePath).width, 640 * 4, 'телефонный лист 16:9: 4 колонки по 640 px');
  assert.deepEqual(JSON.parse(fs.readFileSync(result.indexPath, 'utf8')).format, { aspect: 'horizontal', width: 1920, height: 1080 });
});
