const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
const EM_DASH = String.fromCodePoint(0x2014);
const CONTRACT = 'skills/reel-turnkey/references/creative-motion.md';
// Фраза из документа с любыми переносами строк и отступами между словами.
const words = phrase => new RegExp(phrase.split(' ').map(w => w.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('\\s+'), 'u');
// Раздел документа от заголовка до следующего заголовка того же или более высокого уровня.
function section(text, heading) {
  const start = text.indexOf(heading);
  assert.ok(start >= 0, `нет раздела ${heading}`);
  const level = heading.match(/^#+/u)[0].length;
  const rest = text.slice(start + heading.length);
  const next = rest.search(new RegExp(`\\n#{1,${level}} `, 'u'));
  return next < 0 ? rest : rest.slice(0, next);
}

const QUESTIONS = {
  'Что делаем?': ['Ролик со смыслом', 'Рекламный промо под музыку', 'Урок или длинное видео', 'Лид-магнит'],
  'Формат?': ['Вертикаль 9:16', 'Горизонталь 16:9'],
  'Из чего собираем?': ['Моя запись с камеры', 'Камера и экран', 'Без съёмки', 'По ссылке-референсу'],
  'Как монтируем?': ['Уникальный Creative Motion', 'Creative Motion + оверлеи Higgsfield', 'Готовый стиль', 'Решай сам'],
};

test('карточка «Что делаем?» – до четырёх вопросов по 2–4 варианта', () => {
  const card = section(read(CONTRACT), '## Стартовая карточка «Что делаем?»');
  assert.match(card, /Заголовок карточки: \*\*«Что делаем\?»\*\*/u);
  for (const [title, options] of Object.entries(QUESTIONS)) {
    const block = section(card, `### Вопрос «${title}»`);
    assert.ok(options.length >= 2 && options.length <= 4, title);
    for (const option of options) assert.ok(block.includes(`**${option}`), `${title}: ${option}`);
  }
  assert.match(card, /AskUserQuestion/u);
  assert.match(card, /Уникальный Creative Motion – рекомендуется/u);
  assert.match(card, /«Решай сам»[^\n]*\n?[^\n]*Creative Motion/u);
});

test('спрашивай только неясное, без вопроса о длительности', () => {
  const card = section(read(CONTRACT), '## Стартовая карточка «Что делаем?»');
  assert.match(card, words('Не спрашивай то, что уже ясно'));
  assert.match(card, /16:9[^\n]*\n?[^\n]*отвечает на вопрос «Формат\?»/u);
  assert.match(card, /ссылк[^\n]*\n?[^\n]*отвечает на вопрос «Из чего собираем\?»/u);
  assert.match(card, words('Если ясно всё, карточку не показывай'));
  assert.match(card, words('Вопроса о длительности нет'));
  assert.match(card, /20–30 с/u);
  // Карточка остаётся одной точкой решения.
  assert.match(card, words('одна точка решения'));
});

test('вариант Higgsfield требует сметы кредитов и «да» до генерации', () => {
  const block = section(read(CONTRACT), '### Вопрос «Как монтируем?»');
  const line = block.split('\n\n').find(p => p.includes('Creative Motion + оверлеи Higgsfield'));
  assert.ok(line);
  assert.match(line, /кредит/u);
  assert.match(line, /смет/u);
  assert.match(line, /«да»/u);
  assert.match(line, /cost-and-consent\.md/u);
});

test('таблица маршрутов покрывает каждый ответ на вопросы 1 и 3', () => {
  const table = section(read(CONTRACT), '## Таблица маршрутов');
  const rows = table.split('\n').filter(line => line.startsWith('| ') && !/^\|\s*-/u.test(line));
  const routeOf = option => rows.find(row => row.includes(option));
  for (const option of [...QUESTIONS['Что делаем?'], ...QUESTIONS['Из чего собираем?']]) {
    const row = routeOf(option);
    assert.ok(row, `нет строки для «${option}»`);
    assert.match(row, /skills\/[a-z-]+\/SKILL\.md|reel-turnkey|motion-reel|ai-promo|reel-from-donor|lead-magnet/u, option);
  }
  assert.match(routeOf('Лид-магнит'), /lead-magnet/u);
  assert.match(routeOf('Рекламный промо под музыку'), /ai-promo/u);
  assert.match(routeOf('Без съёмки'), /motion-reel/u);
  assert.match(routeOf('По ссылке-референсу'), /reel-from-donor/u);
  assert.match(routeOf('Урок или длинное видео'), /lesson/u);
  // Честные ограничения форматов и склейки двух файлов.
  assert.match(table, words('автоматической синхронизации двух файлов пока нет'));
  assert.match(table, /reel-from-donor[^\n]*только[^\n]{0,8}вертикал/u);
  assert.match(table, /--aspect horizontal/u);
});

test('Codex: follow-up actions для «Как монтируем?» и общий «Решай сам»', () => {
  const contract = read(CONTRACT);
  for (const label of ['Уникальный Creative Motion', 'Creative Motion + Higgsfield', 'Готовый стиль', 'По референсу', 'Решай сам']) {
    assert.ok(contract.includes(`:codex-followup[${label}]{prompt="`), label);
  }
});

test('AGENTS.md и навыки ссылаются на карточку «Что делаем?» и один выбор маршрута', () => {
  const agents = read('AGENTS.md');
  const block = section(agents, '## Обязательная карточка «Что делаем?» в новом чате');
  assert.match(block, /«Что делаем\?»/u);
  assert.match(block, /«Как монтируем\?»/u);
  assert.match(block, words('один выбор маршрута в начале'));
  assert.match(block, words('Не спрашивай то, что уже ясно'));
  for (const option of ['Ролик со смыслом', 'Рекламный промо', 'Урок или длинное видео', 'Лид-магнит']) {
    assert.ok(block.includes(option), option);
  }
  assert.ok(!block.includes(EM_DASH));

  for (const skill of ['reel-turnkey', 'motion-reel', 'reel-from-donor', 'ai-promo']) {
    const text = read(`skills/${skill}/SKILL.md`);
    assert.match(text, /карточк[ауи] \*\*«Что делаем\?»\*\* \(вопрос «Как монтируем\?»\)/u, skill);
  }
  const readme = section(read('README.md'), '## С чего начинается работа');
  assert.match(readme, /«Что делаем\?»/u);
  assert.match(read('CHANGELOG.md').split('## [1.23.0]')[0], /«Что делаем\?»/u);
});

test('копии адаптеров совпадают с каноном, в новых текстах нет длинного тире', () => {
  const canonicalMotion = read('skills/motion-reel/SKILL.md');
  for (const prefix of ['.agents', '.codex']) {
    assert.equal(read(`${prefix}/skills/motion-reel/SKILL.md`), canonicalMotion, prefix);
    const pointer = read(`${prefix}/skills/reel-turnkey/references/creative-motion.md`);
    assert.ok(pointer.includes('skills/reel-turnkey/references/creative-motion.md'), prefix);
  }
  const contract = read(CONTRACT);
  assert.ok(!contract.includes(EM_DASH));
  assert.doesNotMatch(contract, /\/Users\/|\/home\//u);
  assert.ok(!read('tests/intake-card-instructions.test.js').includes(EM_DASH));
});
