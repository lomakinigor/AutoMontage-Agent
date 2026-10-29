const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { loadMotion, brief } = require('./helpers/motion-render');
const { validateMotionBrief } = require('../scripts/motion/brief');

const ROOT = path.join(__dirname, '..');
const GRAIN = path.join(ROOT, 'public/textures/grain-256.png');
const math = () => loadMotion('src/details/texture.js');
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('grainOffset is static by default: one deterministic offset for every frame, seed changes it', () => {
  const { grainOffset } = math();
  // Зерно, меняющееся раз в 2 кадра, – полнокадровый шум: h264 его не сжимает (78–136 МБ на 27 с).
  for (const frame of [0, 1, 2, 10, 11, 12, 40, 899]) assert.deepEqual(grainOffset(frame), grainOffset(0), `кадр ${frame}`);
  assert.deepEqual(grainOffset(40), math().grainOffset(40));
  const { x, y } = grainOffset(10);
  assert.ok(Number.isInteger(x) && Number.isInteger(y) && x >= 0 && x < 256 && y >= 0 && y < 256);
  assert.notDeepEqual(grainOffset(10, { seed: 8 }), grainOffset(10));
});

test('grainOffset animated: true is an explicit opt-in that keeps the old 2-frame step', () => {
  const { grainOffset } = math();
  const animated = { animated: true };
  assert.deepEqual(grainOffset(10, animated), grainOffset(11, animated));
  assert.notDeepEqual(grainOffset(10, animated), grainOffset(12, animated));
  assert.deepEqual(grainOffset(0, animated), grainOffset(0));
});

test('isDarkBackground: relative luminance < 0.4 for #rgb, #rrggbb and rgb()', () => {
  const { isDarkBackground } = math();
  const { motionTheme } = loadMotion('src/motion/motion-theme.js');
  assert.equal(isDarkBackground(motionTheme.background), false, 'светлая тема motion-neutral');
  for (const dark of ['#000', '#111111', '#202A36', 'rgb(20, 30, 40)', 'rgba(0,0,0,1)', '#335E99', '#777777']) {
    assert.equal(isDarkBackground(dark), true, dark);
  }
  for (const light of ['#fff', '#EDF0F4', '#FFFFFF', 'rgb(237, 240, 244)', '#BBBBBB']) {
    assert.equal(isDarkBackground(light), false, light);
  }
  // #AAAAAA: L ≈ 0.402 – уже светлый; #A9A9A9: L ≈ 0.397 – ещё тёмный (порог 0.4).
  assert.equal(isDarkBackground('#AAAAAA'), false);
  assert.equal(isDarkBackground('#A9A9A9'), true);
  for (const bad of [undefined, null, '', 'navy', '#12', 'linear-gradient(#000, #000)']) {
    assert.equal(isDarkBackground(bad), false, String(bad));
  }
});

test('driftAt loops after 8 seconds and never exceeds the amplitude', () => {
  const { driftAt } = math();
  for (const fps of [25, 30]) {
    const a = driftAt(0, fps);
    const b = driftAt(8 * fps, fps);
    assert.ok(Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9);
    for (let frame = 0; frame < 20 * fps; frame += 1) {
      const d = driftAt(frame, fps);
      assert.ok(Math.abs(d.x) <= 0.06 + 1e-12 && Math.abs(d.y) <= 0.06 + 1e-12);
    }
  }
  assert.ok(Math.abs(driftAt(2 * 25, 25).x) > 0.01);
});

test('sheenProgress is null outside one 12-frame pass at 25 fps and scales with fps', () => {
  const { sheenProgress } = math();
  assert.equal(sheenProgress(4, 25, 5), null);
  assert.equal(sheenProgress(5 + 12, 25, 5), null);
  assert.equal(sheenProgress(5, 25, 5), 0);
  const mid = sheenProgress(11, 25, 5);
  assert.ok(mid > 0 && mid < 1);
  assert.notEqual(sheenProgress(5 + 13, 30, 5), null);
  assert.equal(sheenProgress(5 + 14, 30, 5), null);
});

