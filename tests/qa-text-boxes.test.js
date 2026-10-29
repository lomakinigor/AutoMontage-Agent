'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const {
  FALLBACK_FRAMES, MIN_OPACITY, TEXT_FRAMES_MAX, TEXT_SELECTOR, collectTextBoxes, pickTextFrames,
} = require('../scripts/qa/text-boxes');
const { NO_RENDER_HINT, parseArgs, runFinalQa, textLayoutCheck } = require('../scripts/qa/final-qa');
const { loadMotion } = require('./helpers/motion-render');

const ROOT = path.join(__dirname, '..');
const byId = (gates, id) => gates.find((g) => g.id === id);
const box = (l, t, r, b) => [l, t, r, b];

function tempDir(t, prefix = 'qa-text-boxes-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('константы: селектор один на весь движок, пороги из плана', () => {
  assert.equal(TEXT_SELECTOR, '[data-kit-text],[data-motion-text],[data-qa-text]');
  assert.equal(TEXT_FRAMES_MAX, 40);
  assert.equal(FALLBACK_FRAMES, 16);
  assert.equal(MIN_OPACITY, 0.05);
});

test('pickTextFrames: три текста – три кадра в середине показа, по возрастанию', () => {
  const manifest = {
    texts: [
      { id: 'title', from: 10, frames: [null, box(1, 1, 2, 2), box(1, 1, 2, 2), box(1, 1, 2, 2), null] },
      { id: 'caption-1', from: 0, static: box(1, 1, 2, 2), until: 20 },
      { id: 'card', from: 50, frames: [box(1, 1, 2, 2), box(1, 1, 2, 2), box(1, 1, 2, 2)] },
      { id: 'ghost', from: 70, frames: [null, null] },
    ],
  };
  assert.deepEqual(pickTextFrames({ manifest, durationInFrames: 100, fps: 25 }), [9, 12, 51]);
});

test('pickTextFrames: без манифеста – 16 равномерных кадров', () => {
  const frames = pickTextFrames({ manifest: null, durationInFrames: 160, fps: 25 });
  assert.equal(frames.length, 16);
  assert.equal(frames[0], 5);
  assert.equal(frames.at(-1), 155);
  assert.deepEqual(frames, [...frames].sort((a, b) => a - b));
  // Манифест без текстов – тот же запасной вариант.
  assert.deepEqual(pickTextFrames({ manifest: { texts: [] }, durationInFrames: 160, fps: 25 }), frames);
  // Короткий ролик: кадров меньше 16, но без дублей и внутри длительности.
  const short = pickTextFrames({ manifest: null, durationInFrames: 5, fps: 25 });
  assert.deepEqual(short, [0, 1, 2, 3, 4]);
});

test('pickTextFrames: 100 текстов – не больше 40 кадров', () => {
  const texts = Array.from({ length: 100 }, (_, i) => ({ id: `t${i}`, from: i * 10, frames: [box(1, 1, 2, 2), box(1, 1, 2, 2), box(1, 1, 2, 2)] }));
  const frames = pickTextFrames({ manifest: { texts }, durationInFrames: 1000, fps: 25 });
  assert.ok(frames.length <= 40, String(frames.length));
  assert.equal(frames.length, 40);
  assert.equal(new Set(frames).size, frames.length);
  assert.deepEqual(frames, [...frames].sort((a, b) => a - b));
  assert.ok(frames.every((f) => f >= 0 && f < 1000));
  assert.equal(frames[0], 1);
  assert.equal(frames.at(-1), 991);
});

// Заглушки Remotion: renderStill открывает вкладку и закрывает её, как настоящий; evaluate отдаёт
// «сырые» замеры кадра, а фильтрация и clipped считаются в Node.
function stubDeps(rawByFrame, extra = {}) {
  const calls = { bundle: [], renderStill: [], selectors: [], closed: 0 };
  let currentFrame = null;
  const browser = {
    newPage: async () => ({
      evaluate: async (fn, selector) => { calls.selectors.push(selector); return rawByFrame[currentFrame] || []; },
      close: async () => {},
    }),
    close: async () => { calls.closed += 1; },
  };
  return {
    calls,
    deps: {
      bundle: async (options) => { calls.bundle.push(options); return 'http://bundle'; },
      openBrowser: async () => browser,
      selectComposition: async ({ id, inputProps }) => ({ id, fps: 25, width: 1080, height: 1920, durationInFrames: 100, props: inputProps }),
      renderStill: async ({ frame, puppeteerInstance }) => {
        calls.renderStill.push(frame);
        currentFrame = frame;
        const page = await puppeteerInstance.newPage();
        await page.close();
      },
      ...extra,
    },
  };
}

