const test = require('node:test');
const assert = require('node:assert/strict');
const { loadEsm } = require('./helpers/load-esm');
const { getProfile } = require('../scripts/qa/profiles');
const { gateAnchors, runTimelineGates } = require('../scripts/qa/timeline-gates');
const { momentsFromManifest } = require('../scripts/qa/key-moments');
const { manifestFixture } = require('./helpers/manifest-fixtures');

const kit = loadEsm('src/motion-kit/core.js');
const avatar = getProfile('avatar');
const cfg = { fps: 25, width: 1080, height: 1920, durationInFrames: 250, words: [], sfxLibrary: { sounds: {} } };
const face = { x: 540, y: 787 };
const box = { x: 100, y: 300, w: 400, h: 200 };
// Элемент без анимации входа и выхода: его габарит в любом кадре жизни равен box.
const still = (id, at, until, b = box) => ({ id, kind: 'text', at, until, box: b, enter: { kind: 'cut' }, exit: { frames: 0 }, props: {} });
const close = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const sameBox = (a, b) => ['x', 'y', 'w', 'h'].every((key) => close(a[key], b[key], 1e-3));
const plan = (extra = {}) => ({
  captions: false,
  camera: { face, shots: [{ at: 0, preset: 'W', drift: 'none' }] },
  items: [still('title-1', 1, 6)],
  inserts: [],
  ...extra,
});

test('morphRect: 0 – исходный бокс, 1 – полный, 0,5 – середина', () => {
  const full = { x: 0, y: 0, w: 1080, h: 1920 };
  assert.deepEqual(kit.morphRect(box, full, 0), box);
  assert.deepEqual(kit.morphRect(box, full, 1), full);
  assert.deepEqual(kit.morphRect(box, full, 0.5), { x: 50, y: 150, w: 740, h: 1060 });
});

test('вставка с origin открывается от бокса элемента и закрывается обратно в него', () => {
  const compiled = kit.compileLayer(plan({ inserts: [{ id: 'stock-1', kind: 'stock', from: 2, to: 4, src: 'stock/a.mp4', origin: 'title-1' }] }), cfg);
  const insert = compiled.inserts[0];
  assert.equal(insert.origin, 'title-1');
  const geo = { fps: 25, width: 1080, height: 1920 };
  assert.ok(sameBox(kit.insertRect(50, insert, geo), box), JSON.stringify(kit.insertRect(50, insert, geo)));
  // REVEAL_FRAMES = 9 при 25 fps: к кадру 59 карточка на весь кадр.
  assert.ok(sameBox(kit.insertRect(59, insert, geo), { x: 0, y: 0, w: 1080, h: 1920 }));
  const mid = kit.insertRect(54, insert, geo);
  assert.ok(mid.x > 0 && mid.x < box.x && mid.w > box.w && mid.w < 1080, JSON.stringify(mid));
  // Элемент ещё виден к началу закрытия (кадр 94) – последний кадр вставки снова его бокс.
  assert.ok(sameBox(kit.insertRect(99, insert, geo), box), JSON.stringify(kit.insertRect(99, insert, geo)));
  assert.equal(kit.insertRect(100, insert, geo), null);
});

test('без origin и при скрытом к закрытию элементе вставка ведёт себя как раньше (карточка safe-зоны)', () => {
  const safe = kit.safeRect(1080, 1920);
  const card = { x: safe.left, y: safe.top, w: safe.right - safe.left, h: safe.bottom - safe.top };
  const geo = { fps: 25, width: 1080, height: 1920 };
  const plain = kit.compileLayer(plan({ inserts: [{ id: 'stock-1', kind: 'stock', from: 2, to: 4, src: 'stock/a.mp4' }] }), cfg).inserts[0];
  assert.equal(plain.origin, null);
  assert.ok(sameBox(kit.insertRect(50, plain, geo), card));
  assert.ok(sameBox(kit.insertRect(99, plain, geo), card));
  // Элемент уходит в 3,5 с (кадр 87), закрытие начинается на 94: закрываемся в карточку, а не в бокс.
  const early = kit.compileLayer(plan({
    items: [still('title-1', 1, 3.5)],
    inserts: [{ id: 'stock-1', kind: 'stock', from: 2, to: 4, src: 'stock/a.mp4', origin: 'title-1' }],
  }), cfg).inserts[0];
  assert.ok(sameBox(kit.insertRect(50, early, geo), box));
  assert.ok(sameBox(kit.insertRect(99, early, geo), card));
});

