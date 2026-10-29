// Условия быстрого пути preview слоя kit (#110, D-051) и выбор пути в runPreview. Эквивалентность кадров и
// звука с настоящим Remotion – tests/layer-fast-preview-equivalence.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { kitFastPathCommand, planKitFastPath } = require('../scripts/layer/fast-preview');
const { runPreview } = require('../scripts/preview');
const { createOrOpenProject, publishBriefRevision, readProjectManifest } = require('../scripts/project/workspace');

const SHA = 'a'.repeat(64);
const PROPS = { width: 1080, height: 1920, fps: 25, durationInFrames: 250 };
const FULL = { kind: 'full', fromSec: 0, toSec: 10, fromFrame: 0, toFrameExclusive: 250 };

function layerBrief(overrides = {}, mediaOverrides = {}) {
  return {
    scenes: [{
      scene: 'broll', start: 0, end: 10, ...overrides,
      brollMedia: {
        kind: 'video', src: 'assets/broll/video/layer01/media.mp4', sha256: SHA, trimStartSec: 0,
        fit: 'cover', audioMode: 'mix', overlay: 'none', ...mediaOverrides,
      },
    }],
  };
}

function projectWithLayer(t) {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-fast-plan-'));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  const file = path.join(projectDir, 'assets', 'broll', 'video', 'layer01', 'media.mp4');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'layer');
  return projectDir;
}

const okDeps = {
  registryProblem: () => null,
  probeImpl: () => ({ width: 1080, height: 1920, fps: 25, duration: 10.04 }),
  hashImpl: () => SHA,
  countFramesImpl: () => 251,
};

function plan(t, { brief = layerBrief(), clean = true, range = FULL, deps = okDeps } = {}) {
  return planKitFastPath({ projectDir: projectWithLayer(t), brief, props: PROPS, range, clean, sourceSha256: 'b'.repeat(64) }, deps);
}

test('a single full-length checked kit layer takes the fast path', (t) => {
  const result = plan(t);
  assert.equal(result.reason, undefined);
  assert.equal(result.frames, 250);
  assert.equal(result.fps, 25);
  assert.equal(result.audioMode, 'mix');
  assert.match(result.layerPath, /layer01[\\/]media\.mp4$/u);
});

const refusals = [
  ['an excerpt or a 4K preview', { clean: false }, /не чистый полный preview/u],
  ['two scenes', { brief: { scenes: [...layerBrief().scenes, { scene: 'fullscreen', start: 10, end: 12 }] } }, /не одна сцена broll/u],
  ['a scene that does not cover the whole video', { brief: layerBrief({ end: 9 }) }, /не на весь ролик/u],
  ['the default overlay of the engine', { brief: layerBrief({}, { overlay: 'default' }) }, /не чистый полноразмерный слой/u],
  ['a trimmed layer start', { brief: layerBrief({}, { trimStartSec: 1 }) }, /не чистый полноразмерный слой/u],
  ['a contain fit', { brief: layerBrief({}, { fit: 'contain' }) }, /не чистый полноразмерный слой/u],
  ['an image b-roll', { brief: layerBrief({}, { kind: 'image' }) }, /не чистый полноразмерный слой/u],
  ['a video outside the kit registry', { deps: { ...okDeps, registryProblem: () => 'видео не импортировано как слой kit' } }, /не импортировано/u],
  ['a layer whose render report failed', { deps: { ...okDeps, registryProblem: () => 'G6 стоп' } }, /реестра: G6 стоп/u],
  ['a layer of another size', { deps: { ...okDeps, probeImpl: () => ({ width: 540, height: 960, fps: 25, duration: 10 }) } }, /размер или FPS/u],
  ['a layer of another FPS', { deps: { ...okDeps, probeImpl: () => ({ width: 1080, height: 1920, fps: 30, duration: 10 }) } }, /размер или FPS/u],
  ['a layer shorter than the video', { deps: { ...okDeps, probeImpl: () => ({ width: 1080, height: 1920, fps: 25, duration: 9.9 }) } }, /короче/u],
  ['a layer with fewer packets than the video frames', { deps: { ...okDeps, countFramesImpl: () => 249 } }, /короче/u],
  ['layer bytes that differ from the brief', { deps: { ...okDeps, hashImpl: () => 'c'.repeat(64) } }, /байты слоя/u],
];

for (const [name, input, reason] of refusals) {
  test(`fast path refuses ${name} – Remotion renders as usual`, (t) => {
    const result = plan(t, input);
    assert.match(result.reason, reason);
  });
}

test('fast path command copies the layer video and mixes voice with the enveloped layer sound', () => {
  const mix = kitFastPathCommand({ layerPath: '/p/layer.mp4', sourcePath: '/p/source.mp4', output: '/p/raw.mp4', frames: 250, fps: 25, audioMode: 'mix' });
  const args = mix.args;
  assert.equal(mix.command, 'ffmpeg');
  assert.deepEqual(args.slice(args.indexOf('-map'), args.indexOf('-map') + 6), ['-map', '0:v:0', '-c:v', 'copy', '-frames:v', '250']);
  const filter = args[args.indexOf('-filter_complex') + 1];
  // −18 дБ и огибающая 0,12 с = 3 кадра при 25 fps, как brollClipVolume в src/scenes/BrollMedia.jsx.
  assert.match(filter, /volume='0\.12589254\*max\(0,min\(1,min\(floor\(t\*25\+0\.000001\)\/3,\(249-floor\(t\*25\+0\.000001\)\)\/3\)\)\)':eval=frame/u);
  assert.match(filter, /amix=inputs=2:duration=first:dropout_transition=0:normalize=0/u);
  assert.match(filter, /atrim=end=10,/u);
  const mute = kitFastPathCommand({ layerPath: '/p/layer.mp4', sourcePath: '/p/source.mp4', output: '/p/raw.mp4', frames: 250, fps: 25, audioMode: 'mute' });
  assert.doesNotMatch(mute.args[mute.args.indexOf('-filter_complex') + 1], /\[0:a\]/u);
});