const raw = (id, rect, more = {}) => ({
  id, rect, scrollWidth: 100, clientWidth: 100, scrollHeight: 50, clientHeight: 50, opacity: 1, visibility: 'visible', ...more,
});

test('collectTextBoxes с заглушками deps: прозрачный элемент отброшен, clipped считается, браузер закрыт', async (t) => {
  const dir = tempDir(t);
  const propsPath = path.join(dir, 'props.json');
  fs.writeFileSync(propsPath, JSON.stringify({ width: 1080, height: 1920 }));
  const rect = { left: 100, top: 300, right: 500, bottom: 400 };
  const { calls, deps } = stubDeps({
    10: [
      raw('chip-0', rect),
      raw('ghost', rect, { opacity: 0.01 }),
      raw('hidden', rect, { visibility: 'hidden' }),
      raw('empty', { left: 0, top: 0, right: 0, bottom: 0 }),
      raw('heading-0', rect, { scrollWidth: 140 }),
      raw('heading-0', { left: 100, top: 500, right: 500, bottom: 600 }, { scrollHeight: 52 }),
    ],
    20: [],
  });
  const samples = await collectTextBoxes({
    entry: 'src/index.js', compositionId: 'Dynamic', propsPath, publicDir: dir, frames: [20, 10, 10],
  }, deps);
  assert.equal(calls.bundle.length, 1);
  assert.equal(calls.bundle[0].entryPoint, path.join(ROOT, 'src', 'index.js'));
  assert.equal(calls.bundle[0].publicDir, dir);
  assert.deepEqual(calls.renderStill, [10, 20]);
  assert.ok(calls.selectors.every((s) => s === TEXT_SELECTOR));
  assert.equal(calls.closed, 1);
  assert.deepEqual(samples.map((s) => [s.frame, s.timeSec]), [[10, 0.4], [20, 0.8]]);
  // Повтор одного id в кадре получает суффикс #2, чтобы G15 не счёл две надписи одной группой.
  assert.deepEqual(samples[0].boxes, [
    { id: 'chip-0', rect, clipped: false },
    { id: 'heading-0', rect, clipped: true },
    { id: 'heading-0#2', rect: { left: 100, top: 500, right: 500, bottom: 600 }, clipped: true },
  ]);
  assert.deepEqual(samples[1].boxes, []);
  // Временная папка бандла убрана.
  assert.equal(fs.existsSync(calls.bundle[0].outDir), false);
});

test('collectTextBoxes: renderStill бросает – браузер всё равно закрыт, ошибка наружу', async (t) => {
  const dir = tempDir(t);
  const propsPath = path.join(dir, 'props.json');
  fs.writeFileSync(propsPath, '{}');
  const { calls, deps } = stubDeps({}, { renderStill: async () => { throw new Error('кадр не отрисован'); } });
  await assert.rejects(collectTextBoxes({ entry: 'src/index.js', compositionId: 'Lesson', propsPath, frames: [1] }, deps), /кадр не отрисован/);
  assert.equal(calls.closed, 1);
});

test('collectTextBoxes: frames-функция получает композицию и обрезается по её длине', async (t) => {
  const dir = tempDir(t);
  const propsPath = path.join(dir, 'props.json');
  fs.writeFileSync(propsPath, '{}');
  const { calls, deps } = stubDeps({});
  const seen = [];
  await collectTextBoxes({
    entry: 'src/index.js', compositionId: 'Lesson', propsPath,
    frames: (composition) => { seen.push(composition.durationInFrames); return [5, 150]; },
  }, deps);
  assert.deepEqual(seen, [100]);
  assert.deepEqual(calls.renderStill, [5]);
});

