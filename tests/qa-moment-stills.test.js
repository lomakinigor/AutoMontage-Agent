const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { toolAvailable } = require('./helpers/media-fixtures');
const { makeLayerProject } = require('./helpers/layer-project');
const { manifestFixture } = require('./helpers/manifest-fixtures');
const { readProjectManifest } = require('../scripts/project/workspace');
const { hashFile } = require('../scripts/pult/files');
const { inputsSha256, renderMomentStills, resolveStillsTarget, stillsIndexStale } = require('../scripts/qa/moment-stills');
const sheet = require('../scripts/layer/sheet');
const { layerSrcSha256 } = require('../scripts/layer/common');
const { buildReport, gate, writeReport } = require('../scripts/qa/report');

const hasFfmpeg = toolAvailable('ffmpeg') && toolAvailable('ffprobe');

// Отчёт layer check слоя name (qa/layer-<name>-check.json), как его пишет scripts/layer/check.js:
// status – итог гейтов (pass, warn, fail) или error; sha256 – манифест, по которому судили гейты.
function writeCheckReport(projectDir, name, { status = 'pass', sha256 = hashFile(path.join(projectDir, name, 'out', 'manifest.json')) } = {}) {
  const gates = status === 'error' ? [] : [gate('G1', 'тест', { status })];
  const inputs = [{ role: 'manifest', path: `${name}/out/manifest.json`, sha256 }];
  writeReport(projectDir, `layer-${name}-check`, buildReport({
    kind: 'layer-check', layer: name, profile: 'avatar', gates, inputs, error: status === 'error' ? 'сбой сборки' : null,
  }));
}