test('gen-grain is deterministic and the tracked tile matches the generator', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grain-'));
  try {
    const a = path.join(dir, 'a.png');
    const b = path.join(dir, 'b.png');
    execFileSync(process.execPath, [path.join(ROOT, 'scripts/gen-grain.js'), a]);
    execFileSync(process.execPath, [path.join(ROOT, 'scripts/gen-grain.js'), b]);
    assert.equal(sha(a), sha(b));
    assert.equal(sha(a), sha(GRAIN));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function decodeGray(file) {
  const png = fs.readFileSync(file);
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  assert.deepEqual([width, height, png[24], png[25]], [256, 256, 8, 0]);
  let offset = 8;
  const idat = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    if (png.subarray(offset + 4, offset + 8).toString() === 'IDAT') idat.push(png.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const pixels = [];
  for (let row = 0; row < height; row += 1) {
    assert.equal(raw[row * (width + 1)], 0);
    for (let col = 0; col < width; col += 1) pixels.push(raw[row * (width + 1) + 1 + col]);
  }
  return pixels;
}

const luminance = (rgb) => {
  const lin = rgb.map((c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
};
const hex = (value) => [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16));
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test('grain at 0.06 keeps ink contrast above 4.5 on the panel and on the light background (worst tile pixel)', () => {
  const { motionTheme } = loadMotion('src/motion/motion-theme.js');
  const { GRAIN_OPACITY } = math();
  assert.ok(GRAIN_OPACITY <= 0.06);
  const pixels = decodeGray(GRAIN);
  const levels = [Math.min(...pixels), Math.max(...pixels)];
  for (const base of [motionTheme.panel, motionTheme.background]) {
    for (const level of levels) {
      const mixed = hex(base).map((c) => c * (1 - GRAIN_OPACITY) + level * GRAIN_OPACITY);
      assert.ok(contrast(hex(motionTheme.ink), mixed) >= 4.5, `${base} with grain ${level}`);
    }
  }
});

const render = (props, overrides) => {
  const { MotionDirector } = loadMotion('src/MotionDirector.jsx', overrides);
  return renderToStaticMarkup(React.createElement(MotionDirector, props));
};
const cardScene = { scene: 'card', title: 'Заголовок', body: 'Текст', start: 0, end: 3 };

test('brief schema: style.texture is optional none|subtle', () => {
  const base = brief({ scenes: [cardScene] });
  assert.equal(validateMotionBrief(base).ok, true);
  assert.equal(validateMotionBrief({ ...base, style: { texture: 'subtle' } }).ok, true);
  assert.equal(validateMotionBrief({ ...base, style: { texture: 'none' } }).ok, true);
  assert.equal(validateMotionBrief({ ...base, style: {} }).ok, true);
  assert.equal(validateMotionBrief({ ...base, style: { texture: 'heavy' } }).ok, false);
  assert.equal(validateMotionBrief({ ...base, style: { texture: 'subtle', extra: 1 } }).ok, false);
});

test('without style.texture there is no Grain, Drift or Sheen', () => {
  for (const props of [{ scenes: [cardScene] }, { scenes: [cardScene], style: { texture: 'none' } }]) {
    assert.doesNotMatch(render(props), /data-texture-/);
    assert.doesNotMatch(render(props, { useCurrentFrame: () => 4 }), /data-texture-/);
  }
});

test('subtle on the light theme: Drift under the scene container and no Grain', () => {
  const html = render({ scenes: [cardScene], style: { texture: 'subtle' } });
  const drift = html.indexOf('data-texture-drift');
  const scene = html.indexOf('data-motion-safe');
  assert.ok(drift >= 0 && scene > drift);
  assert.doesNotMatch(html, /data-texture-grain/, 'на светлом фоне зерна нет');
  assert.doesNotMatch(html, /grain-256\.png/);
});

test('textureLayers: Grain goes after Drift only on a dark background, nothing without subtle', () => {
  const { textureLayers } = loadMotion('src/MotionDirector.jsx');
  const html = (props) => renderToStaticMarkup(React.createElement(React.Fragment, null, textureLayers(props)));
  const dark = html({ texture: 'subtle', background: '#14181F' });
  const drift = dark.indexOf('data-texture-drift');
  const grain = dark.indexOf('data-texture-grain');
  assert.ok(drift >= 0 && grain > drift);
  assert.match(dark, /url\(data:image\/png;base64,/);
  assert.doesNotMatch(html({ texture: 'subtle', background: '#EDF0F4' }), /data-texture-grain/);
  assert.match(html({ texture: 'subtle', background: '#EDF0F4' }), /data-texture-drift/);
  assert.equal(html({ texture: 'none', background: '#14181F' }), '');
  // Фон сцены в режиме переходов передаёт глобальный кадр обоим слоям.
  const layers = textureLayers({ texture: 'subtle', background: '#14181F', frame: 117 }).props.children.filter(Boolean);
  assert.deepEqual(layers.map((el) => [el.type.name, el.props.frame]), [['Drift', 117], ['Grain', 117]]);
});

test('Sheen appears on a card entry only when texture is subtle', () => {
  const entering = { useCurrentFrame: () => 4 };
  assert.match(render({ scenes: [cardScene], style: { texture: 'subtle' } }, entering), /data-texture-sheen/);
  assert.doesNotMatch(render({ scenes: [cardScene] }, entering), /data-texture-sheen/);
  assert.doesNotMatch(render({ scenes: [cardScene], style: { texture: 'subtle' } }), /data-texture-sheen/);
});

test('Sheen colour contrasts with the panel and the cta sheen starts at the action entrance', () => {
  const sheenOf = (html) => /data-texture-sheen[\s\S]*?transparent 0%, ([^ ]+) 50%/.exec(html)?.[1];
  const { motionTheme, entranceDelay } = loadMotion('src/motion/motion-theme.js');
  const cardHtml = render({ scenes: [cardScene], style: { texture: 'subtle' } }, { useCurrentFrame: () => 4 });
  assert.ok(sheenOf(cardHtml));
  assert.notEqual(sheenOf(cardHtml).toLowerCase(), motionTheme.panel.toLowerCase());
  const cta = { scene: 'cta', start: 0, end: 4, title: 'Заголовок', action: 'Действие' };
  const delay = Math.round(entranceDelay(30, 120, 1, 2));
  assert.ok(delay > 0);
  const at = (frame) => render({ scenes: [cta], style: { texture: 'subtle' } }, { useCurrentFrame: () => frame });
  assert.doesNotMatch(at(delay - 1), /data-texture-sheen/);
  assert.match(at(delay + 2), /data-texture-sheen/);
});

test('motion-kit exports the texture parts', () => {
  const kit = loadMotion('src/motion-kit/index.js');
  for (const name of ['Grain', 'Drift', 'Sheen', 'grainOffset', 'driftAt', 'sheenProgress', 'isDarkBackground']) assert.ok(kit[name], name);
});

test('Grain uses an inlined data URI byte-identical to the tracked PNG (isolated render public dir has no textures)', () => {
  const { Grain } = loadMotion('src/details/Texture.jsx');
  const html = renderToStaticMarkup(React.createElement(Grain));
  const uri = /url\((data:image\/png;base64,[A-Za-z0-9+/=]+)\)/.exec(html);
  assert.ok(uri, 'grain background is a data URI');
  const bytes = Buffer.from(uri[1].split(',')[1], 'base64');
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), sha(GRAIN));
  const { GRAIN_DATA_URI } = loadMotion('src/details/grain-data.js');
  assert.equal(GRAIN_DATA_URI, uri[1]);
});

test('gen-grain rerun keeps the PNG and the generated module identical', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grain-'));
  try {
    const run = (n) => {
      const png = path.join(dir, `${n}.png`);
      const mod = path.join(dir, `${n}.js`);
      execFileSync(process.execPath, [path.join(ROOT, 'scripts/gen-grain.js'), png, mod]);
      return [fs.readFileSync(png), fs.readFileSync(mod)];
    };
    const [pngA, modA] = run('a');
    const [pngB, modB] = run('b');
    assert.ok(pngA.equals(pngB) && modA.equals(modB));
    assert.ok(modA.equals(fs.readFileSync(path.join(ROOT, 'src/details/grain-data.js'))));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('muted, ink and accent text stay >= 4.5 over the worst Drift blend plus worst grain pixel', () => {
  const { motionTheme } = loadMotion('src/motion/motion-theme.js');
  const { DRIFT_COLOR_KEYS, DRIFT_OPACITY, GRAIN_OPACITY } = math();
  const pixels = decodeGray(GRAIN);
  const levels = [Math.min(...pixels), Math.max(...pixels)];
  const mix = (base, color) => base.map((c, i) => c * (1 - DRIFT_OPACITY) + color[i] * DRIFT_OPACITY);
  const [first, second] = DRIFT_COLOR_KEYS.map((key) => hex(motionTheme[key]));
  const bg = hex(motionTheme.background);
  const blends = [mix(bg, first), mix(bg, second), mix(mix(bg, first), second)];
  for (const blend of blends) for (const level of levels) {
    const pixel = blend.map((c) => c * (1 - GRAIN_OPACITY) + level * GRAIN_OPACITY);
    for (const name of ['muted', 'ink', 'accent']) {
      assert.ok(contrast(hex(motionTheme[name]), pixel) >= 4.5, `${name} over ${blend} grain ${level}`);
    }
  }
});

// Тег карточки (Panel) – первый div с рамкой и паддингом 38 внутри сцены.
const panelTag = (html) => {
  const at = html.indexOf('padding:38px');
  return html.slice(html.lastIndexOf('<', at), html.indexOf('>', at) + 1);
};
const sceneSlice = (html) => html.slice(html.indexOf('data-motion-safe'));
const at = (frame, fps, texture) => render({ scenes: [cardScene], ...(texture ? { style: { texture } } : {}) }, {
  useCurrentFrame: () => frame, useVideoConfig: () => ({ width: 1080, height: 1920, fps, durationInFrames: 630 }) });

test('Sheen during its pass sits under the card content without wrapping it', () => {
  const html = at(4, 25, 'subtle');
  assert.match(html, /data-texture-sheen/);
  assert.doesNotMatch(html, /data-panel-content/, 'контент карточки не оборачивается');
  assert.match(panelTag(html), /position:relative/);
  assert.match(panelTag(html), /isolation:isolate/, 'карточка – свой контекст наложения, блик не уходит под её фон');
  const sheen = html.indexOf('data-texture-sheen');
  const sheenTag = html.slice(html.lastIndexOf('<', sheen), html.indexOf('>', sheen));
  assert.match(sheenTag, /z-index:-1/, 'блик под контентом карточки');
});

test('outside the Sheen pass the subtle card is the same DOM as texture none', () => {
  for (const [frame, fps] of [[12, 25], [40, 25], [89, 30], [24, 50]]) {
    const subtle = at(frame, fps, 'subtle');
    assert.doesNotMatch(subtle, /data-texture-sheen|data-panel-content|z-index|isolation/, `${frame}@${fps}`);
    assert.doesNotMatch(panelTag(subtle), /position:relative/, `${frame}@${fps}`);
    assert.equal(sceneSlice(subtle), sceneSlice(at(frame, fps)), `${frame}@${fps}: сцена как при none`);
  }
});

test('Sheen pass is 12 frames at 25 fps and the same 0.48 s at 50 fps (ref25)', () => {
  const has = (frame, fps) => /data-texture-sheen/.test(at(frame, fps, 'subtle'));
  assert.deepEqual([0, 11, 12].map((f) => has(f, 25)), [true, true, false]);
  assert.deepEqual([0, 23, 24].map((f) => has(f, 50)), [true, true, false]);
  const { sheenProgress } = math();
  const { ref25 } = loadMotion('src/motion-kit/time.js');
  for (const fps of [24, 25, 30, 50, 60]) {
    const frames = ref25(12, fps);
    assert.notEqual(sheenProgress(frames - 1, fps), null, `${fps}`);
    assert.equal(sheenProgress(frames, fps), null, `${fps}`);
  }
});

test('Panel keeps children at one tree position in and out of the Sheen pass (no remount)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-'));
  try {
    const entry = path.join(dir, 'entry.jsx');
    fs.writeFileSync(entry, `export { Panel } from ${JSON.stringify(path.join(ROOT, 'src/motion/parts.jsx'))};
export { TextureContext } from ${JSON.stringify(path.join(ROOT, 'src/details/Texture.jsx'))};\n`);
    const shape = (frame) => {
      const { Panel, TextureContext } = loadMotion(path.relative(ROOT, entry), { useCurrentFrame: () => frame,
        useVideoConfig: () => ({ width: 1080, height: 1920, fps: 25, durationInFrames: 100 }) });
      const marker = React.createElement('i', { 'data-marker': 'yes' });
      let element = null;
      // Panel вызывается как функция внутри компонента: его хуки – хуки обёртки, а результат виден целиком.
      const Probe = () => { element = Panel({ children: marker }); return element; };
      renderToStaticMarkup(React.createElement(TextureContext.Provider, { value: 'subtle' }, React.createElement(Probe)));
      const kids = [].concat(element.props.children);
      return { type: element.type, length: kids.length, index: kids.indexOf(marker) };
    };
    const inside = shape(3);
    const outside = shape(40);
    assert.ok(inside.index >= 0, 'children лежат прямо в карточке');
    assert.deepEqual(outside, inside, 'тип, число и место детей одинаковы в проходе и вне его');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Drift takes an explicit absolute frame: inside a scene it matches the root layer at the same composition frame', () => {
  const html = (frame, local, Component) => {
    const mod = loadMotion('src/details/Texture.jsx', { useCurrentFrame: () => local });
    return renderToStaticMarkup(React.createElement(mod[Component], frame === null ? {} : { frame }));
  };
  // Корень на кадре 117 и сцена 2 с локальным кадром 27 (начало sequence – 90) рисуют одно и то же.
  assert.equal(html(117, 27, 'Drift'), html(null, 117, 'Drift'));
  assert.notEqual(html(null, 27, 'Drift'), html(null, 117, 'Drift'), 'Drift: кадр меняет слой');
  // Зерно неподвижно: любой кадр даёт один и тот же слой.
  assert.equal(html(117, 27, 'Grain'), html(null, 117, 'Grain'));
  assert.equal(html(null, 27, 'Grain'), html(null, 117, 'Grain'), 'Grain: кадр не меняет слой');
});

// Настоящий рендер: зерно на тёмном фоне неподвижно – кадры 10 и 40 побайтно совпадают и при этом
// отличаются от того же фона без зерна (зерно действительно нарисовано).
const GRAIN_FIXTURE = `
import { AbsoluteFill, Composition, registerRoot } from 'remotion';
import { Grain } from '@automontage/motion-kit';

function Layer({ grain }) {
  return <AbsoluteFill style={{ backgroundColor: '#14181F' }}>{grain && <Grain />}</AbsoluteFill>;
}

registerRoot(() => (
  <Composition id="Layer" component={Layer} defaultProps={{ grain: true }} durationInFrames={60} fps={30} width={540} height={960} />
));
`;

test('real render: Grain on a dark background is static between frames 10 and 40', {
  skip: process.env.AUTOMONTAGE_TEST_MOTION_RENDER !== '1', timeout: 180_000,
}, async (t) => {
  const { bundle } = require('@remotion/bundler');
  const { openBrowser, renderStill, selectComposition } = require('@remotion/renderer');
  const { withMotionKitAlias } = require('../scripts/remotion-webpack');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'grain-static-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  fs.mkdirSync(path.join(work, 'src'));
  const entryPoint = path.join(work, 'src/index.jsx');
  fs.writeFileSync(entryPoint, GRAIN_FIXTURE);
  const serveUrl = await bundle({ entryPoint, publicDir: path.join(ROOT, 'public'), outDir: path.join(work, 'bundle'), webpackOverride: withMotionKitAlias });
  const browser = await openBrowser('chrome', { logLevel: 'error' });
  t.after(() => browser.close({ silent: true }));
  const still = async (frame, grain) => {
    const inputProps = { grain };
    const composition = await selectComposition({ serveUrl, id: 'Layer', inputProps, puppeteerInstance: browser });
    const output = path.join(work, `frame-${frame}-${grain}.png`);
    await renderStill({ serveUrl, composition, frame, output, inputProps, imageFormat: 'png', puppeteerInstance: browser, logLevel: 'error' });
    return fs.readFileSync(output);
  };
  const [a, b, plain] = [await still(10, true), await still(40, true), await still(10, false)];
  assert.ok(a.equals(b), 'зерно не меняется между кадрами');
  assert.ok(!a.equals(plain), 'зерно нарисовано');
});

test('isDarkBackground: полупрозрачный rgba не считается тёмным, непрозрачный – по яркости', () => {
  const { isDarkBackground } = math();
  assert.equal(isDarkBackground('rgba(0,0,0,0.1)'), false);
  assert.equal(isDarkBackground('rgba(0, 0, 0, 1)'), true);
  assert.equal(isDarkBackground('rgba(255,255,255,1)'), false);
});

// Скорость: CSS radial-gradient на весь кадр Chrome растеризует заново на каждом снимке кадра
// (captureBeyondViewport), это давало +380 % ко времени рендера. Дрейф рисуется один раз в canvas
// и показывается картинкой <img>, по кадрам меняется только transform. Сам canvas в DOM не кладём:
// Chrome выносит его в слой, и текст над ним теряет субпиксельное сглаживание.
test('Drift – слой-картинка: по кадрам меняется только transform, остальное неизменно', () => {
  const tagAt = (frame) => {
    const { Drift } = loadMotion('src/details/Texture.jsx', { useCurrentFrame: () => frame });
    const html = renderToStaticMarkup(React.createElement(Drift));
    const tag = /<img[^>]*>/.exec(html)?.[0];
    assert.ok(tag, 'слой дрейфа – img');
    assert.doesNotMatch(html, /<canvas/, 'canvas не в DOM: иначе текст теряет субпиксельное сглаживание');
    assert.doesNotMatch(html, /radial-gradient/, 'CSS-градиент не растеризуется на каждом кадре');
    return tag;
  };
  const a = tagAt(10);
  const b = tagAt(47);
  assert.match(a, /transform:translate\(/);
  assert.doesNotMatch(a, /will-change/);
  assert.match(a, /opacity:0\.3/);
  assert.notEqual(a, b, 'дрейф движется');
  const still = (tag) => tag.replace(/transform:translate\([^)]*\)/, 'transform:X');
  assert.equal(still(a), still(b), 'кроме transform слой одинаков на разных кадрах');
});

test('paintDrift рисует те же два radial-gradient, что CSS-фон: порядок, центры, farthest-corner, стопы', () => {
  const { paintDrift } = math();
  const calls = [];
  const normalized = { '#DEE7F3': '#dee7f3', '#FFFFFF': '#ffffff' };
  const ctx = {
    fill: '#000000',
    set fillStyle(value) {
      calls.push(['fillStyle', typeof value === 'string' ? value : value.id]);
      if (typeof value === 'string') this.fill = normalized[value] ?? value;
    },
    get fillStyle() { return this.fill; },
    setTransform: (...args) => calls.push(['setTransform', ...args]),
    clearRect: (...args) => calls.push(['clearRect', ...args]),
    fillRect: (...args) => calls.push(['fillRect', ...args]),
    createRadialGradient: (...args) => {
      const id = `g${calls.filter((c) => c[0] === 'gradient').length}`;
      calls.push(['gradient', ...args.map((v) => Math.round(v * 1000) / 1000)]);
      return { id, addColorStop: (offset, color) => calls.push(['stop', id, offset, color]) };
    },
  };
  // Слой 100×200 CSS-пикселей, canvas вдвое плотнее (devicePixelRatio 2).
  paintDrift(ctx, { width: 100, height: 200, scale: 2, colors: ['#DEE7F3', '#FFFFFF'] });
  // farthest-corner: пятно (25 %, 20 %) – угол (100, 200), пятно (80 %, 85 %) – угол (0, 0).
  const round = (v) => Math.round(v * 1000) / 1000;
  const [r1, r2] = [round(Math.hypot(75, 160)), round(Math.hypot(80, 170))];
  const drawn = calls.filter((c) => ['setTransform', 'clearRect', 'gradient', 'stop', 'fillRect'].includes(c[0]));
  assert.deepEqual(drawn, [
    ['setTransform', 2, 0, 0, 2, 0, 0],
    ['clearRect', 0, 0, 100, 200],
    // В CSS первый фон лежит сверху, поэтому второе пятно рисуется первым.
    ['gradient', 80, 170, 0, 80, 170, r2],
    ['stop', 'g0', 0, 'rgba(255, 255, 255, 1)'],
    ['stop', 'g0', 0.5, 'rgba(255, 255, 255, 0)'],
    ['fillRect', 0, 0, 100, 200],
    ['gradient', 25, 40, 0, 25, 40, r1],
    ['stop', 'g1', 0, 'rgba(222, 231, 243, 1)'],
    ['stop', 'g1', 0.55, 'rgba(222, 231, 243, 0)'],
    ['fillRect', 0, 0, 100, 200],
  ]);
  // Полупрозрачный цвет: прозрачный конец того же цвета (как CSS transparent в premultiplied).
  calls.length = 0;
  paintDrift(ctx, { width: 100, height: 200, scale: 1, colors: ['rgba(1, 2, 3, 0.5)', '#FFFFFF'] });
  assert.deepEqual(calls.filter((c) => c[0] === 'stop' && c[1] === 'g1').map((c) => c.slice(2)),
    [[0, 'rgba(1, 2, 3, 0.5)'], [0.55, 'rgba(1, 2, 3, 0)']]);
});
