// Регрессия: preview уже сохранён и зарегистрирован, а системный браузер не открылся.
// Это не отмена preview: предупреждение с путём и подсказкой --no-open, код выхода 0.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { fixture, fakeMedia } = require('./helpers/motion-workflow-fixture.cjs');
const { runPreview, previewOpenWarning } = require('../scripts/preview');
const { readProjectManifest } = require('../scripts/project/workspace');

test('regression: a browser that cannot open does not cancel a saved and registered preview', (t) => {
  const f = fixture(t);
  let opened = null;
  const result = runPreview({ projectDir: f.workspace.dir, briefPath: f.published.relativePath, open: true }, {
    ...fakeMedia(),
    openMediaFileImpl(file) { opened = file; throw new Error('preview is ready but the system browser could not be opened'); },
  });
  assert.equal(opened, result.currentPath);
  assert.ok(fs.existsSync(result.currentPath));
  assert.ok(readProjectManifest(f.workspace.dir).currentPreview, 'preview stays registered');
  assert.match(result.openError, /system browser could not be opened/);
});

test('open warning names the saved path and --no-open and never says cancelled', () => {
  const warning = previewOpenWarning('/p/previews/current-preview.mp4');
  assert.match(warning, /^⚠️ /);
  assert.ok(warning.includes('/p/previews/current-preview.mp4'));
  assert.match(warning, /--no-open/);
  assert.doesNotMatch(warning, /отмен|cancel|❌/i);
});

test('a successful open leaves no openError', (t) => {
  const f = fixture(t);
  const result = runPreview({ projectDir: f.workspace.dir, briefPath: f.published.relativePath, open: true }, {
    ...fakeMedia(), openMediaFileImpl() {},
  });
  assert.equal(result.openError, undefined);
});