// Слой без настоящего layer new: layer.json, план, точка входа и (по желанию) манифест и отчёт layer check.
function fakeLayer(projectDir, { name = 'motion-v01', manifest = true, srcSha256 = true, check = 'pass', plan = 'export const plan = { texts: [] };\n' } = {}) {
  const project = readProjectManifest(projectDir);
  const sourcePath = path.join(projectDir, project.source.localPath);
  const layerDir = path.join(projectDir, name);
  fs.mkdirSync(path.join(layerDir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(layerDir, 'public'), { recursive: true });
  fs.writeFileSync(path.join(layerDir, 'src', 'plan.js'), plan);
  fs.writeFileSync(path.join(layerDir, 'src', 'index.jsx'), '// entry\n');
  fs.writeFileSync(path.join(layerDir, 'layer.json'), JSON.stringify({
    version: 1, composition: 'Layer', fps: 25, width: 1080, height: 1920, durationInFrames: 100,
    source: { localPath: project.source.localPath, sha256: hashFile(sourcePath) },
  }));
  if (manifest) {
    fs.mkdirSync(path.join(layerDir, 'out'), { recursive: true });
    const stamp = srcSha256 ? { srcSha256: layerSrcSha256(layerDir) } : {};
    fs.writeFileSync(path.join(layerDir, 'out', 'manifest.json'), JSON.stringify({ ...manifestFixture({ seconds: 4 }), ...stamp }));
    if (check) writeCheckReport(projectDir, name, { status: check });
  }
  return layerDir;
}

function layerTarget(root) {
  const planPath = path.join(root, 'plan.js');
  fs.writeFileSync(planPath, 'export const plan = 1;\n');
  return {
    kind: 'layer', projectDir: path.join(root, 'kit-fixture'), entry: path.join(root, 'index.jsx'), compositionId: 'Layer',
    inputProps: {}, publicDir: path.join(root, 'public'), width: 1080, height: 1920, fps: 25, durationSec: 4,
    durationInFrames: 100, planPath, sourceSha256: 'a'.repeat(64), srcSha256: 'f'.repeat(64), layerName: 'motion-v01',
  };
}

// Заглушки Remotion и очереди: записывают вызовы, renderStill кладёт байты в output.
function stubs({ failRender = false, failBrowser = false } = {}) {
  const calls = { bundle: 0, openBrowser: 0, closed: 0, released: 0, stills: [], labels: [] };
  const browser = { close: async () => { calls.closed += 1; } };
  return {
    calls,
    deps: {
      bundle: async () => { calls.bundle += 1; return 'http://bundle'; },
      openBrowser: async () => {
        calls.openBrowser += 1;
        if (failBrowser) throw new Error('Failed to launch the browser process');
        return browser;
      },
      selectComposition: async ({ id }) => ({ id, fps: 25, width: 1080, height: 1920, durationInFrames: 100 }),
      renderStill: async (options) => {
        if (failRender) throw new Error('render boom');
        calls.stills.push(options);
        fs.writeFileSync(options.output, 'jpeg');
      },
      acquireSlot: ({ label }) => { calls.labels.push(label); return { release: () => { calls.released += 1; } }; },
      tile: (frames, { outDir, name }) => ({ sheetPath: path.join(outDir, `${name}.jpg`), phonePath: path.join(outDir, `${name}-phone.jpg`), frames }),
      edgeShare: () => 0.2,
    },
  };
}

const moments = [
  { timeSec: 0.3, kind: 'event', ref: 'title-1', label: 'a' },
  { timeSec: 1.5, kind: 'hold', ref: 'title-1', label: 'b' },
  { timeSec: 3.9, kind: 'event', ref: 'insert-1', label: 'c' },
];

function tmp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moment-stills-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('renderMomentStills: 3 момента – 3 кадра, один бандл и один браузер, jpeg 85 и масштаб 720/длинная сторона', async (t) => {
  const root = tmp(t);
  const target = layerTarget(root);
  const outDir = path.join(root, 'qa');
  const { calls, deps } = stubs();
  const result = await renderMomentStills({ target, moments, outDir, name: 'moments-stills-x', log: () => {} }, deps);
  assert.equal(calls.bundle, 1);
  assert.equal(calls.openBrowser, 1);
  assert.deepEqual(calls.stills.map((s) => s.frame), [8, 38, 98]);
  for (const still of calls.stills) {
    assert.equal(still.scale, 720 / 1920);
    assert.equal(still.imageFormat, 'jpeg');
    assert.equal(still.jpegQuality, 85);
  }
  assert.equal(calls.closed, 1, 'браузер закрыт');
  assert.equal(calls.released, 1, 'слот освобождён');
  assert.deepEqual(calls.labels, ['critic stills kit-fixture']);
  assert.equal(fs.readdirSync(result.framesDir).length, 3);
  assert.match(fs.readdirSync(result.framesDir).sort()[0], /^01-0\.3\.jpg$/u);
  const index = JSON.parse(fs.readFileSync(result.indexPath, 'utf8'));
  assert.equal(index.source, 'stills');
  assert.deepEqual(index.format, { aspect: 'vertical', width: 1080, height: 1920 }, 'индекс несёт формат для критика');
  assert.equal(index.inputsSha256, inputsSha256(target));
  assert.equal(result.inputsSha256, index.inputsSha256);
  assert.equal(index.moments.length, 3);
  assert.deepEqual(Object.keys(index.moments[0]).sort(), ['file', 'kind', 'label', 'ref', 'timeSec']);
  assert.equal(result.gate.id, 'G12');
  assert.deepEqual(fs.readdirSync(outDir).filter((f) => f.includes('.frames-')), [], 'временная папка убрана');
});

test('renderMomentStills: ошибка renderStill – браузер закрыт, слот освобождён, временных кадров нет', async (t) => {
  const root = tmp(t);
  const outDir = path.join(root, 'qa');
  const { calls, deps } = stubs({ failRender: true });
  await assert.rejects(renderMomentStills({ target: layerTarget(root), moments, outDir, name: 'moments-stills-x', log: () => {} }, deps), /render boom/u);
  assert.equal(calls.closed, 1);
  assert.equal(calls.released, 1);
  assert.deepEqual(fs.readdirSync(outDir), [], 'ни временной папки, ни половины кадров');
});

test('renderMomentStills: Chrome не запустился – понятная ошибка, слот освобождён, временные папки удалены', async (t) => {
  const root = tmp(t);
  const outDir = path.join(root, 'qa');
  const tmpRoot = path.join(root, 'tmp');
  fs.mkdirSync(tmpRoot);
  const { calls, deps } = stubs({ failBrowser: true });
  deps.tmpdir = () => tmpRoot;
  let bundleOut = null;
  deps.bundle = async (options) => { bundleOut = options.outDir; return 'http://bundle'; };
  await assert.rejects(renderMomentStills({ target: layerTarget(root), moments, outDir, name: 'moments-stills-x', log: () => {} }, deps),
    (error) => /Chrome/u.test(error.message) && /Failed to launch/u.test(error.message));
  assert.equal(calls.released, 1);
  assert.deepEqual(fs.readdirSync(outDir), []);
  assert.ok(bundleOut && bundleOut.startsWith(path.join(tmpRoot, 'automontage-critic-stills-')), 'бандл во временной папке из deps.tmpdir');
  assert.deepEqual(fs.readdirSync(tmpRoot), [], 'временная папка бандла удалена');
});

test('renderMomentStills: переданный sha идёт в индекс как есть', async (t) => {
  const root = tmp(t);
  const { deps } = stubs();
  const result = await renderMomentStills({ target: layerTarget(root), moments: moments.slice(0, 1), outDir: path.join(root, 'qa'), name: 'n', sha: 'd'.repeat(64), log: () => {} }, deps);
  assert.equal(JSON.parse(fs.readFileSync(result.indexPath, 'utf8')).inputsSha256, 'd'.repeat(64));
});

test('renderMomentStills: медиа motion-reel берутся из lease, а не из props ТЗ', async (t) => {
  const root = tmp(t);
  const outDir = path.join(root, 'qa');
  const { calls, deps } = stubs();
  let leased = 0;
  const target = {
    ...layerTarget(root), kind: 'motion-reel', inputProps: { audioSrc: 'voice.wav' }, publicDir: null,
    withMedia: async (operation) => { leased += 1; return operation({ inputProps: { audioSrc: 'leased.wav' }, publicDir: path.join(root, 'lease') }); },
  };
  let bundledPublic = null;
  deps.bundle = async (options) => { bundledPublic = options.publicDir; return 'http://bundle'; };
  await renderMomentStills({ target, moments: moments.slice(0, 1), outDir, name: 'moments-stills-y', log: () => {} }, deps);
  assert.equal(leased, 1);
  assert.equal(bundledPublic, path.join(root, 'lease'));
  assert.equal(calls.stills[0].inputProps.audioSrc, 'leased.wav');
});

test('inputsSha256: правка plan.js меняет хеш входов, тот же план – тот же хеш', (t) => {
  const target = layerTarget(tmp(t));
  const before = inputsSha256(target);
  assert.match(before, /^[a-f0-9]{64}$/u);
  assert.equal(inputsSha256(target), before);
  fs.writeFileSync(target.planPath, 'export const plan = 2;\n');
  assert.notEqual(inputsSha256(target), before);
  assert.notEqual(inputsSha256({ ...target, inputProps: { x: 1 } }), inputsSha256(target));
  assert.notEqual(inputsSha256({ ...target, sourceSha256: 'b'.repeat(64) }), inputsSha256(target));
  assert.notEqual(inputsSha256({ ...target, srcSha256: 'b'.repeat(64) }), inputsSha256(target), 'src/ слоя входит в отпечаток');
  assert.throws(() => inputsSha256({ ...target, srcSha256: undefined }), /srcSha256/u);
  const reel = { ...target, kind: 'motion-reel', srcSha256: undefined, mediaSha256: ['1'.repeat(64)] };
  assert.notEqual(inputsSha256({ ...reel, mediaSha256: ['2'.repeat(64)] }), inputsSha256(reel), 'байты медиа входят в отпечаток');
});

test('renderMomentStills: индекс слоя хранит kind и имя слоя', async (t) => {
  const root = tmp(t);
  const { deps } = stubs();
  const result = await renderMomentStills({ target: layerTarget(root), moments: moments.slice(0, 1), outDir: path.join(root, 'qa'), name: 'n', log: () => {} }, deps);
  const index = JSON.parse(fs.readFileSync(result.indexPath, 'utf8'));
  assert.equal(index.kind, 'layer');
  assert.equal(index.layer, 'motion-v01');
});

test('inputsSha256 слоя: правка компонента вне plan.js меняет отпечаток, stillsIndexStale это видит', { skip: !hasFfmpeg }, (t) => {
  const { projectDir } = makeLayerProject(t, { seconds: 2 });
  const layerDir = fakeLayer(projectDir);
  const manifest = readProjectManifest(projectDir);
  const target = resolveStillsTarget(projectDir, manifest);
  const sha = inputsSha256(target);
  const index = { kind: 'layer', layer: 'motion-v01', inputsSha256: sha };
  assert.equal(stillsIndexStale(projectDir, manifest, index), null, 'пересчёт по файлам слоя совпадает с отпечатком цели');
  fs.mkdirSync(path.join(layerDir, 'src', 'components'), { recursive: true });
  fs.writeFileSync(path.join(layerDir, 'src', 'components', 'Title.jsx'), 'export const Title = () => null;\n');
  assert.match(stillsIndexStale(projectDir, manifest, index), /менялись после кадров/u);
  assert.notEqual(inputsSha256({ ...target, srcSha256: layerSrcSha256(layerDir) }), sha);
  assert.match(stillsIndexStale(projectDir, manifest, { inputsSha256: sha }), /старого формата/u);
});

test('resolveStillsTarget motion-reel: смена байтов медиа сцены меняет inputsSha256, индекс хранит sha ТЗ', async (t) => {
  const { fixture } = require('./helpers/motion-workflow-fixture.cjs');
  const { createHash } = require('node:crypto');
  const { publishBriefRevision } = require('../scripts/project/workspace');
  const { workspace, brief } = fixture(t);
  const mediaPath = path.join(workspace.dir, 'assets', 'broll', 'pack.png');
  fs.mkdirSync(path.dirname(mediaPath), { recursive: true });
  fs.writeFileSync(mediaPath, 'png-1');
  const withMedia = { ...brief, scenes: [{ scene: 'kinetic-title', start: 0, end: 1, text: 'Точный' },
    { scene: 'media', start: 1, end: 2, media: { kind: 'image', src: 'assets/broll/pack.png', sha256: createHash('sha256').update('png-1').digest('hex'), fit: 'cover' } }] };
  publishBriefRevision(workspace, { brief: withMedia, kind: 'motion-reel' });
  const before = resolveStillsTarget(workspace.dir, readProjectManifest(workspace.dir));
  assert.equal(before.mediaSha256.length, 1);
  assert.equal(before.briefSha256, hashFile(before.planPath));
  fs.writeFileSync(mediaPath, 'png-2');
  const after = resolveStillsTarget(workspace.dir, readProjectManifest(workspace.dir));
  assert.notEqual(inputsSha256(after), inputsSha256(before), 'пересобранный под тем же путём пакет меняет отпечаток');
  const root = tmp(t);
  const { deps } = stubs();
  const result = await renderMomentStills({ target: { ...after, withMedia: null, publicDir: null }, moments: moments.slice(0, 1), outDir: path.join(root, 'qa'), name: 'n', log: () => {} }, deps);
  const index = JSON.parse(fs.readFileSync(result.indexPath, 'utf8'));
  assert.equal(index.kind, 'motion-reel');
  assert.equal(index.briefSha256, after.briefSha256);
  assert.equal(stillsIndexStale(workspace.dir, readProjectManifest(workspace.dir), index), null);
});

test('resolveStillsTarget: слой без out/manifest.json – «сначала automontage layer check»', { skip: !hasFfmpeg }, (t) => {
  const { projectDir } = makeLayerProject(t, { seconds: 2 });
  fakeLayer(projectDir, { manifest: false });
  assert.throws(() => resolveStillsTarget(projectDir, readProjectManifest(projectDir)),
    (error) => error.message.includes('сначала `automontage layer check`') && error.code === 'CRITIC_STILLS_REFUSED');
});

test('resolveStillsTarget: src/ слоя изменилась после layer check – манифест устарел, «сначала automontage layer check»', { skip: !hasFfmpeg }, (t) => {
  const { projectDir } = makeLayerProject(t, { seconds: 2 });
  const layerDir = fakeLayer(projectDir);
  assert.equal(resolveStillsTarget(projectDir, readProjectManifest(projectDir)).kind, 'layer');
  fs.writeFileSync(path.join(layerDir, 'src', 'plan.js'), 'export const plan = { texts: [1] };\n');
  assert.throws(() => resolveStillsTarget(projectDir, readProjectManifest(projectDir)),
    (error) => error.message.includes('устарел') && error.message.includes('сначала `automontage layer check`') && error.code === 'CRITIC_STILLS_REFUSED');
});

test('resolveStillsTarget: манифест без srcSha256 (старый layer check) – отказ с подсказкой', { skip: !hasFfmpeg }, (t) => {
  const { projectDir } = makeLayerProject(t, { seconds: 2 });
  fakeLayer(projectDir, { srcSha256: false });
  assert.throws(() => resolveStillsTarget(projectDir, readProjectManifest(projectDir)),
    (error) => error.message.includes('сначала `automontage layer check`') && error.code === 'CRITIC_STILLS_REFUSED');
});

// Скиллы обещают: слой должен пройти layer check, иначе кадры stills отказывают. Манифест layer check
// пишет до гейтов, поэтому одного манифеста мало – нужен отчёт без провала к этому самому манифесту.
const refusedWithCheck = (pattern) => (error) => error.code === 'CRITIC_STILLS_REFUSED'
  && pattern.test(error.message) && error.message.includes('automontage layer check');

test('resolveStillsTarget: layer check слоя провален (СТОП) – отказ, кадры не рисуются', { skip: !hasFfmpeg }, (t) => {
  const { projectDir } = makeLayerProject(t, { seconds: 2 });
  fakeLayer(projectDir, { check: 'fail' });
  assert.throws(() => resolveStillsTarget(projectDir, readProjectManifest(projectDir)), refusedWithCheck(/не пройден/u));
});

test('resolveStillsTarget: layer check закончился ошибкой – отказ', { skip: !hasFfmpeg }, (t) => {
  const { projectDir } = makeLayerProject(t, { seconds: 2 });
  fakeLayer(projectDir, { check: 'error' });
  assert.throws(() => resolveStillsTarget(projectDir, readProjectManifest(projectDir)), refusedWithCheck(/не пройден/u));
});

test('resolveStillsTarget: манифест есть, а отчёта layer check нет – отказ', { skip: !hasFfmpeg }, (t) => {
  const { projectDir } = makeLayerProject(t, { seconds: 2 });
  fakeLayer(projectDir, { check: false });
  assert.throws(() => resolveStillsTarget(projectDir, readProjectManifest(projectDir)), refusedWithCheck(/нет отчёта/u));
});

test('resolveStillsTarget: отчёт layer check к другому манифесту – отказ', { skip: !hasFfmpeg }, (t) => {
  const { projectDir } = makeLayerProject(t, { seconds: 2 });
  fakeLayer(projectDir, { check: false });
  writeCheckReport(projectDir, 'motion-v01', { sha256: '0'.repeat(64) });
  assert.throws(() => resolveStillsTarget(projectDir, readProjectManifest(projectDir)), refusedWithCheck(/другому манифесту/u));
});

test('resolveStillsTarget: layer check с предупреждениями – кадры рисуются', { skip: !hasFfmpeg }, (t) => {
  const { projectDir } = makeLayerProject(t, { seconds: 2 });
  fakeLayer(projectDir, { check: 'warn' });
  assert.equal(resolveStillsTarget(projectDir, readProjectManifest(projectDir)).kind, 'layer');
});

test('layer sheet --source stills: layer check провален – код 2 и подсказка', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir } = makeLayerProject(t, { seconds: 2 });
  fakeLayer(projectDir, { check: 'fail' });
  const errors = [];
  let drawn = 0;
  const code = await sheet.run({ 'project-dir': projectDir, mode: 'moments', source: 'stills' }, {
    log: () => {}, warn: (l) => errors.push(l), renderStillsImpl: async () => { drawn += 1; },
  });
  assert.equal(code, 2);
  assert.equal(drawn, 0);
  assert.match(errors.join('\n'), /не пройден/u);
});

