const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Курс «Ролики с нуля» должен описывать движок 1.24: финал сразу после «Утверждаю»,
// стартовая карточка «Что делаем?», шаг обновления движка (задача 1), а также критик,
// проверка финала, чистка, «Финал не нужен», 16:9, Windows и новые статьи словаря (задача 2),
// сквозной урок 11 про промо 16:9 и оглавление на 11 уроков (задача 3).

const ROOT = path.resolve(__dirname, '..');
const GUIDE = 'docs/reels-guide';
const read = relativePath => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
// Текст без переносов строк: фразы в Markdown переносятся где угодно.
const flat = relativePath => read(relativePath).replace(/\s+/gu, ' ');
const EM_DASH = String.fromCodePoint(0x2014);
// Предложения плоского текста: проверяем, что слова стоят рядом, в одной мысли.
const sentences = text => text.split(/(?<=[.!?])\s+/u);
const oneSentence = (text, patterns) => sentences(text).some(s => patterns.every(p => p.test(s)));
// Подпись пульта «Утверждено - агент собирает финал» – законная цитата, а не старая инструкция.
const PULT_RENDER_LABEL = /«Утверждено ?[-–] ?агент собирает финал»/gu;

// Старые формулировки: «передайте фразу – агент соберёт финал» для обычного полного preview.
const STALE_FINAL = [
  /Скопируйте фразу для агента ?[-–] ?он соберёт финал/u,
  /фраз\S*[^.]{0,100}?(?:агент|он) (?:соберёт|собирает) финал/iu,
  /Финалы? он собирает/u,
  /Фраза из пульта ?[-–] ?это команда «собирай»/u,
  /Фразу из пульта не передали агенту/u,
  /Только после неё агент собирает финал/u,
  /Передаём утверждение агенту/u,
];

test('после «Утверждаю» финал не ждёт фразы агенту в уроках 05, 06, 08, 10 и шпаргалке', () => {
  for (const name of ['05-pult.md', '06-final.md', '08-batch.md', '10-ai-promo.md', 'PROMPTS.md', 'README.md']) {
    const text = flat(`${GUIDE}/${name}`).replace(PULT_RENDER_LABEL, '«подпись пульта»');
    for (const pattern of STALE_FINAL) assert.doesNotMatch(text, pattern, `${name}: ${pattern}`);
  }
});

test('нет устаревшей цифры «семь финалов за 22 минуты»', () => {
  for (const name of fs.readdirSync(path.join(ROOT, GUIDE)).filter(f => f.endsWith('.md'))) {
    const text = flat(`${GUIDE}/${name}`);
    assert.doesNotMatch(text, /семь финалов/u, name);
    assert.doesNotMatch(text, /за 22 минуты/u, name);
  }
});

test('урок 05: «Утверждаю» сразу даёт финал, проверка финала в фоне, рендер только для исключений', () => {
  const text = flat(`${GUIDE}/05-pult.md`);
  assert.match(text, /Финал готов ?[-–] ?можно забирать/u);
  assert.ok(oneSentence(text, [/«Утверждаю»/u, /финал/u, /секунд/u]), '«Утверждаю», финал и секунды в одной фразе');
  assert.ok(oneSentence(text, [/проверк\S* финала/iu, /в фоне/u]), 'проверка финала в фоне');
  assert.match(text, /фрагмент/iu);
  assert.match(text, /4K/u);
});

test('урок 04 и README курса начинаются с карточки «Что делаем?»', () => {
  const montage = flat(`${GUIDE}/04-montage.md`);
  assert.match(montage, /«Что делаем\?»/u);
  for (const question of ['Формат?', 'Из чего собираем?', 'Как монтируем?']) {
    assert.ok(montage.includes(`«${question}»`), question);
  }
  // «По референсу» – ответ про исходник и только для вертикали.
  assert.match(montage, /референс[^.]*9:16|9:16[^.]*референс/iu);
  assert.match(flat(`${GUIDE}/README.md`), /«Что делаем\?»/u);
  assert.match(flat(`${GUIDE}/README.md`), /финал за секунды/iu);
});

