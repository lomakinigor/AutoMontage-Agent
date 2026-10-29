// Продвижение чистого preview в финал (#110, D-051): после утверждения проверенный по sha256 полный чистый
// preview копируется в renders/vNN-preview/final.mp4 и final/<slug>.mp4 – без второго рендера.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');

const { planPreview, publishCurrentPreview } = require('../scripts/project/preview-workspace');
const {
  approveBrief, createOrOpenProject, publishBriefRevision, readProjectManifest,
} = require('../scripts/project/workspace');
const { promoteApprovedPreview } = require('../scripts/project/promote-preview');
const { deriveVariantStatus } = require('../scripts/pult/status');

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const ROOT = path.resolve(__dirname, '..');

function makeProject(t, { width = 320, height = 180 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-promote-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'speaker.mp4');
  fs.writeFileSync(source, 'source-video');
  const workspace = createOrOpenProject({
    projectDir: path.join(root, 'project'), name: 'Promote test', sourcePath: source,
    now: new Date('2026-10-18T10:00:00.000Z'),
  });
  const brief = {
    version: 1, status: 'draft', source: workspace.sourcePath, theme: 'lesson-neutral', title: 'ФИНАЛ',
    output: { aspect: 'source', width, height, fps: 25, durationInFrames: 100 },
    corrections: [],
    scenes: [{ scene: 'fullscreen', start: 0, end: 4, caption: 'СМОНТИРОВАНО' }],
  };
  const published = publishBriefRevision(workspace, { brief, markdown: '# Promote\n' });
  return { root, workspace, published };
}

// Публикует preview так же, как runPreview: с sha256 черновика и исходника.
function publishPreview(fixture, { bytes = 'clean-preview-bytes', quality = 'final', range, width, height } = {}) {
  const { workspace, published } = fixture;
  workspace.manifest = readProjectManifest(workspace.dir);
  const planned = planPreview(workspace, {
    briefPath: published.jsonPath,
    briefSha256: sha(fs.readFileSync(published.jsonPath)),
    range: range || { kind: 'full', fromSec: 0, toSec: 4, fromFrame: 0, toFrameExclusive: 100 },
  });
  const staged = path.join(workspace.dir, 'previews', '.staged.mp4');
  fs.writeFileSync(staged, bytes);
  const result = publishCurrentPreview(workspace, planned, staged, {
    width: width ?? 320, height: height ?? 180, fps: 25,
    generatedAt: '2026-10-18T10:05:00.000Z', quality,
  });
  fs.unlinkSync(staged);
  return result;
}

function approve(fixture) {
  const { workspace, published } = fixture;
  workspace.manifest = readProjectManifest(workspace.dir);
  return approveBrief(workspace, published.jsonPath, { root: ROOT, confirmPreviewViewed: true });
}

function promote(fixture, approved, options = {}) {
  return promoteApprovedPreview(fixture.workspace, approved.jsonPath, options);
}

test('approved clean full preview is promoted to final by copy: same sha256, complete render, card is ready', (t) => {
  const fixture = makeProject(t);
  publishPreview(fixture);
  const approved = approve(fixture);
  const result = promote(fixture, approved);
  const manifest = readProjectManifest(fixture.workspace.dir);
  const expected = sha('clean-preview-bytes');

  assert.equal(result.promoted, true);
  assert.equal(result.sha256, expected);
  assert.equal(sha(fs.readFileSync(path.join(fixture.workspace.dir, 'final', 'promote-test.mp4'))), expected);
  assert.equal(sha(fs.readFileSync(path.join(fixture.workspace.dir, 'renders', 'v01-preview', 'final.mp4'))), expected);
  assert.deepEqual(manifest.renders, [{
    version: 1, label: 'preview', dir: 'renders/v01-preview', briefPath: 'brief/v01-approved.lesson.json',
    status: 'complete', source: 'preview', sha256: expected,
  }]);
  assert.equal(manifest.latestRender, 'renders/v01-preview');
  // Финал не ссылается на файл в previews/: clean может удалить preview, финал останется.
  fs.rmSync(path.join(fixture.workspace.dir, 'previews'), { recursive: true });
  assert.equal(sha(fs.readFileSync(path.join(fixture.workspace.dir, 'final', 'promote-test.mp4'))), expected);

  const status = deriveVariantStatus({
    manifest, currentBriefStatus: 'approved', currentBriefSha256: null, finalExists: true,
  });
  assert.equal(status.status, 'ready');
  assert.equal(status.nextStep, 'Готов – можно забирать');
  assert.equal(status.needsFinal, false);
});