test('несуществующий origin – ошибка компиляции с id; origin не строка – тоже ошибка', () => {
  assert.throws(
    () => kit.compileLayer(plan({ inserts: [{ id: 'stock-1', kind: 'stock', from: 2, to: 4, origin: 'title-9' }] }), cfg),
    /inserts\[0\] \(stock-1\): origin «title-9»/,
  );
  assert.throws(() => kit.compileInserts([{ id: 'x', kind: 'stock', from: 2, to: 4, origin: 7 }], { fps: 25 }), /origin/);
});

test('origin, скрытый к началу вставки: рендер берёт карточку safe-зоны, гейт G16 даёт ❌ с id', () => {
  const compiled = kit.compileLayer(plan({
    items: [still('gone', 0.2, 1)],
    inserts: [{ id: 'stock-1', kind: 'stock', from: 2, to: 4, src: 'stock/a.mp4', origin: 'gone' }],
  }), cfg);
  const safe = kit.safeRect(1080, 1920);
  const rect = kit.insertRect(50, compiled.inserts[0], { fps: 25, width: 1080, height: 1920 });
  assert.ok(sameBox(rect, { x: safe.left, y: safe.top, w: safe.right - safe.left, h: safe.bottom - safe.top }));
  const manifest = kit.buildManifest(compiled);
  assert.equal(manifest.inserts[0].origin, 'gone');
  assert.equal(manifest.inserts[0].originBox, null);
  const g = gateAnchors(manifest);
  assert.equal(g.id, 'G16');
  assert.equal(g.status, 'fail');
  assert.match(g.spans[0].note, /stock-1/);
  assert.match(g.spans[0].note, /gone/);
  assert.equal(runTimelineGates(manifest, avatar).find((x) => x.id === 'G16').status, 'fail');
});

test('видимые origin и target – G16 проходит; манифест хранит бокс origin и наезды камеры', () => {
  const compiled = kit.compileLayer(plan({
    camera: { face, maxScale: 1.4, shots: [{ at: 0, preset: 'W', drift: 'none' }], pushes: [{ at: 5, target: 'title-1' }] },
    inserts: [{ id: 'stock-1', kind: 'stock', from: 2, to: 4, src: 'stock/a.mp4', origin: 'title-1' }],
  }), cfg);
  const manifest = kit.buildManifest(compiled);
  assert.deepEqual(manifest.inserts[0].originBox, [100, 300, 500, 500]);
  assert.deepEqual(manifest.camera.pushes, [{ target: 'title-1', from: 125, to: 250, frames: 12, k: 1.35, box: [100, 300, 500, 500] }]);
  assert.equal(gateAnchors(manifest).status, 'pass');
  // Старый манифест без полей origin/pushes – тоже pass.
  assert.equal(gateAnchors(manifestFixture()).status, 'pass');
});

test('pushCenter у элемента в правом верхнем углу ограничен так, что кадр не выходит за исходник', () => {
  const c = kit.pushCenter({ x: 900, y: 100, w: 150, h: 100 }, { width: 1080, height: 1920, k: 1.35 });
  assert.ok(close(c.cx, 1080 - 1080 / 2.7), JSON.stringify(c));
  assert.ok(close(c.cy, 1920 / 2.7), JSON.stringify(c));
  const inside = kit.pushCenter({ x: 440, y: 860, w: 200, h: 200 }, { width: 1080, height: 1920, k: 1.35 });
  assert.deepEqual(inside, { cx: 540, cy: 960 });
});

// Видимое окно исходника при камере (s, dx, dy): точка экрана p показывает точку исходника
// face + (p − face − d) / s (speakerTransform: translate(d) scale(s) от face).
const windowOf = (c) => {
  const left = face.x + (0 - face.x - c.dx) / c.s;
  const top = face.y + (0 - face.y - c.dy) / c.s;
  return { left, top, right: left + 1080 / c.s, bottom: top + 1920 / c.s };
};

