// Реальные прямоугольники надписей с отрендеренных кадров финальной композиции: один бандл Remotion
// и один браузер на все кадры, на каждом кадре renderStill и замер DOM по TEXT_SELECTOR. Результат –
// samples для textLayoutGates (G14 «Текст за краем», G15 «Наложение надписей»).
//
// Замер – тот же приём, что в tests/layer-render-still.test.js: renderStill сам открывает и
// закрывает вкладку, а перехват page.close измеряет ровно тот DOM, который только что сфотографирован.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
// Один селектор на весь движок: motion-kit, project-local motion-слой и блоки урока/Dynamic.
const TEXT_SELECTOR = '[data-kit-text],[data-motion-text],[data-qa-text]';
const TEXT_FRAMES_MAX = 40;
const FALLBACK_FRAMES = 16;
const MIN_OPACITY = 0.05;

const isInt = (v) => Number.isInteger(v);
const uniqueSorted = (list) => [...new Set(list)].sort((a, b) => a - b);

// Середина показа одного текста manifest.texts (формат манифеста motion-слоя, timeline-gates.js):
// статичная полоса – [from, until), покадровый текст – от первого до последнего ненулевого frames.
function textMidFrame(text) {
  if (!text || !isInt(text.from)) return null;
  if (Array.isArray(text.static)) {
    if (!isInt(text.until) || text.until <= text.from) return null;
    return Math.floor((text.from + text.until - 1) / 2);
  }
  if (!Array.isArray(text.frames)) return null;
  let first = -1;
  let last = -1;
  text.frames.forEach((b, i) => {
    if (!b) return;
    if (first < 0) first = i;
    last = i;
  });
  return first < 0 ? null : text.from + Math.floor((first + last) / 2);
}

// Равномерная выборка: первый и последний остаются, промежуточные – с равным шагом.
function thin(list, max) {
  if (list.length <= max) return list;
  if (max <= 1) return list.slice(0, Math.max(0, max));
  return uniqueSorted(Array.from({ length: max }, (_, k) => list[Math.round((k * (list.length - 1)) / (max - 1))]));
}

// Кадры для замера: середина показа каждого текста manifest.texts; без манифеста (или без текстов) –
// FALLBACK_FRAMES равномерных кадров (середины равных отрезков, без кадра 0 с анимацией входа).
function pickTextFrames({ manifest = null, durationInFrames, fps, max = TEXT_FRAMES_MAX } = {}) {
  const total = Number.isFinite(durationInFrames) && durationInFrames > 0 ? Math.floor(durationInFrames) : 0;
  const inside = (f) => isInt(f) && f >= 0 && (!total || f < total);
  const texts = manifest && Array.isArray(manifest.texts) ? manifest.texts : [];
  let frames = uniqueSorted(texts.map(textMidFrame).filter(inside));
  if (!frames.length) {
    if (!total) return [];
    frames = uniqueSorted(Array.from({ length: FALLBACK_FRAMES }, (_, i) => Math.floor(((i + 0.5) * total) / FALLBACK_FRAMES)));
  }
  return thin(frames, max);
}

// Выполняется в браузере: сырые замеры каждого размеченного элемента. Прозрачность – произведение
// opacity по всем предкам (у блоков движка opacity анимируется на обёртке, а не на самом тексте).
function measureInPage(selector) {
  return [...document.querySelectorAll(selector)].map((el) => {
    let opacity = 1;
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      const value = parseFloat(getComputedStyle(node).opacity);
      if (Number.isFinite(value)) opacity *= value;
    }
    const rect = el.getBoundingClientRect();
    return {
      id: el.getAttribute('data-qa-text') || el.getAttribute('data-motion-text') || el.getAttribute('data-kit-text') || '',
      rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
      scrollWidth: el.scrollWidth, clientWidth: el.clientWidth,
      scrollHeight: el.scrollHeight, clientHeight: el.clientHeight,
      opacity, visibility: getComputedStyle(el).visibility,
    };
  });
}