function makeProject(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-fast-preview-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'speaker.mp4');
  fs.writeFileSync(source, 'source-video');
  const workspace = createOrOpenProject({ projectDir: path.join(root, 'project'), name: 'Fast', sourcePath: source });
  const brief = {
    version: 1, status: 'draft', source: workspace.sourcePath, theme: 'lesson-neutral', title: 'СЛОЙ',
    output: { aspect: 'horizontal', width: 320, height: 180, fps: 25, durationInFrames: 100 },
    corrections: [], scenes: [{ scene: 'fullscreen', start: 0, end: 4, caption: 'А' }],
  };
  const published = publishBriefRevision(workspace, { brief, markdown: '# Fast\n' });
  return { workspace, published };
}

function tools(calls) {
  let id = 0;
  return {
    resolveRemotionCommandImpl: () => ({ command: process.execPath, argsPrefix: ['remotion.js'] }),
    runToolImpl(command, args, options) {
      calls.push([options.stage, args]);
      if (options.stage === 'preview Remotion') fs.writeFileSync(args[4], 'raw');
      if (options.stage === 'preview kit layer') fs.writeFileSync(args.at(-1), 'raw');
    },
    runNodeToolImpl(script, args, options) {
      calls.push([options.stage, args]);
      if (options.stage === 'preview finish') fs.writeFileSync(args[1], 'finished');
    },
    probeVideoImpl: () => ({ width: 320, height: 180, fps: 25, duration: 4 }),
    openMediaFileImpl: () => {},
    now: () => new Date('2026-10-18T10:05:00.000Z'),
    temporaryId: () => `00000000-0000-4000-8000-${String(id += 1).padStart(12, '0')}`,
    log: () => {},
    acquireSlotSync: () => ({ release() {} }),
  };
}

test('runPreview builds a kit layer preview without Remotion and finishes audio without the Remotion shift', (t) => {
  const fixture = makeProject(t);
  const calls = [];
  const layerPath = path.join(fixture.workspace.dir, 'layer.mp4');
  const result = runPreview({ projectDir: fixture.workspace.dir, briefPath: fixture.published.relativePath, open: false }, {
    ...tools(calls),
    planKitFastPathImpl: ({ clean, range }) => {
      assert.equal(clean, true);
      assert.equal(range.kind, 'full');
      return { layerPath, audioMode: 'mix', frames: 100, fps: 25, durationSec: 4 };
    },
    withPreviewMediaBundleImpl: () => assert.fail('the fast path must not bundle media for Remotion'),
  });
  assert.deepEqual(calls.map(([stage]) => stage), ['preview kit layer', 'preview finish', 'preview decode']);
  const kitArgs = calls[0][1];
  assert.equal(kitArgs[kitArgs.indexOf('-i') + 1], layerPath);
  const finishArgs = calls[1][1];
  assert.equal(finishArgs[finishArgs.indexOf('--audio-advance-ms') + 1], '0');
  assert.equal(result.metadata.quality, 'final');
  assert.equal(readProjectManifest(fixture.workspace.dir).currentPreview.quality, 'final');
});

test('runPreview falls back to Remotion when the fast path refuses', (t) => {
  const fixture = makeProject(t);
  const calls = [];
  runPreview({ projectDir: fixture.workspace.dir, briefPath: fixture.published.relativePath, open: false }, {
    ...tools(calls),
    planKitFastPathImpl: () => ({ reason: 'слой короче ролика', kit: true }),
  });
  assert.deepEqual(calls.map(([stage]) => stage), ['preview Remotion', 'preview finish', 'preview decode']);
  const finishArgs = calls[1][1];
  assert.equal(finishArgs[finishArgs.indexOf('--audio-advance-ms') + 1], '0');
});

test('regression: a layer longer than the video is re-encoded to the exact frame count, never stream-copied', () => {
  const exact = kitFastPathCommand({ layerPath: '/p/l.mp4', sourcePath: '/p/s.mp4', output: '/p/r.mp4', frames: 250, fps: 25, audioMode: 'mute', layerFrames: 250 });
  assert.ok(exact.args.includes('copy'));
  const longer = kitFastPathCommand({ layerPath: '/p/l.mp4', sourcePath: '/p/s.mp4', output: '/p/r.mp4', frames: 250, fps: 25, audioMode: 'mute', layerFrames: 251 });
  assert.equal(longer.args.includes('copy'), false);
  assert.deepEqual(longer.args.slice(longer.args.indexOf('-c:v'), longer.args.indexOf('-c:v') + 4), ['-c:v', 'libx264', '-crf', '18']);
  assert.equal(longer.args[longer.args.indexOf('-frames:v') + 1], '250');
});