test('cameraAt: в середине наезда масштаб между 1 и k, после – k с центром на элементе, кадр не выходит за исходник', () => {
  const compiled = kit.compileLayer(plan({
    camera: { face, maxScale: 1.4, shots: [{ at: 0, preset: 'W', drift: 'none' }, { at: 8, preset: 'M' }], pushes: [{ at: 2, target: 'title-1', k: 1.35 }] },
  }), cfg);
  const track = compiled.camera;
  assert.ok(close(kit.cameraAt(track, 50).s, 1));
  const mid = kit.cameraAt(track, 56);
  assert.ok(mid.s > 1 && mid.s < 1.35, `mid ${mid.s}`);
  for (const frame of [62, 100, 199]) assert.ok(close(kit.cameraAt(track, frame).s, 1.35), `frame ${frame}`);
  const target = kit.pushCenter(box, { width: 1080, height: 1920, k: 1.35 });
  const held = windowOf(kit.cameraAt(track, 100));
  assert.ok(close((held.left + held.right) / 2, target.cx, 1e-3) && close((held.top + held.bottom) / 2, target.cy, 1e-3), JSON.stringify(held));
  for (let frame = 50; frame <= 70; frame += 1) {
    const w = windowOf(kit.cameraAt(track, frame));
    assert.ok(w.left >= -1e-6 && w.top >= -1e-6 && w.right <= 1080 + 1e-6 && w.bottom <= 1920 + 1e-6, `frame ${frame}: ${JSON.stringify(w)}`);
  }
  // Следующий план (8 с) снимает наезд: камера та же, что без него.
  const plain = kit.compileLayer(plan({ camera: { face, maxScale: 1.4, shots: [{ at: 0, preset: 'W', drift: 'none' }, { at: 8, preset: 'M' }] } }), cfg).camera;
  assert.deepEqual(kit.cameraAt(track, 200), kit.cameraAt(plain, 200));
  assert.deepEqual(kit.cameraAt(track, 49), kit.cameraAt(plain, 49));
});

test('наезд держится до ближайшего панча', () => {
  const track = kit.compileLayer(plan({
    camera: { face, maxScale: 1.4, shots: [{ at: 0, preset: 'W', drift: 'none' }], punches: [{ at: 4, until: 4.5 }], pushes: [{ at: 2, target: 'title-1' }] },
  }), cfg).camera;
  assert.equal(track.pushes[0].until, 100);
  assert.ok(close(kit.cameraAt(track, 99).s, 1.35));
  assert.ok(kit.cameraAt(track, 100).s < 1.3);
});

const centerOf = (w) => ({ x: (w.left + w.right) / 2, y: (w.top + w.bottom) / 2 });

test('наезд за наездом: на границе второго наезда нет скачка масштаба и центра', () => {
  const a = { x: 100, y: 500, w: 300, h: 200 };
  const b = { x: 650, y: 1200, w: 300, h: 200 };
  const track = kit.compileLayer(plan({
    items: [still('a', 1, 9, a), still('b', 1, 9, b)],
    camera: { face, maxScale: 1.4, shots: [{ at: 0, preset: 'W', drift: 'none' }], pushes: [{ at: 2, target: 'a', k: 1.25 }, { at: 4, target: 'b', k: 1.35 }] },
  }), cfg).camera;
  for (let frame = 95; frame < 120; frame += 1) {
    const prev = kit.cameraAt(track, frame);
    const next = kit.cameraAt(track, frame + 1);
    const p = centerOf(windowOf(prev));
    const n = centerOf(windowOf(next));
    const limit = frame + 1 === 100 ? 1e-6 : 0.03;
    assert.ok(Math.abs(next.s - prev.s) <= limit, `кадр ${frame}→${frame + 1}: s ${prev.s} → ${next.s}`);
    if (frame + 1 === 100) assert.ok(Math.hypot(n.x - p.x, n.y - p.y) < 1, `скачок центра ${JSON.stringify(p)} → ${JSON.stringify(n)}`);
  }
  assert.ok(close(kit.cameraAt(track, 99).s, 1.25));
  assert.ok(close(kit.cameraAt(track, 130).s, 1.35));
});

