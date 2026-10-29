const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
const DOC_PATH = 'skills/reel-turnkey/references/motion-craft.md';
const doc = read(DOC_PATH);

test('motion-craft: разделы на месте', () => {
  for (const h of ['## Числа движения', '## Один пик на ролик', '## Запреты', '## Графика поверх спикера', '## Версия Remotion']) {
    assert.ok(doc.includes(h), h);
  }
});

test('motion-craft: числа совпадают с кодом motion-kit', () => {
  const motion = read('src/motion-kit/motion.js');
  const captions = read('src/motion-kit/captions.js');
  // Код: вход маски 8 кадров на EASE.out, выход 5 кадров с Easing.in, прозрачность pop 3 кадра.
  assert.match(motion, /enter\.kind === 'mask'\) \{\s*const p = prog\(f, 0, r\(8\)\)/u);
  assert.match(motion, /EASE\s*=\s*Object\.freeze\(\{\s*out:\s*Easing\.bezier\(0\.16, 1, 0\.3, 1\)/u);
  assert.match(motion, /frames: 5, dir: 'down'/u);
  assert.match(motion, /Easing\.in\(/u);
  assert.match(motion, /out\.o = interpolate\(f, \[0, r\(3\)\], \[0, 1\], CLAMP\)/u);
  assert.match(motion, /pop: \{ damping: 12, stiffness: 200, mass: 0\.7 \}/u);
  assert.match(motion, /fly: \{ damping: 16, stiffness: 160, mass: 0\.8 \}/u);
  assert.match(captions, /maxWords = 4, maxChars = 20/u);
  assert.match(captions, /minDur = 0\.45/u);
  // Документ повторяет те же числа.
  assert.match(doc, /8 кадров \(0,32 с\)/u);
  // 8 кадров – только у входа маской; fly и pop – пружины, длительность задаёт пружина.
  assert.match(doc, /вход маской \(`mask`\) – 8 кадров \(0,32 с\)/u);
  assert.match(doc, /входы `fly` и `pop` – пружины/u);
  assert.match(doc, /5 кадров \(0,2 с\)/u);
  assert.match(doc, /Появление прозрачности у `pop` \| 3 кадра/u);
  assert.match(doc, /2–3 кадра \(0,08–0,12 с\)/u);
  assert.match(doc, /4–6 кадров \(0,16–0,24 с\)/u);
  assert.match(doc, /не меньше 1,2 с/u);
  assert.match(doc, /не меньше 0,3 с на каждое слово сверх четырёх/u);
  assert.match(doc, /1,5–2,2 с/u);
  assert.match(doc, /0,68 с/u);
  assert.match(doc, /не чаще 1 раза в секунду/u);
  assert.match(doc, /не более 4 слов и 20 знаков/u);
  assert.match(doc, /0,45 с/u);
  assert.match(doc, /ref25\(n, fps\)/u);
});

test('motion-craft: версия Remotion = установленная', () => {
  const lock = JSON.parse(read('package-lock.json'));
  assert.ok(doc.includes(lock.packages['node_modules/remotion'].version));
});

test('motion-craft: на него ссылаются все motion-скиллы и AGENTS.md, ссылки живые', () => {
  const files = [
    'skills/reel-turnkey/references/creative-motion.md',
    'skills/ai-promo/SKILL.md',
    'skills/motion-reel/SKILL.md',
    'skills/reel-from-donor/SKILL.md',
    'skills/reel-turnkey/SKILL.md',
    'skills/lead-magnet/SKILL.md',
    'AGENTS.md',
  ];
  for (const file of files) {
    const links = [...read(file).matchAll(/\]\(([^)\s]*motion-craft\.md)\)/gu)].map(m => m[1]);
    assert.ok(links.length > 0, `${file}: нет ссылки на motion-craft.md`);
    for (const link of links) {
      assert.ok(fs.existsSync(path.resolve(ROOT, path.dirname(file), link)), `${file}: ${link}`);
    }
  }
});

test('motion-craft: копии motion-reel совпадают с каноном', () => {
  const canon = read('skills/motion-reel/SKILL.md');
  assert.equal(read('.agents/skills/motion-reel/SKILL.md'), canon);
  assert.equal(read('.codex/skills/motion-reel/SKILL.md'), canon);
});

test('motion-craft: без длинного тире и личных путей', () => {
  assert.ok(!doc.includes(String.fromCodePoint(0x2014)));
  assert.doesNotMatch(doc, /\/Users\/|\/home\/|projects\/20\d\d/u);
});
