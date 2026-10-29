const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { transformSync } = require('esbuild');

const ROOT = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
const PACK = 'skills/ai-promo/templates/motion-pack';

function loadTokens(source) {
  const { code } = transformSync(source, { loader: 'js', format: 'cjs' });
  const module = { exports: {} };
  new Function('module', 'exports', code)(module, module.exports);
  return module.exports;
}

test('motion-pack tokens: вертикаль по умолчанию, горизонталь 1920x1080 с SAFE_16x9', () => {
  const source = read(`${PACK}/src/tokens.js`);
  const vertical = loadTokens(source);
  assert.equal(vertical.ASPECT, 'vertical');
  assert.equal(vertical.WIDTH, 1080);
  assert.equal(vertical.HEIGHT, 1920);
  assert.deepEqual({ ...vertical.SAFE }, { top: 260, bottom: 1500, side: 80 }, 'вертикальные значения не меняются');
  const horizontal = loadTokens(source.replace(/ASPECT = 'vertical'/u, "ASPECT = 'horizontal'"));
  assert.equal(horizontal.WIDTH, 1920);
  assert.equal(horizontal.HEIGHT, 1080);
  assert.deepEqual({ ...horizontal.SAFE }, { top: 60, bottom: 1020, side: 80 });
});

test('motion-pack render.cjs проверяет выбранный --aspect', () => {
  const render = read(`${PACK}/render.cjs`);
  assert.ok(render.includes('--aspect'));
  assert.ok(render.includes('tokens.ASPECT'));
});

test('ai-promo: документы описывают 16:9', () => {
  const files = ['SKILL.md', 'references/engine-path.md', 'references/storyboard-and-prompts.md', 'references/model-selection.md',
    'references/vfx-kit.md', 'references/qa-checklist.md'];
  for (const file of files) {
    const text = read(`skills/ai-promo/${file}`);
    assert.match(text, /16:9/u, file);
    assert.ok(text.includes('1920×1080'), file);
  }
  assert.ok(read('skills/ai-promo/SKILL.md').includes('--aspect horizontal'));
  assert.ok(read(`${PACK}/README.md`).includes('--aspect'));
});

test('motion-reel и каталог сцен: горизонтальный формат и копии навыка совпадают', () => {
  for (const file of ['skills/motion-reel/SKILL.md', 'skills/motion-reel/references/brief-package.md', 'docs/SCENE-CATALOG.md']) {
    const text = read(file);
    assert.ok(text.includes('1920×1080'), file);
    assert.match(text, /horizontal/u, file);
  }
  for (const copy of ['.agents', '.codex']) {
    for (const file of ['SKILL.md', 'references/brief-package.md']) {
      assert.equal(read(`${copy}/skills/motion-reel/${file}`), read(`skills/motion-reel/${file}`), `${copy}/${file}`);
    }
  }
});

test('критик знает формат из индекса и телефонный лист 640 px для 16:9', () => {
  const doc = read('skills/reel-turnkey/references/motion-critic.md');
  assert.ok(doc.includes('format'));
  assert.ok(doc.includes('640 px'));
  assert.ok(doc.includes('360 px'));
  assert.ok(read('.claude/agents/motion-critic.md').includes('format'));
});

