// Сцена 16:9 в общих деталях motion: выбор сцены по реальному кадру, safe-зона и ширина
// содержимого по выбранной сцене, масштаб SceneFrame по короткой стороне. Вертикаль не меняется.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { loadMotion, brief } = require('./helpers/motion-render');
const { buildMotionProps } = require('../scripts/motion/brief');
const { SAFE_9x16, SAFE_16x9 } = loadMotion('src/scenes/safezone.js');

const config = (width, height) => ({ useVideoConfig: () => ({ width, height, fps: 30, durationInFrames: 90 }) });
const partsAt = (width, height) => loadMotion('src/motion/parts.jsx', config(width, height));
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const frameMarkup = (width, height) => renderToStaticMarkup(
  React.createElement(partsAt(width, height).SceneFrame, { caption: 'Подпись' }, 'x'),
);
const styleOf = (markup, marker) => markup.match(new RegExp(`${marker}[^>]*style="([^"]*)"`))[1];

// Разметка SceneFrame и MotionDirector до появления сцены 16:9 (коммит cd4b3b83): вертикаль
// должна совпадать байт-в-байт.
const VERTICAL_FRAME_SHA = {
  '1080x1920': '2999c03be5b15799a4645f77770ea0d1367b117f1670755a14a366ef990f30a2',
  '720x1280': '24a1d0c87de5ff72d1e002e8317826d5de362e56d75e3b001b7d606b87402108',
  '2160x3840': 'fe88031b536dfffb48fc6d5f624dc66ba00bc33d7d161b8a350e9fc783bd319d',
};
const VERTICAL_DIRECTOR_SHA = '20b9d40b87857a0c6130d9f82e14684f81db0ad74d1ad0249cc994cc688a095a';

test('вертикальные экспорты прежние: 1080×1920, CONTENT_WIDTH 880', () => {
  const parts = partsAt(1080, 1920);
  assert.equal(parts.MOTION_WIDTH, 1080);
  assert.equal(parts.MOTION_HEIGHT, 1920);
  assert.equal(parts.CONTENT_WIDTH, 880);
});

test('MOTION_STAGES и stageFor: выбор сцены по реальному кадру', () => {
  const { MOTION_STAGES, stageFor } = partsAt(1080, 1920);
  assert.deepEqual(MOTION_STAGES, { vertical: { width: 1080, height: 1920 }, horizontal: { width: 1920, height: 1080 } });
  assert.equal(stageFor(1080, 1920), MOTION_STAGES.vertical);
  assert.equal(stageFor(720, 1280), MOTION_STAGES.vertical);
  assert.equal(stageFor(1920, 1080), MOTION_STAGES.horizontal);
  assert.equal(stageFor(3840, 2160), MOTION_STAGES.horizontal);
});

test('useMotionStage при 1080×1920: вертикальная сцена, SAFE_9x16, contentWidth 880', () => {
  const { useMotionStage, MOTION_STAGES } = partsAt(1080, 1920);
  assert.deepEqual(useMotionStage(), { stage: MOTION_STAGES.vertical, safe: SAFE_9x16, contentWidth: 880, horizontal: false });
});

test('useMotionStage при 1920×1080: горизонтальная сцена, SAFE_16x9, contentWidth 1920-80-80', () => {
  const { useMotionStage, MOTION_STAGES } = partsAt(1920, 1080);
  const value = useMotionStage();
  assert.deepEqual(Object.keys(value).sort(), ['contentWidth', 'horizontal', 'safe', 'stage']);
  assert.deepEqual(value, { stage: MOTION_STAGES.horizontal, safe: SAFE_16x9, contentWidth: 1920 - 80 - 80, horizontal: true });
});

test('SceneFrame в вертикали совпадает с прежней разметкой байт-в-байт', () => {
  for (const [size, expected] of Object.entries(VERTICAL_FRAME_SHA)) {
    const [width, height] = size.split('x').map(Number);
    assert.equal(sha(frameMarkup(width, height)), expected, size);
  }
});

test('SceneFrame при 1920×1080: сцена 1920×1080 в масштабе 1, safe-контейнер на 60/80', () => {
  const markup = frameMarkup(1920, 1080);
  const outer = markup.match(/^<div style="([^"]*)"/)[1];
  assert.match(outer, /width:1920px;height:1080px;left:0;top:0;transform:scale\(1\)/);
  const safe = styleOf(markup, 'data-motion-safe="true"');
  assert.match(safe, /top:60px;left:80px;width:1760px;height:960px/);
  // Акцент лежит в верхнем поле над safe-зоной и начинается от её левого края.
  const accent = styleOf(markup, 'aria-hidden="true"');
  const top = Number(accent.match(/top:(\d+)px/)[1]);
  const height = Number(accent.match(/height:(\d+)px/)[1]);
  assert.match(accent, /left:80px/);
  assert.ok(top >= 0 && top + height <= SAFE_16x9.top, accent);
  // Подпись помещается внутри safe-зоны и не выше прежней вертикальной.
  const caption = styleOf(markup, 'data-motion-caption="true"');
  assert.ok(Number(caption.match(/height:(\d+)px/)[1]) <= 160, caption);
});