// Экранная точка p при камере c показывает точку исходника face + (p − face − d) / s; обратно –
// точка исходника q видна на экране в face + (q − face) · s + d.
const toSource = (p, c) => ({ x: face.x + (p.x - face.x - c.dx) / c.s, y: face.y + (p.y - face.y - c.dy) / c.s });
const toScreen = (q, c) => ({ x: face.x + (q.x - face.x) * c.s + c.dx, y: face.y + (q.y - face.y) * c.s + c.dy });

for (const preset of ['M', 'top']) {
  test(`наезд на плане ${preset}: в конце наезда под центром кадра то, что было под центром элемента`, () => {
    const el = { x: 340, y: preset === 'top' ? 1150 : 700, w: 400, h: 300 };
    const track = kit.compileLayer(plan({
      items: [still('el', 1, 9, el)],
      camera: { face, maxScale: 1.4, shots: [{ at: 0, preset, drift: 'none' }], pushes: [{ at: 2, target: 'el', k: 1.35 }] },
    }), cfg).camera;
    const start = kit.cameraAt(track, 50);
    const src = toSource({ x: el.x + el.w / 2, y: el.y + el.h / 2 }, start);
    const end = kit.cameraAt(track, 62);
    const seen = toScreen(src, end);
    assert.ok(Math.hypot(seen.x - 540, seen.y - 960) < 1, `${preset}: ${JSON.stringify(seen)}`);
    const w = windowOf(end);
    assert.ok(w.left >= -1e-6 && w.top >= -1e-6 && w.right <= 1080 + 1e-6 && w.bottom <= 1920 + 1e-6, JSON.stringify(w));
  });
}

test('наезд на плане top к элементу у верхнего края: окно у края исходника, точка элемента максимально близко к центру', () => {
  const el = { x: 340, y: 700, w: 400, h: 300 };
  const track = kit.compileLayer(plan({
    items: [still('el', 1, 9, el)],
    camera: { face, maxScale: 1.4, shots: [{ at: 0, preset: 'top', drift: 'none' }], pushes: [{ at: 2, target: 'el', k: 1.35 }] },
  }), cfg).camera;
  const src = toSource({ x: 540, y: 850 }, kit.cameraAt(track, 50));
  const w = windowOf(kit.cameraAt(track, 62));
  assert.ok(src.y < 1920 / 2.7, `точка ${src.y} должна требовать клэмпа`);
  assert.ok(close(w.top, 0, 1e-3), JSON.stringify(w));
  assert.ok(w.left >= -1e-6 && w.right <= 1080 + 1e-6 && w.bottom <= 1920 + 1e-6, JSON.stringify(w));
});

test('план, панч или наезд раньше конца наезда – ошибка компиляции с id; ровно в конце – можно', () => {
  const base = { face, maxScale: 1.4, shots: [{ at: 0, preset: 'W' }] };
  const two = [still('title-1', 1, 6), still('b', 1, 6, { x: 600, y: 900, w: 200, h: 200 })];
  // Наезд 2 с, 12 кадров: конец – кадр 62 (2,48 с).
  assert.throws(() => kit.compileLayer(plan({ camera: { ...base, shots: [...base.shots, { at: 2.2, preset: 'M' }], pushes: [{ at: 2, target: 'title-1' }] } }), cfg),
    /camera\.pushes\[0\] \(title-1\): .*план/);
  assert.throws(() => kit.compileLayer(plan({ camera: { ...base, punches: [{ at: 2.2, until: 2.6 }], pushes: [{ at: 2, target: 'title-1' }] } }), cfg),
    /camera\.pushes\[0\] \(title-1\): .*панч/);
  assert.throws(() => kit.compileLayer(plan({ items: two, camera: { ...base, pushes: [{ at: 2, target: 'title-1' }, { at: 2.2, target: 'b' }] } }), cfg),
    /camera\.pushes\[0\] \(title-1\): .*наезд/);
  const ok = kit.compileLayer(plan({ items: two, camera: {
    // Наезд b (2,48 с) кончается в 2,96 с – ровно там панч, план после.
    ...base, shots: [...base.shots, { at: 3.2, preset: 'M' }], punches: [{ at: 2.96, until: 3.1 }], pushes: [{ at: 2, target: 'title-1' }, { at: 2.48, target: 'b' }],
  } }), cfg).camera;
  assert.equal(ok.pushes.length, 2);
});