test('stillsIndexStale: кадры старого слоя устарели, когда появился новый слой', { skip: !hasFfmpeg }, (t) => {
  const { projectDir } = makeLayerProject(t, { seconds: 2 });
  fakeLayer(projectDir, { name: 'motion-v01' });
  const manifest = readProjectManifest(projectDir);
  const index = { kind: 'layer', layer: 'motion-v01', inputsSha256: inputsSha256(resolveStillsTarget(projectDir, manifest)) };
  assert.equal(stillsIndexStale(projectDir, manifest, index), null);
  fakeLayer(projectDir, { name: 'motion-v02' });
  assert.match(stillsIndexStale(projectDir, manifest, index), /motion-v02/u);
});

test('resolveStillsTarget motion-reel: --layer – отказ, без --layer – цель motion-reel', (t) => {
  const { fixture } = require('./helpers/motion-workflow-fixture.cjs');
  const { workspace } = fixture(t);
  const manifest = readProjectManifest(workspace.dir);
  assert.throws(() => resolveStillsTarget(workspace.dir, manifest, { layer: 'motion-v01' }),
    (error) => error.code === 'CRITIC_STILLS_REFUSED' && /--layer/u.test(error.message) && /motion-reel/u.test(error.message));
  assert.equal(resolveStillsTarget(workspace.dir, manifest, { layer: null }).kind, 'motion-reel');
});