test('repeating promotion of the same approval is idempotent: no second render, final unchanged', (t) => {
  const fixture = makeProject(t);
  publishPreview(fixture);
  const approved = approve(fixture);
  promote(fixture, approved);
  const before = fs.readFileSync(path.join(fixture.workspace.dir, 'project.json'));
  const again = promote(fixture, approved);
  assert.equal(again.promoted, true);
  assert.equal(again.already, true);
  assert.deepEqual(fs.readFileSync(path.join(fixture.workspace.dir, 'project.json')), before);
  assert.deepEqual(fs.readdirSync(path.join(fixture.workspace.dir, 'renders')), ['v01-preview']);
});

const refusals = [
  ['draft-quality preview (fragment or 4K render)', (fixture) => publishPreview(fixture, { quality: 'draft' }), /черновом качестве/u],
  ['preview from before #110 without the quality mark', (fixture) => {
    publishPreview(fixture);
    const file = path.join(fixture.workspace.dir, 'project.json');
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete manifest.currentPreview.quality;
    fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  }, /черновом качестве/u],
  ['excerpt preview', (fixture) => publishPreview(fixture, {
    range: { kind: 'excerpt', fromSec: 1, toSec: 3, fromFrame: 25, toFrameExclusive: 75 },
  }), /не полный ролик/u],
  ['half-size preview', (fixture) => publishPreview(fixture, { width: 160, height: 90 }), /размер/u],
  ['source changed after preview', (fixture) => {
    publishPreview(fixture);
    fs.writeFileSync(fixture.workspace.sourcePath, 'other-source');
  }, /исходник/u],
  ['preview bytes changed on disk', (fixture) => {
    const published = publishPreview(fixture);
    fs.writeFileSync(published.revisionPath, 'tampered');
  }, /байты preview/u],
];

for (const [name, arrange, reason] of refusals) {
  test(`promotion refuses: ${name} – final stays a render job`, (t) => {
    const fixture = makeProject(t);
    arrange(fixture);
    const approved = approve(fixture);
    const before = fs.readFileSync(path.join(fixture.workspace.dir, 'project.json'));
    const result = promote(fixture, approved);
    assert.equal(result.promoted, false);
    assert.match(result.reason, reason);
    assert.deepEqual(fs.readFileSync(path.join(fixture.workspace.dir, 'project.json')), before);
    assert.equal(fs.existsSync(path.join(fixture.workspace.dir, 'final', 'promote-test.mp4')), false);
    assert.deepEqual(fs.readdirSync(path.join(fixture.workspace.dir, 'renders')), []);
    const status = deriveVariantStatus({
      manifest: readProjectManifest(fixture.workspace.dir), currentBriefStatus: 'approved', currentBriefSha256: null, finalExists: false,
    });
    assert.equal(status.needsFinal, true);
  });
}

test('promotion refuses a preview of an older draft than the approved one', (t) => {
  const fixture = makeProject(t);
  publishPreview(fixture);
  // Новая ревизия черновика без нового preview: утверждается v02, а preview – от v01.
  const brief = JSON.parse(fs.readFileSync(fixture.published.jsonPath, 'utf8'));
  fixture.workspace.manifest = readProjectManifest(fixture.workspace.dir);
  fixture.published = publishBriefRevision(fixture.workspace, { brief: { ...brief, title: 'ДРУГОЙ' }, markdown: '# v2\n' });
  const approved = approve(fixture);
  const result = promote(fixture, approved);
  assert.equal(result.promoted, false);
  assert.match(result.reason, /другому черновику/u);
});