test('README и CHANGELOG: --aspect с --brief/--script отклоняется, выпуск описан', () => {
  const readme = read('README.md');
  assert.doesNotMatch(readme, /`--aspect` работает с `--project-dir`/u);
  assert.match(readme, /--aspect[\s\S]{0,400}--brief[\s\S]{0,40}--script[\s\S]{0,60}отклоняется/u);
  const log = read('CHANGELOG.md');
  const start = log.indexOf('## [1.23.0]');
  assert.ok(start >= 0, 'CHANGELOG: нет секции 1.23.0');
  const release = log.slice(start, log.indexOf('\n## [', start + 5));
  assert.match(release, /### Добавлено[\s\S]*16:9/u);
});

test('ARCHITECTURE: оговорка про карточку 16:9 и нет осиротевшей строки', () => {
  const arch = read('ARCHITECTURE.md');
  assert.doesNotMatch(arch, /^Текст подгоняется\n/mu);
  assert.match(arch, /кроме\s+карточки 16:9[\s\S]{0,80}contain/u);
  assert.ok(arch.includes('телефонный лист'));
});

test('новые документы без длинного тире (U+2014) и личных путей', () => {
  for (const file of ['skills/ai-promo/SKILL.md', 'skills/motion-reel/SKILL.md', 'skills/reel-turnkey/references/motion-critic.md',
    'CHANGELOG.md', `${PACK}/README.md`, `${PACK}/src/tokens.js`, `${PACK}/render.cjs`]) {
    assert.ok(!read(file).includes('\u2014'), file);
  }
  for (const file of ['skills/ai-promo/SKILL.md', 'skills/motion-reel/SKILL.md', 'skills/reel-turnkey/references/motion-critic.md',
    'README.md', 'ARCHITECTURE.md', 'CHANGELOG.md', `${PACK}/README.md`]) {
    assert.doesNotMatch(read(file), /\/Users\/|\/home\//u, file);
  }
});

// ---- render.cjs: сверка формата пакета (ASPECT) с --aspect и ТЗ ----
const os = require('node:os');
const { checkPackAspect } = require(path.join(ROOT, PACK, 'render.cjs'));

function writeBrief(aspect) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-aspect-'));
  const file = path.join(dir, 'brief.json');
  fs.writeFileSync(file, JSON.stringify({ output: aspect ? { aspect } : {} }));
  return file;
}

test('render.cjs: ТЗ horizontal при ASPECT vertical – ошибка', () => {
  assert.throws(() => checkPackAspect({ ASPECT: 'vertical' }, ['--brief', writeBrief('horizontal')]), /output\.aspect.*horizontal.*ASPECT/u);
});

test('render.cjs: ТЗ и ASPECT совпадают – без ошибки; ТЗ без aspect = vertical', () => {
  assert.doesNotThrow(() => checkPackAspect({ ASPECT: 'horizontal' }, ['--brief', writeBrief('horizontal')]));
  assert.doesNotThrow(() => checkPackAspect({ ASPECT: 'vertical' }, ['--brief', writeBrief(null)]));
  assert.doesNotThrow(() => checkPackAspect({ ASPECT: 'vertical' }, []));
});

test('render.cjs: --aspect расходится с ASPECT – ошибка; совпадает – ok', () => {
  assert.throws(() => checkPackAspect({ ASPECT: 'vertical' }, ['--aspect', 'horizontal']), /ASPECT/u);
  assert.doesNotThrow(() => checkPackAspect({ ASPECT: 'horizontal' }, ['--aspect', 'horizontal']));
});

test('render.cjs: опечатка в ASPECT отклоняется', () => {
  assert.throws(() => checkPackAspect({ ASPECT: 'Horizontal' }, []), /ASPECT/u);
  assert.throws(() => checkPackAspect({}, []), /ASPECT/u);
});

test('render.cjs: --brief без читаемого файла – понятная ошибка', () => {
  assert.throws(() => checkPackAspect({ ASPECT: 'vertical' }, ['--brief']), /--brief/u);
  assert.throws(() => checkPackAspect({ ASPECT: 'vertical' }, ['--brief', '/nonexistent/x.json']), /--brief/u);
});

test('ai-promo: шаги 9-10 и engine-path требуют ASPECT = output.aspect и --brief', () => {
  for (const file of ['skills/ai-promo/SKILL.md', 'skills/ai-promo/references/engine-path.md']) {
    const text = read(file);
    assert.match(text, /`ASPECT`[^\n]*`output\.aspect`/u, file);
    assert.ok(text.includes('--brief'), file);
  }
});