test('layer sheet --source stills у motion-reel: --layer – код 2, кадры не рисуются', async (t) => {
  const { fixture } = require('./helpers/motion-workflow-fixture.cjs');
  const { workspace } = fixture(t);
  const errors = [];
  let drawn = 0;
  const code = await sheet.run({ 'project-dir': workspace.dir, mode: 'moments', layer: 'motion-v01' }, {
    log: () => {}, warn: (l) => errors.push(l), renderStillsImpl: async () => { drawn += 1; },
  });
  assert.equal(code, 2);
  assert.equal(drawn, 0);
  assert.match(errors.join('\n'), /--layer/u);
});

test('layerSrcSha256: любой файл src/ (и вложенный) меняет отпечаток', (t) => {
  const layerDir = tmp(t);
  fs.mkdirSync(path.join(layerDir, 'src', 'parts'), { recursive: true });
  fs.writeFileSync(path.join(layerDir, 'src', 'plan.js'), 'a');
  const before = layerSrcSha256(layerDir);
  assert.equal(layerSrcSha256(layerDir), before);
  fs.writeFileSync(path.join(layerDir, 'src', 'parts', 'X.jsx'), 'b');
  assert.notEqual(layerSrcSha256(layerDir), before);
});

test('resolveStillsTarget: урок без слоя – «критик только для моушн-роликов»', { skip: !hasFfmpeg }, (t) => {
  const { projectDir } = makeLayerProject(t, { seconds: 2 });
  assert.throws(() => resolveStillsTarget(projectDir, readProjectManifest(projectDir)),
    (error) => error.message.includes('критик только для моушн-роликов') && error.code === 'CRITIC_STILLS_REFUSED');
});