test('k больше maxScale – ошибка; без k наезд не крупнее maxScale; неизвестный target – ошибка с id', () => {
  assert.throws(
    () => kit.compileLayer(plan({ camera: { face, shots: [{ at: 0, preset: 'W' }], pushes: [{ at: 2, target: 'title-1', k: 1.35 }] } }), cfg),
    /camera\.pushes\[0\].*maxScale/,
  );
  const track = kit.compileLayer(plan({ camera: { face, shots: [{ at: 0, preset: 'W' }], pushes: [{ at: 2, target: 'title-1' }] } }), cfg).camera;
  assert.equal(track.pushes[0].k, 1.25);
  assert.throws(
    () => kit.compileLayer(plan({ camera: { face, maxScale: 1.4, shots: [{ at: 0, preset: 'W' }], pushes: [{ at: 2, target: 'title-9' }] } }), cfg),
    /camera\.pushes\[0\]: target «title-9»/,
  );
  assert.throws(() => kit.compileCamera({ face, shots: [{ at: 0, preset: 'W' }], pushes: [{ at: 2 }] }, cfg), /camera\.pushes\[0\]/);
  assert.throws(() => kit.compileCamera({ face, shots: [{ at: 0, preset: 'W' }], pushes: [{ at: 2, target: 'a', k: 0.9 }] }, cfg), /camera\.pushes\[0\]/);
});

test('target, скрытый к началу наезда: наезд пропускается, G16 даёт ❌ с id', () => {
  const camera = { face, maxScale: 1.4, shots: [{ at: 0, preset: 'W', drift: 'none' }] };
  const compiled = kit.compileLayer(plan({ items: [still('gone', 0.2, 1)], camera: { ...camera, pushes: [{ at: 2, target: 'gone' }] } }), cfg);
  const plain = kit.compileLayer(plan({ items: [still('gone', 0.2, 1)], camera }), cfg);
  for (const frame of [50, 60, 120]) assert.deepEqual(kit.cameraAt(compiled.camera, frame), kit.cameraAt(plain.camera, frame));
  const g = gateAnchors(kit.buildManifest(compiled));
  assert.equal(g.status, 'fail');
  assert.match(g.spans[0].note, /gone/);
});

test('наезд пересчитывается под fps: 12 кадров при 25 fps – 24 при 50', () => {
  const track = kit.compileLayer(plan({ camera: { face, maxScale: 1.4, shots: [{ at: 0, preset: 'W' }], pushes: [{ at: 2, target: 'title-1' }] } }),
    { ...cfg, fps: 50, durationInFrames: 500 }).camera;
  assert.equal(track.pushes[0].frames, 24);
});

test('лист ключевых моментов получает момент наезда', () => {
  const compiled = kit.compileLayer(plan({
    camera: { face, maxScale: 1.4, shots: [{ at: 0, preset: 'W', drift: 'none' }], pushes: [{ at: 5, target: 'title-1' }] },
  }), cfg);
  const moments = momentsFromManifest(kit.buildManifest(compiled));
  const push = moments.find((m) => m.label === 'title-1: наезд');
  assert.ok(push, JSON.stringify(moments));
  assert.equal(push.timeSec, 5.48);
});

