const test = require('node:test');
const assert = require('node:assert/strict');
const { manifestFixture } = require('./helpers/manifest-fixtures');
const { keyMoments, momentsFromBrief, momentsFromManifest } = require('../scripts/qa/key-moments');

const text = (id, from, length = 50) => ({ id, from, frames: Array.from({ length }, () => [0, 0, 10, 10]) });
const times = (moments) => moments.map((m) => m.timeSec);

test('манифест: событие текста через 0,3 с и удержание в середине показа', () => {
  const manifest = manifestFixture({ texts: [text('title-1', 25)] });
  const moments = momentsFromManifest(manifest, { durationSec: 10 });
  assert.deepEqual(moments.map((m) => [m.timeSec, m.kind, m.ref]), [[1.3, 'event', 'title-1'], [2, 'hold', 'title-1']]);
});

test('манифест: вставки и заметные звуки дают события, обычные звуки не учитываются', () => {
  const manifest = manifestFixture({
    inserts: [{ id: 'insert-1', kind: 'stock', from: 50, to: 100 }],
    cues: { kept: [{ id: 'cue-1', hitFrame: 125, notable: true }, { id: 'cue-2', hitFrame: 200, notable: false }], dropped: [] },
  });
  const moments = momentsFromManifest(manifest, { durationSec: 10 });
  assert.deepEqual(moments.map((m) => [m.timeSec, m.kind, m.ref]), [[2.3, 'event', 'insert-1'], [5, 'event', 'cue-1']]);
});

test('манифест: субтитры с полем until дают удержание по середине [from, until]', () => {
  const manifest = manifestFixture({ texts: [{ id: 'caption-1', from: 50, until: 150, static: [0, 0, 1, 1] }] });
  const moments = momentsFromManifest(manifest, { durationSec: 10 });
  assert.deepEqual(moments.map((m) => [m.timeSec, m.kind]), [[2.3, 'event'], [4, 'hold']]);
});

test('манифест: отрывок сдвигает моменты на fromSec и отбрасывает элементы вне отрывка', () => {
  const manifest = manifestFixture({ texts: [text('title-0', 0, 25), text('title-1', 50)] });
  const moments = momentsFromManifest(manifest, { fromSec: 1, durationSec: 10 });
  assert.deepEqual(moments.map((m) => [m.timeSec, m.ref]), [[1.3, 'title-1'], [2, 'title-1']]);
  const first = momentsFromManifest(manifestFixture({ texts: [text('title-1', 25)] }), { fromSec: 1, durationSec: 10 });
  assert.deepEqual(times(first), [0.3, 1]);
});

test('манифест: моменты за концом отрывка отбрасываются', () => {
  const manifest = manifestFixture({ texts: [text('title-1', 25)] });
  assert.deepEqual(times(momentsFromManifest(manifest, { durationSec: 1.5 })), [1.3]);
});

test('ТЗ: две сцены 0-3 и 3-6 дают события и удержания', () => {
  const brief = { scenes: [{ scene: 'text-only', start: 0, end: 3, quoteCream: 'Первая мысль' }, { scene: 'stat', start: 3, end: 6, statCream: '90', headCream: 'процентов' }] };
  const moments = momentsFromBrief(brief, { durationSec: 6 });
  assert.deepEqual(times(moments), [0.3, 1.5, 3.3, 4.5]);
  assert.deepEqual(moments.map((m) => m.kind), ['event', 'hold', 'event', 'hold']);
  assert.equal(moments[0].ref, 'scenes[0]');
  assert.equal(moments[2].ref, 'scenes[1]');
  assert.match(moments[0].label, /^text-only/);
  assert.ok(moments[0].label.includes('Первая мысль'));
});

test('ТЗ: подпись обрезает текст до 40 символов', () => {
  const long = 'я'.repeat(100);
  const [moment] = momentsFromBrief({ scenes: [{ scene: 'fullscreen', start: 0, end: 2, caption: long }] }, { durationSec: 2 });
  assert.equal(moment.label, `fullscreen ${'я'.repeat(40)}`);
});