test('SceneFrame масштабирует горизонтальную сцену по короткой стороне (k = min(w, h) / 1080)', () => {
  for (const [width, height, k] of [[3840, 2160, 2], [1280, 720, 720 / 1080]]) {
    const outer = frameMarkup(width, height).match(/^<div style="([^"]*)"/)[1];
    assert.match(outer, /width:1920px;height:1080px;left:0;top:0/, `${width}x${height}`);
    assert.match(outer, new RegExp(`transform:scale\\(${String(k).replace('.', '\\.')}\\)`), `${width}x${height}`);
  }
});

test('MotionDirector в вертикали совпадает с прежней разметкой байт-в-байт', () => {
  const { MotionDirector } = loadMotion('src/MotionDirector.jsx');
  const markup = renderToStaticMarkup(React.createElement(MotionDirector, { ...buildMotionProps({ brief: brief() }), draftPreview: true }));
  assert.equal(sha(markup), VERTICAL_DIRECTOR_SHA);
});

test('водяной знак «черновик» – по короткой стороне: одинаковый в 1080×1920 и 1920×1080', () => {
  for (const [width, height] of [[1080, 1920], [1920, 1080]]) {
    const { MotionDirector } = loadMotion('src/MotionDirector.jsx', config(width, height));
    const tree = MotionDirector({ scenes: [], draftPreview: true });
    const mark = React.Children.toArray(tree.props.children).find((el) => el?.props?.['data-draft-preview-watermark'] === 'true');
    assert.equal(mark.props.style.fontSize, 32.4, `${width}x${height}`);
  }
});

function children(element) {
  if (!element || typeof element !== 'object') return [];
  return [element, ...React.Children.toArray(element.props?.children).flatMap(children)];
}

test('фон и текстура в 16:9 покрывают весь кадр, в том числе фон сцены при переходах', () => {
  const state = { frame: 0 };
  const { MotionDirector } = loadMotion('src/MotionDirector.jsx', { ...config(1920, 1080), useCurrentFrame: () => state.frame });
  const card = (start, end, extra = {}) => ({ scene: 'card', title: `Сцена ${start}`, start, end, ...extra });
  const output = { aspect: 'horizontal', width: 1920, height: 1080, fps: 30, durationInFrames: 720 };
  for (const type of ['slide', 'wipe', 'push']) {
    const value = brief({ output, style: { texture: 'subtle' }, scenes: [card(0, 3), card(3, 6, { transition: { type } })] });
    const tree = MotionDirector(buildMotionProps({ brief: value }));
    // Корень и фон каждой сцены – AbsoluteFill без фиксированного размера: весь кадр 1920×1080.
    assert.equal(tree.props.style.width, undefined, type);
    // Фон сцены (SceneBackdrop) рисуется только в кадрах перехода: берём кадр внутри перехода
    // (последний у уходящей сцены, первый у входящей).
    const layers = children(tree).filter((el) => el.type?.name === 'SceneBackdrop');
    assert.equal(layers.length, 2, type);
    const backdrops = layers.map((el) => {
      state.frame = el.props.exitFrames > 0 ? el.props.durationInFrames - 1 : 0;
      return el.type(el.props);
    });
    state.frame = 0;
    backdrops.forEach((el) => assert.equal(el?.props?.['data-motion-scene-backdrop'], 'true', type));
    backdrops.forEach((el) => {
      assert.equal(el.type, tree.type, `${type}: фон сцены – AbsoluteFill`);
      assert.deepEqual([el.props.style.width, el.props.style.height], [undefined, undefined], type);
    });
    // Переход собран в TransitionSeries (slide, wipe и push работают в процентах кадра).
    const transition = children(tree).find((el) => el.props?.presentation && el.props?.timing);
    assert.ok(transition, type);
  }
  // Дрейф текстуры заполняет кадр (inset в процентах) и сдвигается в пикселях реального кадра.
  const { Drift } = loadMotion('src/details/Texture.jsx', config(1920, 1080));
  const drift = renderToStaticMarkup(React.createElement(Drift, { frame: 0 }));
  assert.match(drift, /data-texture-drift="true" style="position:absolute;inset:0/);
  assert.doesNotMatch(drift, /width:1080px|height:1920px/);
});