test('resolveStillsTarget: последний слой – entry, композиция, public, геометрия и манифест', { skip: !hasFfmpeg }, (t) => {
  const { projectDir } = makeLayerProject(t, { seconds: 2 });
  fakeLayer(projectDir, { name: 'motion-v01', manifest: false });
  const layerDir = fakeLayer(projectDir, { name: 'motion-v02' });
  const target = resolveStillsTarget(projectDir, readProjectManifest(projectDir));
  assert.equal(target.kind, 'layer');
  assert.equal(target.layerName, 'motion-v02');
  assert.equal(target.entry, path.join(layerDir, 'src', 'index.jsx'));
  assert.equal(target.compositionId, 'Layer');
  assert.equal(target.publicDir, path.join(layerDir, 'public'));
  assert.equal(target.planPath, path.join(layerDir, 'src', 'plan.js'));
  assert.deepEqual(target.inputProps, {});
  assert.deepEqual([target.width, target.height, target.fps, target.durationSec], [1080, 1920, 25, 4]);
  assert.equal(target.manifest.fps, 25);
  assert.equal(resolveStillsTarget(projectDir, readProjectManifest(projectDir), { layer: 'motion-v02' }).layerName, 'motion-v02');
});

test('resolveStillsTarget: motion-reel – MotionReel с props черновика ТЗ', (t) => {
  const { fixture } = require('./helpers/motion-workflow-fixture.cjs');
  const { workspace } = fixture(t);
  const target = resolveStillsTarget(workspace.dir, readProjectManifest(workspace.dir));
  assert.equal(target.kind, 'motion-reel');
  assert.equal(target.compositionId, 'MotionReel');
  assert.equal(path.basename(target.entry), 'index.js');
  assert.deepEqual([target.width, target.height, target.fps, target.durationSec], [320, 568, 30, 2]);
  assert.equal(target.inputProps.draftPreview, true);
  assert.equal(typeof target.withMedia, 'function');
  assert.match(target.sourceSha256, /^[a-f0-9]{64}$/u);
});

