// Строка «Утверждено» во входящих пульта значит: approveBrief уже выполнен – собирай final.
// Навык, который велит снова звать approve-brief.js, ведёт агента в отказ (текущий brief уже не draft).
// С #110 (D-051) утверждение чистого полного preview обычно уже дало финал копированием: навык должен
// сказать, что тогда рендер не нужен (строка `final: …` у approve-brief.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

for (const skill of ['reel-turnkey', 'motion-reel', 'ai-promo']) {
  test(`${skill}: pult approval goes straight to final without a second approve`, () => {
    const text = fs.readFileSync(path.join(ROOT, 'skills', skill, 'SKILL.md'), 'utf8');
    assert.match(text, /«Утверждаю» в пульте[^]{0,120}«Утверждено»/u);
    assert.match(text, /approveBrief` уже выполнен/u);
  });
}

for (const skill of ['reel-turnkey', 'motion-reel', 'ai-promo']) {
  test(`${skill}: an approval that already promoted the clean preview needs no final render (#110)`, () => {
    const text = fs.readFileSync(path.join(ROOT, 'skills', skill, 'SKILL.md'), 'utf8');
    assert.match(text, /`final: …`/u);
    assert.match(text, /D-051/u);
  });
}