const RENDER = { entry: 'src/index.js', compositionId: 'Lesson', propsPath: 'out/x.props.json', publicDir: null, fps: 25, width: 1080, height: 1920 };

test('collectTextBoxes: openBrowser бросает – проверка text-layout отдаёт G14/G15 skipped с текстом ошибки', async (t) => {
  const dir = tempDir(t);
  const finalPath = path.join(dir, 'final.mp4');
  fs.writeFileSync(finalPath, 'mp4');
  const propsPath = path.join(dir, 'props.json');
  fs.writeFileSync(propsPath, '{}');
  const { deps } = stubDeps({}, { openBrowser: async () => { throw new Error(`Chrome не запустился: ${dir}/chrome`); } });
  const gates = await textLayoutCheck({ projectDir: dir, finalPath, render: { ...RENDER, propsPath }, deps: { textBoxesDeps: deps } });
  assert.deepEqual(gates.map((g) => [g.id, g.status]), [['G14', 'skipped'], ['G15', 'skipped']]);
  assert.match(byId(gates, 'G14').hint, /Chrome не запустился/);
  assert.doesNotMatch(byId(gates, 'G14').hint, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('text-layout без данных рендера – G14/G15 skipped с подсказкой; с данными – находки G14', async (t) => {
  const none = await textLayoutCheck({ projectDir: null, finalPath: '/x/final.mp4', deps: {} });
  assert.deepEqual(none.map((g) => [g.id, g.status, g.hint]), [['G14', 'skipped', NO_RENDER_HINT], ['G15', 'skipped', NO_RENDER_HINT]]);

  const seen = [];
  const gates = await textLayoutCheck({
    projectDir: null, finalPath: '/x/final.mp4', render: RENDER,
    deps: {
      collectTextBoxesImpl: async (options) => {
        seen.push(options);
        return [{ frame: 10, timeSec: 0.4, boxes: [{ id: 'label-top', rect: { left: 44, top: 70, right: 300, bottom: 130 }, clipped: false }] }];
      },
    },
  });
  assert.equal(seen[0].compositionId, 'Lesson');
  assert.equal(typeof seen[0].frames, 'function');
  assert.equal(seen[0].frames({ durationInFrames: 160, fps: 25 }).length, 16);
  assert.equal(byId(gates, 'G14').status, 'warn');
  assert.equal(byId(gates, 'G15').status, 'pass');
});

test('runFinalQa: render из ctx доходит до text-layout, отчёт с G14/G15', async (t) => {
  const dir = tempDir(t);
  const finalPath = path.join(dir, 'final.mp4');
  fs.writeFileSync(finalPath, 'mp4');
  const checks = [{ id: 'text-layout', run: textLayoutCheck }];
  const { report } = await runFinalQa({ finalPath, render: RENDER, write: false, checks }, {
    collectTextBoxesImpl: async () => [{ frame: 1, timeSec: 0.04, boxes: [{ id: 'chip-0', rect: { left: 100, top: 300, right: 500, bottom: 400 }, clipped: false }] }],
  });
  assert.equal(report.error, null);
  assert.deepEqual(report.gates.map((g) => [g.id, g.status]), [['G14', 'pass'], ['G15', 'pass']]);
});

test('parseArgs --render-json: проверяет поля; битый JSON или поле – ошибка', () => {
  const options = parseArgs(['--from-build', '--final', '/f.mp4', '--render-json', JSON.stringify(RENDER)]);
  assert.deepEqual(options.render, RENDER);
  assert.throws(() => parseArgs(['--render-json', '{нет']), /--render-json/);
  assert.throws(() => parseArgs(['--render-json', JSON.stringify({ ...RENDER, compositionId: '' })]), /compositionId/);
  assert.throws(() => parseArgs(['--render-json', JSON.stringify({ ...RENDER, width: -1 })]), /width/);
  assert.throws(() => parseArgs(['--render-json', JSON.stringify({ ...RENDER, publicDir: 5 })]), /publicDir/);
});

// Метки data-qa-text: разметка компонентов движка (как в tests/motion-render.test.js).
// fitText из @remotion/layout-utils меряет текст canvas-ом браузера; в Node подменяем его на время
// рендера разметки через кэш require (helpers/motion-render отдаёт этот модуль обычному require).
function withNodeFitText(fn) {
  const id = require.resolve('@remotion/layout-utils');
  const previous = require.cache[id];
  require.cache[id] = { id, filename: id, loaded: true, exports: { fitText: () => ({ fontSize: 60 }) } };
  try {
    return fn();
  } finally {
    if (previous) require.cache[id] = previous;
    else delete require.cache[id];
  }
}
const markup = (file, name, props = {}) => withNodeFitText(() => renderToStaticMarkup(React.createElement(loadMotion(file)[name], props)));
const qaIds = (html) => [...html.matchAll(/data-qa-text="([^"]+)"/g)].map((m) => m[1]);

test('InfoCard рендерится с data-qa-text', () => {
  const html = markup('src/blocks/InfoCard.jsx', 'InfoCard', { tag: '// ТЕГ', title: 'ЗАГОЛОВОК', pills: ['А', 'Б'], countPill: { value: 5, suffix: 'шт' } });
  assert.deepEqual(qaIds(html), ['info-tag', 'info-title', 'info-count', 'info-pill-0', 'info-pill-1']);
});

test('остальные блоки и части сцен урока размечены data-qa-text', () => {
  assert.deepEqual(qaIds(markup('src/blocks/CTACard.jsx', 'CTACard', { head: 'ЖМИ', btn: 'ССЫЛКА' })), ['cta-head', 'cta-button']);
  assert.deepEqual(qaIds(markup('src/blocks/CounterCard.jsx', 'CounterCard', { label: 'ВСЕГО', value: 5 })), ['counter-label', 'counter-value']);
  assert.deepEqual(qaIds(markup('src/blocks/SubtitleCard.jsx', 'SubtitleCard', { text: 'РЕПЛИКА', sub: 'подпись' })), ['subtitle-text', 'subtitle-sub']);
  assert.deepEqual(qaIds(markup('src/blocks/LabelTop.jsx', 'LabelTop', { text: '>_ АНОНС' })), ['label-top']);
  assert.deepEqual(qaIds(markup('src/scenes/parts.jsx', 'Chip', { text: 'ВИДЕО' })), ['chip-title']);
  assert.deepEqual(qaIds(markup('src/scenes/parts.jsx', 'FitHeading', { cream: 'ОДИН', orange: 'ДВА', width: 900 })), ['heading-text']);
});

// Настоящий Chrome (опт-ин, как tests/layer-render-still.test.js): Dynamic с LabelTop, который стоит
// выше безопасной зоны 9:16 (top 70 при safe.top 250) – G14 warn.
test('реальный renderStill кадра с текстом за краем – G14 warn', {
  skip: process.env.AUTOMONTAGE_TEST_MOTION_RENDER !== '1', timeout: 300_000,
}, async (t) => {
  const dir = tempDir(t, 'qa-text-boxes-real-');
  const publicDir = path.join(dir, 'public');
  fs.mkdirSync(publicDir);
  fs.copyFileSync(path.join(ROOT, 'examples', 'demo-source.mp4'), path.join(publicDir, 'source.mp4'));
  const propsPath = path.join(dir, 'props.json');
  fs.writeFileSync(propsPath, JSON.stringify({
    source: 'source.mp4', theme: 'craft', width: 1080, height: 1920, fps: 25, durationInFrames: 50,
    blocks: [{ type: 'LabelTop', start: 0, end: 2, text: '>_ ЗА КРАЕМ' }],
  }));
  const render = { entry: 'src/index.js', compositionId: 'Dynamic', propsPath, publicDir, fps: 25, width: 1080, height: 1920 };
  const samples = await collectTextBoxes({ ...render, frames: [40] });
  assert.deepEqual(samples[0].boxes.map((b) => b.id), ['label-top']);
  const gates = await textLayoutCheck({ projectDir: null, finalPath: path.join(dir, 'final.mp4'), render, deps: {} });
  assert.equal(byId(gates, 'G14').status, 'warn', JSON.stringify(gates));
});
