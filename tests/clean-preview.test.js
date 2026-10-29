// Чистый preview (#110): полный preview в масштабе 1 рендерится в качестве финала – без --crf=28 и без
// вшитого «ЧЕРНОВИК»; фрагмент и 4K (масштаб < 1) остаются черновыми: CRF 28 и надпись вшита.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runPreview } = require('../scripts/preview');
const { isCleanPreview } = require('../scripts/working-quality');
const { prepareLessonPreview } = require('../scripts/lesson/preview');
const { createOrOpenProject, publishBriefRevision, readProjectManifest } = require('../scripts/project/workspace');

function makeProject(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-clean-preview-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'speaker.mp4');
  fs.writeFileSync(source, 'source-video');
  const workspace = createOrOpenProject({
    projectDir: path.join(root, 'project'), name: 'Clean preview', sourcePath: source,
    now: new Date('2026-10-18T10:00:00.000Z'),
  });
  const brief = {
    version: 1, status: 'draft', source: workspace.sourcePath, theme: 'lesson-neutral', title: 'ЧИСТЫЙ',
    output: { aspect: 'horizontal', width: 320, height: 180, fps: 25, durationInFrames: 100 },
    corrections: [],
    scenes: [{ scene: 'fullscreen', start: 0, end: 4, caption: 'СМОНТИРОВАНО' }],
  };
  const published = publishBriefRevision(workspace, { brief, markdown: '# Clean\n' });
  return { workspace, published };
}

// Подставные инструменты: запоминают аргументы Remotion и props, которые он получил бы.
function tools(seen, probe = { width: 320, height: 180, fps: 25, duration: 4 }) {
  let id = 0;
  return {
    resolveRemotionCommandImpl: () => ({ command: process.execPath, argsPrefix: ['remotion.js'] }),
    runToolImpl(command, args, options) {
      if (options.stage === 'preview Remotion') {
        seen.args = args;
        seen.props = JSON.parse(fs.readFileSync(args[args.indexOf('--props') + 1], 'utf8'));
        fs.writeFileSync(args[4], 'raw');
      }
    },
    runNodeToolImpl(script, args, options) {
      if (options.stage === 'preview finish') fs.writeFileSync(args[1], 'finished');
    },
    probeVideoImpl: () => probe,
    openMediaFileImpl: () => {},
    now: () => new Date('2026-10-18T10:05:00.000Z'),
    temporaryId: () => `00000000-0000-4000-8000-${String(id += 1).padStart(12, '0')}`,
    log: () => {},
    acquireSlotSync: () => ({ release() {} }),
  };
}

test('isCleanPreview: only a full range rendered at scale 1 is final quality', () => {
  const full = { kind: 'full' };
  const excerpt = { kind: 'excerpt' };
  assert.equal(isCleanPreview({ range: full, size: { width: 1920, height: 1080 } }), true);
  assert.equal(isCleanPreview({ range: full, size: { width: 1080, height: 1920 } }), true);
  assert.equal(isCleanPreview({ range: excerpt, size: { width: 1920, height: 1080 } }), false);
  assert.equal(isCleanPreview({ range: full, size: { width: 3840, height: 2160 } }), false);
  assert.equal(isCleanPreview({ range: full, size: { width: 2048, height: 1080 } }), false);
});

test('full 1080p-or-smaller preview renders like final: no --crf, no draftPreview, quality "final"', (t) => {
  const fixture = makeProject(t);
  const seen = {};
  const result = runPreview({ projectDir: fixture.workspace.dir, briefPath: fixture.published.relativePath, open: false },
    tools(seen));
  assert.equal(seen.args.some((arg) => arg.startsWith('--crf')), false, seen.args.join(' '));
  assert.equal(Object.hasOwn(seen.props, 'draftPreview'), false);
  assert.equal(result.metadata.quality, 'final');
  assert.equal(readProjectManifest(fixture.workspace.dir).currentPreview.quality, 'final');
});

test('excerpt preview keeps draft quality: --crf=28 and the burned-in watermark', (t) => {
  const fixture = makeProject(t);
  const seen = {};
  const result = runPreview({
    projectDir: fixture.workspace.dir, briefPath: fixture.published.relativePath, open: false, fromSec: 1, toSec: 3,
  }, tools(seen, { width: 320, height: 180, fps: 25, duration: 2 }));
  assert.ok(seen.args.includes('--crf=28'), seen.args.join(' '));
  assert.equal(seen.props.draftPreview, true);
  assert.equal(result.metadata.quality, 'draft');
});

test('4K preview (scale 0.5) keeps draft quality: --crf=28 and the burned-in watermark', (t) => {
  const fixture = makeProject(t);
  const seen = {};
  const result = runPreview({ projectDir: fixture.workspace.dir, briefPath: fixture.published.relativePath, open: false }, {
    ...tools(seen, { width: 1920, height: 1080, fps: 25, duration: 4 }),
    prepareLessonPreviewImpl(options) {
      const prepared = prepareLessonPreview(options);
      prepared.props.width = 3840; prepared.props.height = 2160;
      return prepared;
    },
  });
  assert.ok(seen.args.includes('--crf=28'));
  assert.ok(seen.args.includes('--scale=0.5'));
  assert.equal(seen.props.draftPreview, true);
  assert.equal(result.metadata.quality, 'draft');
});

test('clean preview props equal the approved render props byte-for-byte', () => {
  const { buildDraftPreviewProps, buildReelScenesProps } = require('../scripts/lesson/brief');
  const draft = {
    version: 1, status: 'draft', source: '/tmp/source.mp4', theme: 'lesson-neutral', title: 'Т',
    output: { aspect: 'horizontal', width: 1920, height: 1080, fps: 25, durationInFrames: 100 },
    corrections: [], scenes: [{ scene: 'fullscreen', start: 0, end: 4, caption: 'А' }],
  };
  const { cleanPreviewProps } = require('../scripts/preview');
  const clean = cleanPreviewProps(buildDraftPreviewProps({ brief: draft, theme: 'lesson-neutral' }));
  const final = buildReelScenesProps({ brief: { ...draft, status: 'approved' }, theme: 'lesson-neutral', includeMusic: false });
  assert.equal(JSON.stringify(clean), JSON.stringify(final));
});
