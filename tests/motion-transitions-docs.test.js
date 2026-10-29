const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const LONG_DASH = String.fromCodePoint(0x2014);

const craft = read('skills/reel-turnkey/references/motion-craft.md');
const kit = read('docs/MOTION-KIT.md');
const packageDoc = read('skills/motion-reel/references/brief-package.md');

function section(text, heading) {
  const start = text.indexOf(`\n${heading}\n`);
  assert.ok(start >= 0, `нет раздела ${heading}`);
  const rest = text.slice(start + heading.length + 2);
  const end = rest.search(/\n## /u);
  return end < 0 ? rest : rest.slice(0, end);
}

test('motion-craft: раздел «Переходы» с типами, числами и правилами', () => {
  const body = section(craft, '## Переходы');
  for (const type of ['cut', 'fade', 'slide', 'wipe', 'push']) assert.match(body, new RegExp(`\`${type}\``, 'u'), type);
  assert.match(body, /10 кадров \(0,4 с\)/u);
  assert.match(body, /6–15/u);
  assert.match(body, /12 кадров/u);
  assert.match(body, /9 кадров/u);
  assert.match(body, /ref25\(n, fps\)/u);
  assert.match(body, /смене мысли/u);
  assert.match(body, /один тип «большого» перехода/u);
  assert.match(body, /HTML-in-canvas/u);
  assert.match(body, /стоп-кадр/u);
  assert.match(body, /`origin`/u);
  assert.match(body, /`pushes`/u);
});

test('MOTION-KIT: origin, pushes и гейт G16', () => {
  assert.match(kit, /origin: '<id элемента>'/u);
  assert.match(kit, /pushes: \[\{ at, target, frames, k \}\]/u);
  assert.match(kit, /\bG16\b/u);
  assert.match(kit, /Опора вставки и наезда/u);
  assert.match(kit, /12 кадров/u);
  assert.match(kit, /9 кадров/u);
});

test('brief-package: поле transition описано', () => {
  assert.match(packageDoc, /transition: \{type, frames, direction\}/u);
  assert.match(packageDoc, /`left` – новая сцена въезжает справа/u);
});

test('motion-reel и creative-motion: переходы и морф упомянуты, копии равны канону', () => {
  const skill = read('skills/motion-reel/SKILL.md');
  assert.match(skill, /transition/u);
  assert.match(skill, /motion-craft\.md#переходы/u);
  const creative = read('skills/reel-turnkey/references/creative-motion.md');
  assert.match(creative, /вставка, растущая из элемента/u);
  assert.match(creative, /наезд камеры на элемент/u);
  // creative-motion в .agents/.codex – короткие указатели на канон, поэтому байт-в-байт сверяем только motion-reel.
  for (const file of ['skills/motion-reel/SKILL.md', 'skills/motion-reel/references/brief-package.md']) {
    const canon = read(file);
    for (const prefix of ['.agents', '.codex']) assert.equal(read(file.replace(/^skills/u, `${prefix}/skills`)), canon, `${prefix}: ${file}`);
  }
});

test('критик оценивает переходы в оси motion', () => {
  const critic = read('skills/reel-turnkey/references/motion-critic.md');
  assert.match(critic, /переходы между сценами/u);
});

test('README, ARCHITECTURE и CHANGELOG знают про переходы и морф', () => {
  assert.match(read('README.md'), /`transition`/u);
  assert.match(read('ARCHITECTURE.md'), /`origin`/u);
  assert.match(read('ARCHITECTURE.md'), /G16/u);
  assert.match(read('CHANGELOG.md'), /G16/u);
});

test('документы без длинного тире и личных путей', () => {
  for (const file of [
    'skills/reel-turnkey/references/motion-craft.md', 'docs/MOTION-KIT.md', 'skills/motion-reel/references/brief-package.md',
    'skills/motion-reel/SKILL.md', 'skills/reel-turnkey/references/creative-motion.md', 'skills/reel-turnkey/references/motion-critic.md',
  ]) {
    const text = read(file);
    assert.ok(!text.includes(LONG_DASH), `${file}: длинное тире`);
    assert.doesNotMatch(text, /\/Users\/|\/home\//u, file);
  }
});