test('цепочка удерживаемых наездов считается за линейное время, значения не зависят от порядка кадров', () => {
  const count = 20;
  const long = { ...cfg, durationInFrames: 25 * (count + 3) };
  const items = Array.from({ length: count }, (_, i) => still(`el-${i}`, 0.5, count + 2,
    { x: 100 + (i % 4) * 150, y: 300 + (i % 5) * 250, w: 300, h: 200 }));
  const pushes = items.map((item, i) => ({ at: i + 1, target: item.id, k: i % 2 ? 1.35 : 1.25 }));
  const camera = { face, maxScale: 1.4, shots: [{ at: 0, preset: 'W', drift: 'none' }], pushes };
  const track = kit.compileLayer(plan({ items, camera }), long).camera;
  assert.equal(track.pushes.length, count);
  const last = long.durationInFrames - 1;
  const started = Date.now();
  const end = kit.cameraAt(track, last);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 200, `cameraAt на ${count} наездах: ${elapsed} мс`);
  assert.ok(close(end.s, pushes[count - 1].k));
  // Свежая копия трека (свой кэш) в обратном порядке кадров даёт те же значения.
  const forward = [];
  for (let frame = 0; frame <= last; frame += 7) forward.push(kit.cameraAt(track, frame));
  const copy = { ...track };
  const backward = [];
  for (let frame = Math.floor(last / 7) * 7; frame >= 0; frame -= 7) backward.unshift(kit.cameraAt(copy, frame));
  assert.deepEqual(backward, forward);
});

// Настоящий рендер шаблона слоя (опт-ин): сток вырастает из карточки screenshot, кадр в середине
// морфа не пустой (G12) и вставка уже на экране.
test('реальный кадр середины морфа вставки из элемента не пустой', {
  skip: process.env.AUTOMONTAGE_TEST_MOTION_RENDER !== '1', timeout: 300_000,
}, async (t) => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { bundle } = require('@remotion/bundler');
  const { openBrowser, renderStill, selectComposition } = require('@remotion/renderer');
  const { withMotionKitAlias } = require('../scripts/remotion-webpack');
  const { makeLayerProject } = require('./helpers/layer-project');
  const { frameEdgeShare } = require('../scripts/layer/sheet');
  const { SHARE_THRESHOLD } = require('../scripts/qa/empty-frame-gate');
  const newLayer = require('../scripts/layer/new');

  const { root, projectDir, sfxDir } = makeLayerProject(t, { seconds: 10, size: '1080x1920' });
  const previousSfxDir = process.env.AUTOMONTAGE_SFX_DIR;
  process.env.AUTOMONTAGE_SFX_DIR = sfxDir;
  t.after(() => {
    if (previousSfxDir === undefined) delete process.env.AUTOMONTAGE_SFX_DIR;
    else process.env.AUTOMONTAGE_SFX_DIR = previousSfxDir;
  });
  assert.equal(await newLayer.run({ 'project-dir': projectDir }), 0);
  const layerDir = path.join(projectDir, 'motion-v01');
  // Карточка screenshot живёт до конца стока, а сток растёт из неё.
  const planPath = path.join(layerDir, 'src', 'plan.js');
  const source = fs.readFileSync(planPath, 'utf8');
  const patched = source
    .replace("src: 'stock/placeholder.mp4',", "src: 'stock/placeholder.mp4', origin: 'screenshot',")
    .replace('const shotUntil = hasStock ? Math.min(shotAt + 2.6, stockAt - 0.2) : shotAt + 2.6;', 'const shotUntil = stockAt + 2;');
  assert.notEqual(patched, source);
  fs.writeFileSync(planPath, patched);

  const serveUrl = await bundle({
    entryPoint: path.join(layerDir, 'src', 'index.jsx'), publicDir: path.join(layerDir, 'public'),
    outDir: path.join(root, 'bundle'), webpackOverride: (config) => withMotionKitAlias(config),
  });
  const browser = await openBrowser('chrome', { logLevel: 'error' });
  t.after(() => browser.close({ silent: true }));
  const composition = await selectComposition({ serveUrl, id: 'Layer', puppeteerInstance: browser });
  // Сток шаблона начинается в 6 с (кадр 150); середина морфа (9 кадров) – кадр 154.
  const output = path.join(layerDir, 'out', 'morph-mid.png');
  await renderStill({ serveUrl, composition, frame: 154, output, puppeteerInstance: browser, onBrowserLog: () => {}, overwrite: true });
  const share = frameEdgeShare(output, null);
  assert.ok(Number.isFinite(share) && share > SHARE_THRESHOLD, `G12 edgeShare ${share}`);
});