test('a failed final copy leaves no half-final: no final file, no render dir, manifest unchanged', (t) => {
  const fixture = makeProject(t);
  publishPreview(fixture);
  const approved = approve(fixture);
  const before = fs.readFileSync(path.join(fixture.workspace.dir, 'project.json'));
  let copies = 0;
  const fileSystem = new Proxy(fs, {
    get(target, property) {
      if (property === 'copyFileSync') {
        return (...args) => {
          copies += 1;
          if (copies === 2) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
          return target.copyFileSync(...args);
        };
      }
      return Reflect.get(target, property);
    },
  });
  assert.throws(() => promote(fixture, approved, { fileSystem }), /disk full/u);
  assert.deepEqual(fs.readFileSync(path.join(fixture.workspace.dir, 'project.json')), before);
  assert.equal(fs.existsSync(path.join(fixture.workspace.dir, 'final', 'promote-test.mp4')), false);
  assert.deepEqual(fs.readdirSync(path.join(fixture.workspace.dir, 'renders')), []);
  assert.deepEqual(fs.readdirSync(path.join(fixture.workspace.dir, 'final')).filter((name) => name.startsWith('.')), []);
});

test('a failed promotion keeps the previous final byte-for-byte', (t) => {
  const fixture = makeProject(t);
  publishPreview(fixture);
  const approved = approve(fixture);
  const finalPath = path.join(fixture.workspace.dir, 'final', 'promote-test.mp4');
  fs.writeFileSync(finalPath, 'previous-final');
  const fileSystem = new Proxy(fs, {
    get(target, property) {
      if (property === 'renameSync') {
        return (from, to) => {
          if (to === finalPath) throw Object.assign(new Error('rename refused'), { code: 'EPERM' });
          return target.renameSync(from, to);
        };
      }
      return Reflect.get(target, property);
    },
  });
  assert.throws(() => promote(fixture, approved, { fileSystem }), /rename refused/u);
  assert.equal(fs.readFileSync(finalPath, 'utf8'), 'previous-final');
  assert.deepEqual(fs.readdirSync(path.join(fixture.workspace.dir, 'renders')), []);
});

test('promotion requires the approved brief to be the current one', (t) => {
  const fixture = makeProject(t);
  publishPreview(fixture);
  const result = promoteApprovedPreview(fixture.workspace, fixture.published.jsonPath);
  assert.equal(result.promoted, false);
  assert.match(result.reason, /утверждённый brief/u);
});

test('regression: when restoring the previous final fails, its backup is kept, never deleted', (t) => {
  const fixture = makeProject(t);
  publishPreview(fixture);
  const approved = approve(fixture);
  const finalDir = path.join(fixture.workspace.dir, 'final');
  const finalPath = path.join(finalDir, 'promote-test.mp4');
  fs.writeFileSync(finalPath, 'previous-final');
  // Паспорт не записывается (сбой после замены финала), и возврат резервной копии тоже отказывает.
  const fileSystem = new Proxy(fs, {
    get(target, property) {
      if (property === 'renameSync') {
        return (from, to) => {
          if (to === finalPath && from.includes('.previous-')) throw Object.assign(new Error('restore refused'), { code: 'EIO' });
          return target.renameSync(from, to);
        };
      }
      if (property === 'writeFileSync' || property === 'writeSync') {
        return (...args) => {
          if (String(args[0]).includes('project.json') || (typeof args[0] === 'number' && new Error().stack.includes('commitManifest'))) {
            throw Object.assign(new Error('manifest write failed'), { code: 'ENOSPC' });
          }
          return target[property](...args);
        };
      }
      return Reflect.get(target, property);
    },
  });
  assert.throws(() => promote(fixture, approved, { fileSystem }), /manifest write failed/u);
  const backups = fs.readdirSync(finalDir).filter((name) => name.includes('.previous-'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(finalDir, backups[0]), 'utf8'), 'previous-final');
});

test('promotion refuses when the preview differs from the one the approval screen showed', (t) => {
  const fixture = makeProject(t);
  publishPreview(fixture);
  const approved = approve(fixture);
  const result = promote(fixture, approved, { expectedPreviewSha256: 'f'.repeat(64) });
  assert.equal(result.promoted, false);
  assert.match(result.reason, /изменился после утверждения/u);
  assert.equal(promote(fixture, approved, { expectedPreviewSha256: sha('clean-preview-bytes') }).promoted, true);
});