test('layer sheet --mode moments: по умолчанию stills; у урока код 2 и «критик только для моушн-роликов»', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir } = makeLayerProject(t, { seconds: 2 });
  const errors = [];
  const code = await sheet.run({ 'project-dir': projectDir, mode: 'moments' }, { log: () => {}, warn: (l) => errors.push(l) });
  assert.equal(code, 2);
  assert.match(errors.join('\n'), /критик только для моушн-роликов/u);
});

test('layer sheet --source stills: слой без layer check – код 2 и подсказка', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir } = makeLayerProject(t, { seconds: 2 });
  fakeLayer(projectDir, { manifest: false });
  const errors = [];
  const code = await sheet.run({ 'project-dir': projectDir, mode: 'moments', source: 'stills' }, { log: () => {}, warn: (l) => errors.push(l) });
  assert.equal(code, 2);
  assert.match(errors.join('\n'), /сначала `automontage layer check`/u);
});

test('layer sheet --source stills: моменты из манифеста слоя, кадры через renderMomentStills', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir } = makeLayerProject(t, { seconds: 2 });
  fakeLayer(projectDir);
  const seen = [];
  const lines = [];
  const code = await sheet.run({ 'project-dir': projectDir, mode: 'moments', source: 'stills' }, {
    log: (l) => lines.push(l), warn: () => {},
    renderStillsImpl: async (input) => {
      seen.push(input);
      return { framesDir: 'f', sheetPath: 's.jpg', phonePath: 'p.jpg', indexPath: 'i.json', inputsSha256: 'c'.repeat(64), gate: require('../scripts/qa/empty-frame-gate').emptyFrameGate([]) };
    },
  });
  assert.equal(code, 0);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].target.kind, 'layer');
  assert.ok(seen[0].moments.length > 0);
  assert.match(seen[0].name, /^moments-stills-[a-f0-9]{8}$/u);
  assert.equal(seen[0].name, `moments-stills-${seen[0].sha.slice(0, 8)}`, 'имя и индекс – от одного sha');
  assert.ok(lines.some((l) => l.includes('i.json')));
});