test('пустые scenes и нет манифеста: 16 равномерных моментов even', () => {
  const moments = keyMoments({ brief: { scenes: [] }, durationSec: 16 });
  assert.equal(moments.length, 16);
  assert.ok(moments.every((m) => m.kind === 'even'));
  assert.equal(moments[0].timeSec, 0.5);
  assert.doesNotThrow(() => keyMoments({ durationSec: 8 }));
});

test('манифест в приоритете над ТЗ', () => {
  const manifest = manifestFixture({ texts: [text('title-1', 25)] });
  const brief = { scenes: [{ scene: 'text-only', start: 0, end: 3 }] };
  assert.deepEqual(times(keyMoments({ manifest, brief, durationSec: 10 })), [1.3, 2]);
});

test('манифест без моментов уступает ТЗ', () => {
  const brief = { scenes: [{ scene: 'text-only', start: 0, end: 3 }] };
  const moments = keyMoments({ manifest: manifestFixture({}), brief, durationSec: 10 });
  assert.deepEqual(moments.filter((m) => m.kind !== 'even').map((m) => [m.timeSec, m.kind]), [[0.3, 'event'], [1.5, 'hold']]);
});

test('ТЗ из одной длинной сцены 0-45: события сохранены и добавлены равномерные кадры', () => {
  const brief = { scenes: [{ scene: 'broll', start: 0, end: 45 }] };
  const moments = keyMoments({ brief, durationSec: 45 });
  assert.ok(moments.length >= 16, `моментов ${moments.length}`);
  assert.ok(moments.some((m) => m.kind === 'event' && m.timeSec === 0.3));
  assert.ok(moments.some((m) => m.kind === 'hold' && m.timeSec === 22.5));
  assert.ok(moments.some((m) => m.kind === 'even'));
  for (let i = 1; i < moments.length; i += 1) assert.ok(moments[i].timeSec - moments[i - 1].timeSec >= 0.15 - 1e-9);
});

test('ТЗ с редкими сценами: дыра больше 3 с заполняется равномерными кадрами', () => {
  const scenes = Array.from({ length: 20 }, (_, i) => ({ scene: 'text-only', start: i, end: i + 1 }));
  assert.ok(!keyMoments({ brief: { scenes }, durationSec: 20 }).some((m) => m.kind === 'even'));
  const gap = keyMoments({ brief: { scenes: [...scenes.slice(0, 10), { scene: 'stat', start: 19, end: 20 }] }, durationSec: 20 });
  assert.ok(gap.some((m) => m.kind === 'even'));
});

test('манифест: элемент без id получает ссылку по номеру, а не undefined', () => {
  const manifest = manifestFixture({ texts: [{ from: 25, frames: [[0, 0, 1, 1]] }], inserts: [{ kind: 'stock', from: 50, to: 100 }] });
  const moments = momentsFromManifest(manifest, { durationSec: 10 });
  assert.deepEqual(moments.map((m) => m.ref), ['text-1', 'text-1', 'insert-1']);
  assert.ok(moments.every((m) => !m.label.includes('undefined')));
});

test('манифест слоя со сцены не с нуля: manifestOffsetSec сдвигает моменты', () => {
  const manifest = manifestFixture({ texts: [text('title-1', 25)] });
  assert.deepEqual(times(keyMoments({ manifest, manifestOffsetSec: 2, durationSec: 10 })), [3.3, 4]);
});

test('моменты ближе 0,15 с сливаются, остаётся событие', () => {
  const manifest = manifestFixture({
    texts: [text('title-1', 25, 1)],
    inserts: [{ id: 'insert-1', kind: 'stock', from: 28, to: 80 }],
  });
  const moments = keyMoments({ manifest, durationSec: 10 });
  assert.equal(moments.filter((m) => m.timeSec >= 1.3 && m.timeSec <= 1.5).length, 1);
  assert.equal(moments.find((m) => m.timeSec >= 1.3 && m.timeSec <= 1.5).kind, 'event');
});

