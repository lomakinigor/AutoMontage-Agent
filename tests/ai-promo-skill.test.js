const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { transformSync } = require('esbuild');

const ROOT = path.resolve(__dirname, '..');
const SKILL_DIR = path.join(ROOT, 'skills', 'ai-promo');
const PACK_DIR = path.join(SKILL_DIR, 'templates', 'motion-pack');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

test('adapters point to the canonical ai-promo skill', () => {
  for (const prefix of ['.agents', '.claude', '.codex']) {
    const text = read(`${prefix}/skills/ai-promo/SKILL.md`);
    assert.match(text, /^---\nname: ai-promo\n/u, prefix);
    assert.ok(text.includes('../../../skills/ai-promo/SKILL.md'), prefix);
  }
  const index = read('skills/README.md');
  assert.match(index, /^## ai-promo$/mu);
  assert.ok(index.includes('ai-promo/SKILL.md'));
});

test('the skill routes through --music-only, a paid-credit consent and the approval gate', () => {
  const skill = read('skills/ai-promo/SKILL.md');
  assert.match(skill, /^---\nname: ai-promo\n/u);
  for (const required of ['--music-only', 'get_cost', 'automontage preview', '--confirm-preview-viewed',
    'audioMode: mute', 'creative-motion.md', 'Как монтируем?', 'skills/lead-magnet/SKILL.md', 'projects/<id>/']) {
    assert.ok(skill.includes(required), required);
  }
  assert.match(skill, /явного\s+подтверждения\s+пользователем\s+этой\s+суммы\s+кредитов/u);
  assert.match(skill, /«утверждаю»/u);
  // The order of the engine path is part of the contract.
  const steps = ['--music-only', 'get_cost', 'render.cjs', 'publishBriefRevision', 'automontage preview',
    '--confirm-preview-viewed'];
  let previous = -1;
  for (const step of steps) {
    const at = skill.indexOf(step, previous + 1);
    assert.ok(at > previous, `${step} должен идти после предыдущего шага`);
    previous = at;
  }
});

test('the skill never asks for a provider API key', () => {
  for (const file of walk(SKILL_DIR).filter((file) => file.endsWith('.md'))) {
    const text = fs.readFileSync(file, 'utf8');
    const rel = path.relative(ROOT, file);
    assert.doesNotMatch(text, /\b[A-Z][A-Z0-9]*_API_KEY\b/u, rel);
  }
  assert.match(read('skills/ai-promo/SKILL.md'), /`\*_API_KEY`[^\n]*не\s+нужен/u);
});

test('every reference linked from SKILL.md exists', () => {
  const skill = read('skills/ai-promo/SKILL.md');
  const links = [...skill.matchAll(/\]\(([^)#\s]+)\)/gu)].map((match) => match[1]).filter((link) => !/^[a-z]+:/u.test(link));
  assert.ok(links.length >= 12, 'SKILL.md ссылается на справочники');
  for (const link of links) {
    assert.ok(fs.existsSync(path.resolve(SKILL_DIR, link)), `нет файла по ссылке ${link}`);
  }
  for (const name of ['higgsfield-mcp', 'cost-and-consent', 'storyboard-and-prompts', 'identity-from-own-footage',
    'model-selection', 'vfx-kit', 'audio-recipe', 'engine-path', 'qa-checklist', 'provenance']) {
    assert.ok(links.includes(`references/${name}.md`), name);
  }
});

test('evals describe trigger prompts with expectations', () => {
  const evals = JSON.parse(read('skills/ai-promo/evals/evals.json'));
  assert.equal(evals.skill_name, 'ai-promo');
  assert.ok(evals.evals.length >= 3 && evals.evals.length <= 4);
  for (const item of evals.evals) {
    assert.ok(typeof item.query === 'string' && item.query.length > 20, item.id);
    assert.ok(Array.isArray(item.expectations) && item.expectations.length >= 3, item.id);
  }
});

test('ai-promo files carry no personal paths, CDN links, account ids, tokens or em dashes', () => {
  const files = [...walk(SKILL_DIR), ...['.agents', '.claude', '.codex'].map((prefix) => path.join(ROOT, prefix, 'skills', 'ai-promo', 'SKILL.md'))];
  const forbidden = [
    /\/Users\//u, /\/home\//u, /\/tmp\/claude/u, /cloudfront/iu, /\buser_[A-Za-z0-9]{10,}/u,
    /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/u, /\bgh[pousr]_[A-Za-z0-9]{20,}/u, /\bAKIA[0-9A-Z]{16}\b/u,
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/u, /\bBearer\s+[A-Za-z0-9._-]{20,}/u,
    new RegExp(String.fromCodePoint(0x2014), 'u'),
  ];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const pattern of forbidden) assert.doesNotMatch(text, pattern, `${path.relative(ROOT, file)}: ${pattern}`);
  }
});

test('the motion pack template parses and renders silent by default', () => {
  const sources = walk(PACK_DIR).filter((file) => /\.(?:jsx|js|cjs)$/u.test(file));
  assert.ok(sources.length >= 6);
  for (const file of sources) {
    assert.doesNotThrow(() => transformSync(fs.readFileSync(file, 'utf8'), { loader: 'jsx' }), path.relative(ROOT, file));
  }
  const index = read('skills/ai-promo/templates/motion-pack/src/index.jsx');
  assert.match(index, /<Composition\s[^>]*id="Promo"/u);
  assert.match(index, /defaultProps=\{\{\s*withAudio:\s*false\s*\}\}/u);
  assert.match(index, /=\s*\(\{\s*withAudio\s*=\s*false\s*\}\)/u);
  assert.match(index, /export const PLAN\s*=/u);
  const tokens = read('skills/ai-promo/templates/motion-pack/src/tokens.js');
  for (const token of ["ASPECT = 'vertical'", 'FPS = 30']) assert.ok(tokens.includes(token), token);
  // Размеры 1080×1920 и SAFE вертикали проверяет tests/motion-horizontal-docs.test.js на вычисленных токенах.
});

test('chrome text stays within 112 px by default and the font import survives the copy', () => {
  const fx = read('skills/ai-promo/templates/motion-pack/src/fx.jsx');
  const size = Number(fx.match(/export const Chrome = \(\{[^}]*\bsize\s*=\s*(\d+)/u)?.[1]);
  assert.ok(size > 0 && size <= 112, `Chrome size по умолчанию ${size}`);
  assert.match(read('skills/ai-promo/templates/motion-pack/src/tokens.js'), /CHROME_MAX = 112\b/u);
  for (const call of read('skills/ai-promo/templates/motion-pack/src/scenes.jsx').matchAll(/<Chrome size=\{(\d+)\}/gu)) {
    assert.ok(Number(call[1]) <= 112, `Chrome size ${call[1]}`);
  }
  // After copying into projects/<id>/motion-vNN/src the engine root is four levels up.
  assert.match(fx, /from '\.\.\/\.\.\/\.\.\/\.\.\/src\/fonts'/u);
  const copiedSrc = path.join(ROOT, 'projects', 'example', 'motion-v01', 'src');
  assert.ok(fs.existsSync(path.resolve(copiedSrc, '../../../../src/fonts.js')));
  assert.match(read('skills/ai-promo/templates/motion-pack/README.md'), /\.\.\/\.\.\/\.\.\/\.\.\/src\/fonts/u);
});

test('placeholder copy is neutral: no product names or invented claims', () => {
  for (const file of walk(path.join(PACK_DIR, 'src'))) {
    const text = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /AUTOMONTAGE|AutoMontage|Claude|Codex|open source/u, path.relative(ROOT, file));
  }
  assert.match(read('skills/ai-promo/templates/motion-pack/src/scenes.jsx'), /ВАШ ПРОДУКТ/u);
});

test('the render helpers use the protected Remotion command and the shared heavy queue', () => {
  const envExports = require('../scripts/env');
  const queueExports = require('../scripts/heavy-queue');
  assert.equal(typeof envExports.resolveRemotionCommand, 'function');
  assert.equal(typeof queueExports.acquireHeavySlot, 'function');
  for (const helper of ['render.cjs', 'stills.cjs']) {
    const text = read(`skills/ai-promo/templates/motion-pack/${helper}`);
    assert.match(text, /resolveRemotionCommand/u, helper);
    assert.match(text, /acquireHeavySlot/u, helper);
    assert.match(text, /slot\.release\(\)/u, helper);
    assert.match(text, /withAudio: false/u, helper);
  }
  assert.match(read('skills/ai-promo/templates/motion-pack/render.cjs'), /'--muted'/u);
});

test('engine path attaches the pack full-frame and the audio recipe trims at 48 kHz', () => {
  const engine = read('skills/ai-promo/references/engine-path.md');
  assert.match(engine, /"frame": "full"/u);
  assert.ok(engine.includes('--no-open'));
  assert.ok(engine.includes('--music-only refuses a project whose transcript already has speech; use the narration path'));
  assert.ok(engine.includes('--accept-provider-cost'));
  const audio = read('skills/ai-promo/references/audio-recipe.md');
  // loudnorm upsamples to 192 kHz internally: atrim must count samples after resampling to 48 kHz.
  assert.match(audio, /linear=true,aresample=48000,atrim=end_sample=<frames\*1600>/u);
  assert.doesNotMatch(audio, /linear=true,atrim=/u);
  const qa = read('skills/ai-promo/references/qa-checklist.md');
  assert.ok(qa.includes('48000'));
  assert.ok(qa.includes('blackdetect=d=0.1:pix_th=0.10'));
  assert.ok(read('TESTING.md').includes('blackdetect=d=0.1:pix_th=0.10'));
});

test('one budget rule: per batch or the whole plan itemized, anything beyond asks again', () => {
  for (const file of ['AGENTS.md', 'skills/ai-promo/SKILL.md', 'skills/ai-promo/references/cost-and-consent.md',
    'skills/README.md', 'docs/reels-guide/10-ai-promo.md', 'docs/reels-guide/PROMPTS.md']) {
    const text = read(file).replace(/\s+/gu, ' ');
    assert.match(text, /весь план/u, file);
    assert.match(text, /партиям/u, file);
  }
  const agents = read('AGENTS.md').replace(/\s+/gu, ' ');
  assert.match(agents, /Всё сверх утверждённой сметы[^.]*требует нового вопроса/u);
});

test('pult approval goes straight to final; approve-brief only for a chat approval', () => {
  for (const file of ['skills/ai-promo/SKILL.md', 'skills/ai-promo/references/engine-path.md', 'skills/motion-reel/SKILL.md']) {
    const text = read(file).replace(/\s+/gu, ' ');
    assert.match(text, /«Утверждаю» в пульте/u, file);
    assert.match(text, /«утверждаю»[^.]{0,20}в чате/u, file);
  }
});
