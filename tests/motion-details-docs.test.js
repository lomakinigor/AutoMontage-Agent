const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

const craft = read('skills/reel-turnkey/references/motion-craft.md');
const details = craft.slice(craft.indexOf('## Детали'));

test('motion-craft: раздел «Детали» с числами одометра, графика и текстуры', () => {
  assert.ok(craft.includes('## Детали'));
  assert.match(details, /1,2–1,8 с/u);
  assert.match(details, /0,06/u);
  assert.match(details, /6 столбиков/u);
  assert.match(details, /один блик на карточку/u);
  assert.match(details, /`subtle`/u);
});

test('одометр: порог сжатия в документах равен коду (2 с), без устаревших 2,6 с', () => {
  assert.match(read('src/motion/CounterScene.jsx'), /Math\.min\(2,/u);
  assert.match(details, /2 с и короче/u);
  assert.doesNotMatch(details, /2,6 с/u);
  assert.doesNotMatch(read('CHANGELOG.md').split('\n').slice(0, 30).join('\n'), /2,6 с/u);
});

test('brief-package: сцена chart, layout и style.texture', () => {
  const doc = read('skills/motion-reel/references/brief-package.md');
  assert.match(doc, /\| `chart` \|/u);
  assert.match(doc, /`layout`/u);
  assert.match(doc, /`style\.texture`/u);
  assert.match(doc, /`bar-to-line`/u);
});

test('motion-reel SKILL.md: восемь сцен, копии равны канону', () => {
  const canon = read('skills/motion-reel/SKILL.md');
  assert.match(canon, /восемь сцен/u);
  assert.match(canon, /`chart`/u);
  assert.equal(read('.agents/skills/motion-reel/SKILL.md'), canon);
  assert.equal(read('.codex/skills/motion-reel/SKILL.md'), canon);
  const brief = read('skills/motion-reel/references/brief-package.md');
  assert.equal(read('.agents/skills/motion-reel/references/brief-package.md'), brief);
  assert.equal(read('.codex/skills/motion-reel/references/brief-package.md'), brief);
});

test('MOTION-KIT.md: пять компонентов деталей и item.props.view', () => {
  const doc = read('docs/MOTION-KIT.md');
  for (const name of ['Odometer', 'Chart', 'Grain', 'Drift', 'Sheen']) {
    assert.match(doc, new RegExp(`\`${name}\\b`, 'u'), name);
  }
  assert.ok(doc.includes('item.props.view'));
});

test('SCENE-CATALOG, критик, журнал и архитектура описывают новое поведение', () => {
  const catalog = read('docs/SCENE-CATALOG.md');
  assert.match(catalog, /восемь сцен/u);
  assert.match(catalog, /`layout`/u);
  assert.match(catalog, /texture/u);
  assert.match(read('skills/reel-turnkey/references/motion-critic.md'), /одометр/u);
  const log = read('CHANGELOG.md');
  const start = log.indexOf('## [1.22.0]');
  assert.ok(start >= 0, 'CHANGELOG: нет секции 1.22.0');
  const release = log.slice(start, log.indexOf('\n## [', start + 5));
  assert.match(release, /[Оо]дометр/u);
  assert.match(release, /chart/u);
  assert.match(release, /texture/u);
  assert.match(read('ARCHITECTURE.md'), /src\/details\//u);
  assert.match(read('README.md'), /style\.texture/u);
});

test('документы без U+2014 и личных путей', () => {
  // README.md и ARCHITECTURE.md уже содержат длинные тире в старых абзацах; здесь проверяем остальные.
  for (const file of ['skills/reel-turnkey/references/motion-craft.md', 'skills/motion-reel/references/brief-package.md',
    'skills/motion-reel/SKILL.md', 'docs/SCENE-CATALOG.md', 'docs/MOTION-KIT.md', 'CHANGELOG.md',
    'skills/reel-turnkey/references/motion-critic.md']) {
    const text = read(file);
    assert.ok(!text.includes(String.fromCharCode(0x2014)), `${file}: U+2014`);
    assert.ok(!/\/Users\/|\/home\//u.test(text), `${file}: личный путь`);
  }
});

test('зерно: только на тёмном фоне и неподвижное; на светлом subtle – дрейф и блик; причина – размер файла', () => {
  assert.match(details, /тёмн/u);
  assert.match(details, /неподвижн/u);
  assert.match(details, /светл[\s\S]{0,80}дрейф[\s\S]{0,40}блик/u);
  assert.match(details, /МБ|тяжел|размер файла/u);
  assert.doesNotMatch(details, /раз в 2 кадра/u);
  assert.match(read('skills/motion-reel/references/brief-package.md'), /тёмн/u);
  assert.match(read('docs/SCENE-CATALOG.md'), /тёмн/u);
  assert.match(read('docs/MOTION-KIT.md'), /`video-bitrate`/u);
  const log = read('CHANGELOG.md');
  const start = log.indexOf('## [1.23.0]');
  assert.ok(start >= 0, 'CHANGELOG: нет секции 1.23.0');
  const release = log.slice(start, log.indexOf('\n## [', start + 5));
  assert.match(release, /### Исправлено/u);
  assert.match(release, /зерн/u);
  assert.match(release, /video-bitrate/u);
});