test('layer sheet --source stills: после записи остаются 2 последних набора stills, preview не трогается', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir } = makeLayerProject(t, { seconds: 2 });
  fakeLayer(projectDir);
  const qa = path.join(projectDir, 'qa');
  fs.mkdirSync(qa, { recursive: true });
  const writeSet = (name, minutesAgo) => {
    fs.mkdirSync(path.join(qa, name), { recursive: true });
    fs.writeFileSync(path.join(qa, name, '01-0.jpg'), 'f');
    for (const suffix of ['.jpg', '-phone.jpg', '.json']) fs.writeFileSync(path.join(qa, `${name}${suffix}`), '{}');
    const when = new Date(Date.now() - minutesAgo * 60_000);
    fs.utimesSync(path.join(qa, `${name}.json`), when, when);
  };
  ['moments-stills-00000001', 'moments-stills-00000002', 'moments-stills-00000003'].forEach((name, index) => writeSet(name, 30 - index * 10));
  writeSet('moments-00000009', 60);
  fs.writeFileSync(path.join(qa, 'critic-01.json'), '{}');
  const code = await sheet.run({ 'project-dir': projectDir, mode: 'moments', source: 'stills' }, {
    log: () => {}, warn: () => {},
    renderStillsImpl: async (input) => {
      writeSet(input.name, 0);
      const file = (suffix) => path.join(input.outDir, `${input.name}${suffix}`);
      return { framesDir: path.join(input.outDir, input.name), sheetPath: file('.jpg'), phonePath: file('-phone.jpg'), indexPath: file('.json'), inputsSha256: input.sha, gate: require('../scripts/qa/empty-frame-gate').emptyFrameGate([]) };
    },
  });
  assert.equal(code, 0);
  const left = fs.readdirSync(qa).filter((name) => /^moments-.*\.json$/u.test(name)).sort();
  assert.equal(left.length, 3);
  assert.ok(left.includes('moments-00000009.json'));
  assert.ok(left.includes('moments-stills-00000003.json'));
  assert.ok(fs.existsSync(path.join(qa, 'critic-01.json')));
  assert.ok(!fs.existsSync(path.join(qa, 'moments-stills-00000001')));
  assert.ok(!fs.existsSync(path.join(qa, 'moments-stills-00000002.jpg')));
});