// Сырые замеры -> boxes: невидимое (opacity < MIN_OPACITY, visibility: hidden, нулевая площадь)
// отброшено – это не наложение и не текст за краем. Повтор id в одном кадре (два одинаковых блока
// одновременно) получает суффикс #2, #3…, иначе G15 счёл бы их одной группой и пропустил наложение.
function toBoxes(rawList) {
  const seen = new Map();
  const boxes = [];
  for (const item of Array.isArray(rawList) ? rawList : []) {
    if (!item || !item.rect) continue;
    if (!(Number(item.opacity) >= MIN_OPACITY) || item.visibility === 'hidden' || item.visibility === 'collapse') continue;
    const { left, top, right, bottom } = item.rect;
    if (![left, top, right, bottom].every(Number.isFinite) || right - left <= 0 || bottom - top <= 0) continue;
    const base = String(item.id || 'text');
    const count = (seen.get(base) || 0) + 1;
    seen.set(base, count);
    boxes.push({
      id: count > 1 ? `${base}#${count}` : base,
      rect: { left, top, right, bottom },
      clipped: item.scrollWidth > item.clientWidth + 1 || item.scrollHeight > item.clientHeight + 1,
    });
  }
  return boxes;
}

// Тяжёлые модули грузим лениво: тесты подменяют их через deps.
function defaultDeps() {
  const { bundle } = require('@remotion/bundler');
  const { openBrowser, renderStill, selectComposition } = require('@remotion/renderer');
  const { includeInstalledSource, withMotionKitAlias } = require('../remotion-webpack');
  const source = path.join(ROOT, 'src');
  return {
    // Тот же webpack, что у Remotion CLI (remotion.config.js): иначе бандл разошёлся бы с рендером.
    bundle: (options) => bundle({
      ...options,
      webpackOverride: (config) => withMotionKitAlias(includeInstalledSource(config, source), path.join(source, 'motion-kit')),
    }),
    openBrowser: () => openBrowser('chrome', { logLevel: 'error' }),
    selectComposition, renderStill,
  };
}

async function collectTextBoxes({
  entry, compositionId, propsPath, publicDir = null, frames, inputProps = null, root = ROOT,
} = {}, deps = null) {
  if (typeof entry !== 'string' || !entry) throw new Error('не указан entry композиции');
  if (typeof compositionId !== 'string' || !compositionId) throw new Error('не указан id композиции');
  const d = deps || defaultDeps();
  const props = inputProps || JSON.parse(fs.readFileSync(path.resolve(root, propsPath), 'utf8'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-qa-text-'));
  let browser = null;
  try {
    // symlinkPublicDir: исходник урока лежит в public lease – копировать гигабайты ради кадров незачем.
    const serveUrl = await d.bundle({
      entryPoint: path.resolve(root, entry), publicDir: publicDir ? path.resolve(root, publicDir) : null,
      rootDir: root, outDir: path.join(work, 'bundle'), symlinkPublicDir: process.platform !== 'win32',
    });
    browser = await d.openBrowser();
    const composition = await d.selectComposition({ serveUrl, id: compositionId, inputProps: props, puppeteerInstance: browser });
    const total = composition.durationInFrames;
    const wanted = typeof frames === 'function' ? frames(composition) : frames;
    const list = uniqueSorted((Array.isArray(wanted) ? wanted : []).filter((f) => isInt(f) && f >= 0 && (!total || f < total)));

    let measured = null;
    const newPage = browser.newPage.bind(browser);
    browser.newPage = async (...args) => {
      const page = await newPage(...args);
      const close = page.close.bind(page);
      page.close = async (...closeArgs) => {
        try {
          measured = await page.evaluate(measureInPage, TEXT_SELECTOR);
        } finally {
          await close(...closeArgs);
        }
      };
      return page;
    };

    const samples = [];
    for (const frame of list) {
      measured = null;
      await d.renderStill({
        serveUrl, composition, frame, inputProps: props, puppeteerInstance: browser,
        output: path.join(work, `still-${frame}.png`), overwrite: true, onBrowserLog: () => {},
      });
      samples.push({ frame, timeSec: Math.round((frame / composition.fps) * 1000) / 1000, boxes: toBoxes(measured) });
    }
    return samples;
  } finally {
    if (browser) await browser.close({ silent: true });
    fs.rmSync(work, { recursive: true, force: true });
  }
}

module.exports = {
  FALLBACK_FRAMES, MIN_OPACITY, TEXT_FRAMES_MAX, TEXT_SELECTOR, collectTextBoxes, defaultDeps, pickTextFrames, toBoxes,
};