test('слияние: hold рядом с event заменяется событием', () => {
  const manifest = manifestFixture({
    texts: [text('a', 0, 60)], // hold 1.2
    inserts: [{ id: 'i', kind: 'stock', from: 22, to: 60 }], // event 0.88+0.3=1.18
  });
  const moments = keyMoments({ manifest, durationSec: 10 });
  assert.equal(moments.filter((m) => Math.abs(m.timeSec - 1.2) < 0.1).length, 1);
  assert.equal(moments.find((m) => Math.abs(m.timeSec - 1.2) < 0.1).kind, 'event');
});

test('100 текстов: не больше 48 моментов по возрастанию', () => {
  const texts = Array.from({ length: 100 }, (_, i) => text(`title-${i + 1}`, i * 50, 40));
  const moments = keyMoments({ manifest: manifestFixture({ seconds: 200, texts }), durationSec: 200 });
  assert.equal(moments.length, 48);
  for (let i = 1; i < moments.length; i += 1) assert.ok(moments[i].timeSec > moments[i - 1].timeSec);
});

test('параметр max ограничивает число моментов', () => {
  const texts = Array.from({ length: 10 }, (_, i) => text(`title-${i + 1}`, i * 50, 40));
  assert.equal(keyMoments({ manifest: manifestFixture({ seconds: 25, texts }), durationSec: 25, max: 5 }).length, 5);
});

test('ТЗ в отрывке: сцены сдвигаются на fromSec, вне отрывка отбрасываются', () => {
  const brief = { scenes: [{ scene: 'fullscreen', start: 0, end: 3 }, { scene: 'split', start: 3, end: 6 }] };
  // Отрывок с 3-й секунды длиной 3 с: первая сцена целиком до отрывка, вторая начинается в нуле.
  assert.deepEqual(momentsFromBrief(brief, { fromSec: 3, durationSec: 3 }).map((m) => m.timeSec), [0.3, 1.5]);
  const all = keyMoments({ brief, fromSec: 3, durationSec: 3 });
  assert.deepEqual(all.filter((m) => m.kind !== 'even').map((m) => m.timeSec), [0.3, 1.5]);
});

const sparseBrief = (n) => ({
  scenes: Array.from({ length: n }, (_, i) => ({ scene: 'text-only', text: `сцена ${i + 1}`, start: i * 8, end: i * 8 + 8 })),
});
const count = (moments, kind) => moments.filter((m) => m.kind === kind).length;
const sorted = (moments) => times(moments).every((t, i, all) => i === 0 || all[i - 1] <= t);

test('прореживание до 48: все 24 события ТЗ остаются, вытесняются равномерные кадры', () => {
  const moments = keyMoments({ brief: sparseBrief(24), durationSec: 192, max: 48 });
  assert.equal(moments.length, 48);
  assert.equal(count(moments, 'event'), 24);
  assert.ok(sorted(moments));
});

test('порядок отбрасывания при обрезке: сначала even, затем hold, события последними', () => {
  const brief = sparseBrief(24);
  assert.ok(count(keyMoments({ brief, durationSec: 192, max: 1000 }), 'even') > 0);
  const noEven = keyMoments({ brief, durationSec: 192, max: 48 });
  assert.equal(count(noEven, 'even'), 0);
  assert.equal(count(noEven, 'hold'), 24);
  const some = keyMoments({ brief, durationSec: 192, max: 30 });
  assert.deepEqual([count(some, 'event'), count(some, 'hold'), count(some, 'even')], [24, 6, 0]);
  const few = keyMoments({ brief, durationSec: 192, max: 10 });
  assert.deepEqual([few.length, count(few, 'event')], [10, 10]);
});

test('прореживание внутри типа равномерно по времени и сохраняет порядок', () => {
  const moments = keyMoments({ brief: sparseBrief(24), durationSec: 192, max: 30 });
  const holds = moments.filter((m) => m.kind === 'hold').map((m) => m.timeSec);
  assert.equal(holds.length, 6);
  assert.ok(holds[0] < 24, 'первое удержание из начала ролика');
  assert.ok(holds[5] > 160, 'последнее удержание из конца ролика');
  assert.ok(sorted(moments));
});