test('layer sheet: неизвестный --source и --source вне moments – код 2', async () => {
  const errors = [];
  assert.equal(await sheet.run({ 'project-dir': '/nonexistent', mode: 'moments', source: 'x' }, { log: () => {}, warn: (l) => errors.push(l) }), 2);
  assert.match(errors.join('\n'), /stills.*preview/u);
  assert.equal(await sheet.run({ 'project-dir': '/nonexistent', mode: 'even', source: 'stills' }, { log: () => {}, warn: (l) => errors.push(l) }), 2);
});

// Настоящий Remotion (опт-ин): шаблон слоя 1080×1920 после layer check, 2 кадра шириной 405 px.
test('real Remotion: кадры моментов шаблона слоя 405×720', {
  skip: process.env.AUTOMONTAGE_TEST_MOTION_RENDER !== '1', timeout: 300_000,
}, async (t) => {
  const { execFileSync } = require('node:child_process');
  const newLayer = require('../scripts/layer/new');
  const check = require('../scripts/layer/check');
  const { projectDir, sfxDir } = makeLayerProject(t, { seconds: 4, size: '1080x1920' });
  const previousSfxDir = process.env.AUTOMONTAGE_SFX_DIR;
  process.env.AUTOMONTAGE_SFX_DIR = sfxDir;
  t.after(() => {
    if (previousSfxDir === undefined) delete process.env.AUTOMONTAGE_SFX_DIR;
    else process.env.AUTOMONTAGE_SFX_DIR = previousSfxDir;
  });
  assert.equal(await newLayer.run({ 'project-dir': projectDir }, { log: () => {}, warn: () => {} }), 0);
  await check.run({ 'project-dir': projectDir, layer: 'motion-v01' }, { log: () => {} });
  const target = resolveStillsTarget(projectDir, readProjectManifest(projectDir));
  const outDir = path.join(projectDir, 'qa');
  const result = await renderMomentStills({
    target, outDir, name: 'moments-stills-real', log: () => {},
    moments: [{ timeSec: 0.5, kind: 'even', ref: 'a', label: 'a' }, { timeSec: 2, kind: 'even', ref: 'b', label: 'b' }],
  });
  const frames = fs.readdirSync(result.framesDir).sort();
  assert.equal(frames.length, 2);
  for (const frame of frames) {
    const size = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0',
      path.join(result.framesDir, frame)], { encoding: 'utf8' }).trim();
    assert.equal(size, '405,720');
  }
});

test('renderMomentStills: горизонтальная цель – формат horizontal в индексе, плитке отдан размер 1920x1080', async (t) => {
  const root = tmp(t);
  const target = { ...layerTarget(root), width: 1920, height: 1080 };
  const { deps } = stubs();
  let tiled = null;
  const tile = (frames, opts) => {
    tiled = opts;
    return { sheetPath: 's.jpg', phonePath: 'p.jpg' };
  };
  const result = await renderMomentStills({ target, moments, outDir: path.join(root, 'qa'), name: 'moments-stills-h', log: () => {} }, { ...deps, tile });
  assert.deepEqual(JSON.parse(fs.readFileSync(result.indexPath, 'utf8')).format, { aspect: 'horizontal', width: 1920, height: 1080 });
  assert.equal(tiled.width, 1920);
  assert.equal(tiled.height, 1080);
});