test('урок 01: раздел обновления движка с npm ci и фразой агенту', () => {
  const text = read(`${GUIDE}/01-setup.md`);
  const start = text.search(/^## .*Обновление движка/mu);
  assert.ok(start >= 0, 'нет раздела «Обновление движка»');
  const rest = text.slice(start + 3);
  const next = rest.search(/\n## /u);
  const section = next < 0 ? rest : rest.slice(0, next);
  assert.match(section, /npm ci/u);
  assert.match(section, /git pull/u);
  assert.match(section, /requirements\.txt/u);
  assert.match(section, /Обнови движок/u);
  assert.match(flat(`${GUIDE}/PROMPTS.md`), /Обнови движок/u);
});

test('словарь: маршрут через «Что делаем?», актуальные проверки, финал из preview', () => {
  const text = flat(`${GUIDE}/GLOSSARY.md`);
  assert.doesNotMatch(text, /Основных ?[-–] ?12/u);
  assert.match(text, /G16/u);
  assert.match(text, /«Что делаем\?»/u);
  assert.doesNotMatch(text, /Creative Motion, готовый стиль или по референсу/u);
  // Preview и Финал: финальное качество preview, «ЧЕРНОВИК» рисует плеер, финал – копия по SHA-256.
  const row = word => (text.match(new RegExp(`\\| \\*\\*${word}\\*\\*[^|]*\\| ([^|]+)\\|`, 'u')) || [])[1] || '';
  assert.match(row('Preview'), /ЧЕРНОВИК/u);
  assert.match(row('Preview'), /плеер/u);
  assert.match(row('Финал'), /SHA-256/u);
  assert.match(row('Финал'), /секунд/u);
});

test('docs/BATCH-REELS-WORKFLOW.md: финалы из просмотренного preview не рендерятся заново', () => {
  const text = flat('docs/BATCH-REELS-WORKFLOW.md');
  assert.doesNotMatch(text, /approved-финалы рендерятся последовательно/u);
  assert.match(text, /D-051/u);
});

test('во всех файлах курса нет длинного тире и личных путей', () => {
  for (const name of fs.readdirSync(path.join(ROOT, GUIDE)).filter(f => f.endsWith('.md'))) {
    const text = read(`${GUIDE}/${name}`);
    assert.ok(!text.includes(EM_DASH), `${name}: U+2014`);
    assert.doesNotMatch(text, /\/Users\/|\/home\//u, name);
  }
});

// ---- Задача 2: недостающее ----

const CLEANUP_WITH_YES = /(?:чистк|почист)[^]{0,200}?«да»/iu;

test('критик по кадрам описан в уроках 04 и 10: до трёх кругов, видео рендерится один раз', () => {
  for (const name of ['04-montage.md', '10-ai-promo.md']) {
    const text = flat(`${GUIDE}/${name}`);
    assert.match(text, /критик/iu, name);
    assert.match(text, /(?:до|не больше) трёх кругов/u, name);
    assert.match(text, /один раз/u, name);
  }
});

test('урок 05: «ЧЕРНОВИК» рисует плеер, файл чистый; строки фоновой проверки', () => {
  const text = flat(`${GUIDE}/05-pult.md`);
  assert.ok(oneSentence(text, [/«ЧЕРНОВИК»/u, /(?:пульт|плеер)/u]), '«ЧЕРНОВИК» рисует плеер');
  assert.match(text, /в файле её нет/u);
  for (const line of ['Идёт фоновая проверка финала', 'Проверка финала пройдена', 'Проверка финала нашла замечания', 'Проверка финала не выполнена']) {
    assert.ok(text.includes(line), line);
  }
});

test('урок 06: отчёт фоновой проверки F1-F5 и G13-G15, рендерные проверки помечены, «Финал не нужен», чистка', () => {
  const text = flat(`${GUIDE}/06-final.md`);
  for (const gate of ['F1', 'F2', 'F3', 'F4', 'F5', 'G13', 'G14', 'G15']) assert.match(text, new RegExp(`\\b${gate}\\b`, 'u'), gate);
  assert.match(text, /только предупреждения/u);
  // «Совпадение с preview» и «Синхрон» есть только у финала рендером.
  assert.match(text, /Совпадение с preview[^|]*\|[^|]*\|[^|]*\|[^|]*рендер|Совпадение с preview[^|]*рендер/iu);
  assert.match(text, /Синхрон[^|]*рендер|Синхрон[^|]*\|[^|]*\|[^|]*\|[^|]*рендер/iu);
  assert.match(text, /«Финал не нужен»/u);
  assert.match(text, /«Вернуть: собрать финал»/u);
  assert.match(text, CLEANUP_WITH_YES);
});

test('чистка после финала: агент предлагает, удаляет только после «да» (06, 08, 10, README)', () => {
  for (const name of ['06-final.md', '08-batch.md', '10-ai-promo.md', 'README.md']) {
    assert.match(flat(`${GUIDE}/${name}`), CLEANUP_WITH_YES, name);
  }
});

test('горизонталь 16:9 и маршрут «без съёмки» в README, 03 и 09', () => {
  for (const name of ['README.md', '03-source-video.md', '09-publish.md']) {
    assert.match(flat(`${GUIDE}/${name}`), /16:9/u, name);
  }
  for (const name of ['README.md', '03-source-video.md']) {
    assert.match(flat(`${GUIDE}/${name}`), /без съёмки/iu, name);
  }
});

test('урок 01: Windows-эквиваленты и что отвечает doctor', () => {
  const text = flat(`${GUIDE}/01-setup.md`);
  assert.match(text, /Ctrl ?\+ ?S/u);
  assert.match(text, /Проводник/u);
  assert.match(text, /Git/u);
  assert.match(text, /Add to PATH/u);
  assert.match(text, /winget/u);
  assert.match(text, /Всё готово\. Можно монтировать/u);
  assert.match(text, /WARN/u);
  assert.match(text, /предупреждени[^.]*нормально|нормально[^.]*предупреждени/iu);
  // Строка с лишним пробелом в начале у ссылки на инструкцию пульта.
  assert.doesNotMatch(read(`${GUIDE}/01-setup.md`), /^ Подробно про/mu);
});

test('урок 07: лид-магнит без обещания, без ролика и из промо; что такое Chatplace', () => {
  const text = flat(`${GUIDE}/07-lead-magnet.md`);
  assert.match(text, /без обещания/iu);
  assert.match(text, /без ролика/iu);
  assert.match(text, /промо/iu);
  assert.match(text, /Chatplace ?[-–] ?сервис/u);
});

test('урок 08: таблица финалов по запросу, время критика, чистка пакета', () => {
  const text = flat(`${GUIDE}/08-batch.md`);
  assert.match(text, /таблицу финалов/u);
  assert.match(text, /критик/iu);
  assert.ok(oneSentence(text, [/(?:чистк|почист)/iu, /«да»/u]), 'чистка пакета только после «да»');
});

test('урок 10: вход через «Что делаем?», 16:9, оверлеи Higgsfield со сметой и «да», без CLI-команд', () => {
  const text = flat(`${GUIDE}/10-ai-promo.md`);
  assert.match(text, /«Что делаем\?»/u);
  assert.match(text, /16:9/u);
  assert.match(text, /оверле/iu);
  assert.ok(oneSentence(text, [/смет/u, /«да»/u]), 'смета и «да» в одной фразе');
  assert.doesNotMatch(text, /claude mcp add/u);
  assert.doesNotMatch(text, /--music-only/u);
});

test('урок 02: длину ролика агент выбирает сам и называет в плане', () => {
  assert.match(flat(`${GUIDE}/02-idea-and-script.md`), /называет (?:её )?в плане/u);
});

test('шпаргалка: фраза-старт, обновление, чистка, «Финал не нужен», промо 16:9', () => {
  const text = flat(`${GUIDE}/PROMPTS.md`);
  assert.match(text, /«Что делаем\?»/u);
  assert.match(text, /Обнови движок/u);
  assert.match(text, /Почисти ролик/u);
  assert.match(text, /Финал (?:ролика [^|]*)?не нужен/u);
  assert.match(text, /Горизонталь 16:9/u);
});

test('словарь: на 13 статей больше (65 до задачи 2) и новые термины без дублей', () => {
  const text = read(`${GUIDE}/GLOSSARY.md`);
  const terms = [...text.matchAll(/^\| \*\*([^*]+)\*\*/gmu)].map(m => m[1]);
  assert.ok(terms.length >= 78, `статей: ${terms.length}`);
  assert.equal(new Set(terms).size, terms.length, 'дубли в словаре');
  for (const term of ['Критик', 'Чистка ролика', '«Финал не нужен»', 'Вертикаль 9:16 и горизонталь 16:9', 'Ролик без съёмки',
    'Переход', 'Наезд камеры', 'Счётчик', 'График', 'Живой фон', 'Оверлеи Higgsfield', 'Смета', 'doctor']) {
    assert.ok(terms.some(t => t.startsWith(term)), term);
  }
});

// ---- Задача 3: урок 11 «Сквозной пример: промо 16:9 за вечер» ----

const LESSON_11 = '11-end-to-end-promo.md';
const FRAMES = 'docs/images/reels-guide/avtonomka-frames.jpg';

// Относительные ссылки Markdown (страницы и картинки) без внешних адресов и якорей.
const relativeLinks = text => [...text.matchAll(/\]\(([^)\s]+)\)/gu)]
  .map(m => m[1])
  .filter(target => !/^(?:[a-z]+:|#)/iu.test(target))
  .map(target => decodeURI(target.split('#')[0]));

test('урок 11 существует, а его ссылки и ссылки README курса ведут на настоящие файлы', () => {
  assert.ok(fs.existsSync(path.join(ROOT, GUIDE, LESSON_11)), 'нет урока 11');
  for (const name of [LESSON_11, 'README.md']) {
    const links = relativeLinks(read(`${GUIDE}/${name}`));
    assert.ok(links.length > 0, `${name}: нет ссылок`);
    for (const target of links) {
      assert.ok(fs.existsSync(path.resolve(ROOT, GUIDE, target)), `${name}: битая ссылка ${target}`);
    }
  }
});

test('урок 11: реальные цифры прогона и кадры ролика', () => {
  const text = flat(`${GUIDE}/${LESSON_11}`);
  for (const figure of ['7,5', '8,9', '9,0', '8,4 МБ']) assert.ok(text.includes(figure), figure);
  assert.ok(fs.existsSync(path.join(ROOT, FRAMES)), 'нет картинки кадров');
  assert.ok(text.includes('../images/reels-guide/avtonomka-frames.jpg'), 'картинка не вставлена');
  assert.match(text, /«Что делаем\?»/u);
  assert.match(text, /16:9/u);
  assert.ok(oneSentence(text, [/смет/u, /«да»/u]), 'смета и «да» в одной фразе');
  assert.ok(oneSentence(text, [/«Утверждаю»/u, /финал/u]), '«Утверждаю» даёт финал');
  assert.match(text, CLEANUP_WITH_YES);
  // Лицензию музыки не обещаем от себя: читатель сверяется со страницей трека.
  assert.match(text, /условиями на странице трека/u);
});

test('README курса: 11 уроков, название шире вертикали, новые возможности с правильной оговоркой', () => {
  const text = flat(`${GUIDE}/README.md`);
  assert.ok(text.includes(`(${LESSON_11})`), 'нет ссылки на урок 11');
  assert.match(read(`${GUIDE}/README.md`), /^# Ролики с нуля: ролики для соцсетей и YouTube/mu);
  for (const word of ['переход', 'наезд', 'счётчик', 'график', 'живой фон', '16:9']) {
    assert.match(text, new RegExp(word, 'iu'), word);
  }
  // Переходы, счётчик, графики и живой фон – для роликов без съёмки и промо; у спикера – наезд.
  assert.ok(oneSentence(text, [/переход/iu, /счётчик/iu, /без съёмки/iu]), 'оговорка про ролики без съёмки');
});

test('уроки 09 и 10 ведут на урок 11', () => {
  for (const name of ['09-publish.md', '10-ai-promo.md']) {
    assert.ok(read(`${GUIDE}/${name}`).includes(`(${LESSON_11})`), name);
  }
});

// ---- Финальное ревью курса ----

test('промо без речи: фоновая проверка финала смотрит только обложку, надписи никто не замеряет - их смотрит человек (10, 06, словарь)', () => {
  // scripts/qa/final-qa-job.js: у motion-reel (без съёмки и промо) G14/G15 пропускаются (⏭️).
  // Барьер preview (scripts/qa/motion-preview-gates.js) надписи не замеряет: замер есть только
  // в final-qa.js. Значит, у этих роликов надписи проверяет человек глазами на preview.
  const wrong = /проверил[аи]? ещё до preview|проверены (?:ещё )?до preview/u;
  const promo = flat(`${GUIDE}/10-ai-promo.md`);
  assert.doesNotMatch(promo, /проверяются только кадры: обложка и надписи/u);
  assert.doesNotMatch(promo, wrong);
  assert.ok(oneSentence(promo, [/обложк/u, /первый кадр/u]), 'урок 10: только обложка - первый кадр');
  assert.ok(oneSentence(promo, [/[Нн]адписи/u, /не замеря/u, /⏭️/u]), 'урок 10: надписи не замеряются, ⏭️');
  assert.ok(oneSentence(promo, [/глазами/u, /preview/u]), 'урок 10: надписи проверяете глазами на preview');
  const final = flat(`${GUIDE}/06-final.md`);
  assert.doesNotMatch(final, wrong);
  assert.ok(oneSentence(final, [/без съёмки/u, /промо/u, /надпис/u, /не замеря/u, /⏭️/u]), 'урок 06: надписи у роликов без съёмки и промо не замеряются');
  assert.ok(oneSentence(final, [/[Нн]адписи/u, /глазами/u, /preview/u]), 'урок 06: надписи проверяет человек на preview');
  const glossary = flat(`${GUIDE}/GLOSSARY.md`);
  const row = (glossary.match(/\| \*\*Проверка финала\*\* \| ([^|]+)\|/u) || [])[1] || '';
  assert.doesNotMatch(row, wrong);
  assert.match(row, /не замеря/u);
  assert.match(row, /⏭️/u);
  assert.match(row, /при просмотре preview/u);
});

test('урок 11: техническая подготовка перед рендером не называется «пакетом»', () => {
  const text = flat(`${GUIDE}/${LESSON_11}`);
  assert.doesNotMatch(text, /64 секунды пакет|пакет ?[-–] ?64/u);
  assert.match(text, /подготовка анимаций ?[-–] ?64 секунды/u);
  assert.match(text, /рендер ролика ?[-–] ?52 секунды/u);
});

test('цена ключевого кадра зависит от модели: у Nano Banana около 1 кредита (README, 10)', () => {
  for (const name of ['README.md', '10-ai-promo.md']) {
    assert.ok(oneSentence(flat(`${GUIDE}/${name}`), [/зависит от модели/u, /Nano Banana около 1\b/u]), name);
  }
});

test('урок 06: норма пиков та же, что в коде (true peak −1,5 дБ)', () => {
  const text = flat(`${GUIDE}/06-final.md`);
  assert.doesNotMatch(text, /ниже 0 дБ с запасом/u);
  assert.match(text, /пики не выше −1,5 дБ/u);
});

test('исключения «финал рендером» везде включают сбой копирования', () => {
  // AGENTS.md: строка «Утверждено» остаётся, когда preview нельзя продвинуть: фрагмент, 4K,
  // устаревший preview или сбой копирования.
  let found = 0;
  for (const name of fs.readdirSync(path.join(ROOT, GUIDE)).filter(f => f.endsWith('.md'))) {
    for (const s of sentences(flat(`${GUIDE}/${name}`))) {
      if (!(/фрагмент/iu.test(s) && /4K/u.test(s) && /устар|прежней версии/iu.test(s))) continue;
      found += 1;
      assert.match(s, /копирован[^.]{0,30}? не удал|не удалось скопировать/iu, `${name}: ${s.slice(0, 120)}`);
    }
  }
  assert.ok(found >= 8, `мест со списком исключений: ${found}`);
});

// GitHub-slug заголовка: нижний регистр, без пунктуации (кроме дефисов и пробелов), пробел → «-».
// Кириллица и «ё» сохраняются.
const slugify = heading => heading.trim().toLowerCase()
  .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
  .replace(/ /gu, '-');

const anchorsOf = text => {
  const seen = new Map();
  const anchors = new Set();
  const withoutCode = text.replace(/^```[^]*?^```/gmu, '');
  for (const m of withoutCode.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gmu)) {
    const base = slugify(m[1].replace(/`/gu, '').replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1'));
    const count = seen.get(base) || 0;
    seen.set(base, count + 1);
    anchors.add(count ? `${base}-${count}` : base);
  }
  return anchors;
};

test('все ссылки курса ведут на настоящие файлы и якоря', () => {
  let checkedAnchors = 0;
  for (const name of fs.readdirSync(path.join(ROOT, GUIDE)).filter(f => f.endsWith('.md'))) {
    for (const m of read(`${GUIDE}/${name}`).matchAll(/\]\(([^)\s]+)\)/gu)) {
      const target = m[1];
      if (/^[a-z]+:/iu.test(target)) continue;
      const [file, anchor] = target.split('#');
      const resolved = file ? path.resolve(ROOT, GUIDE, decodeURI(file)) : path.join(ROOT, GUIDE, name);
      assert.ok(fs.existsSync(resolved), `${name}: битая ссылка ${target}`);
      if (anchor === undefined || !resolved.endsWith('.md')) continue;
      const anchors = anchorsOf(fs.readFileSync(resolved, 'utf8'));
      assert.ok(anchors.has(decodeURIComponent(anchor)), `${name}: нет якоря #${anchor} в ${file || name}`);
      checkedAnchors += 1;
    }
  }
  assert.ok(checkedAnchors > 10, `проверено якорей: ${checkedAnchors}`);
});
