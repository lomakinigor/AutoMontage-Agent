const test = require('node:test');
const assert = require('node:assert/strict');
const { OVERLAP_SHARE_MAX, sameGroup, textLayoutGates } = require('../scripts/qa/text-layout-gates');

const box = (id, left, top, right, bottom, clipped = false) => ({ id, rect: { left, top, right, bottom }, clipped });
const run = (boxes, width = 1080, height = 1920, timeSec = 1) => textLayoutGates({ samples: [{ timeSec, boxes }], width, height });

test('порог наложения 0.04', () => assert.equal(OVERLAP_SHARE_MAX, 0.04));

test('бокс правее безопасной зоны на 34 px – G14 warn, note «справа на 34 px»', () => {
  const [g14, g15] = run([box('title-2', 100, 400, 984, 500)]);
  assert.equal(g14.id, 'G14');
  assert.equal(g14.status, 'warn');
  assert.equal(g14.value, 1);
  assert.equal(g14.spans[0].note, 'title-2: справа на 34 px');
  assert.equal(g14.spans[0].fromSec, 1);
  assert.equal(g15.status, 'pass');
});

test('несколько сторон перечисляются в одной заметке', () => {
  const [g14] = run([box('big', 0, 0, 1080, 1920)]);
  assert.equal(g14.value, 1);
  for (const w of ['слева', 'сверху', 'справа', 'снизу']) assert.ok(g14.spans[0].note.includes(w));
});

test('clipped: true внутри зоны – G14 warn', () => {
  const [g14] = run([box('title-1', 100, 400, 500, 500, true)]);
  assert.equal(g14.status, 'warn');
  assert.match(g14.spans[0].note, /title-1/);
});

test('бокс внутри зоны – G14 pass', () => {
  assert.equal(run([box('a', 100, 400, 500, 500)])[0].status, 'pass');
});

test('два заголовка пересекаются на 30 % – G15 warn', () => {
  const [g14, g15] = run([box('title-1', 100, 400, 200, 500), box('title-2', 170, 400, 270, 500)]);
  assert.equal(g14.status, 'pass');
  assert.equal(g15.status, 'warn');
  assert.equal(g15.value, 1);
  assert.equal(g15.spans[0].toSec, 1);
});

test('пересечение 2 % – pass', () => {
  const [, g15] = run([box('a', 100, 400, 200, 500), box('b-1', 198, 400, 298, 500)]);
  assert.equal(g15.status, 'pass');
});

test('caption-3 и caption-3b пересекаются – pass (одна группа)', () => {
  const [, g15] = run([box('caption-3', 100, 400, 300, 500), box('caption-3b', 100, 400, 300, 500)]);
  assert.equal(g15.status, 'pass');
});

test('sameGroup режет только суффикс b после цифры', () => {
  assert.equal(sameGroup('caption-3', 'caption-3b2'), true);
  assert.equal(sameGroup('caption-3b', 'caption-3b2'), true);
  assert.equal(sameGroup('caption-3', 'caption-4'), false);
  assert.equal(sameGroup('label-tab', 'label-ta'), false);
  assert.equal(sameGroup('title-b', 'title-'), false);
  assert.equal(sameGroup('label-tab', 'label-tab'), true);
});

test('нулевая площадь не даёт деления на ноль', () => {
  const [, g15] = run([box('a', 100, 400, 100, 400), box('b', 100, 400, 200, 500)]);
  assert.equal(g15.status, 'pass');
});

test('16:9 1920x1080 использует SAFE_16x9', () => {
  const [g14] = run([box('t', 100, 100, 1850, 500)], 1920, 1080);
  assert.equal(g14.status, 'warn');
  assert.equal(g14.spans[0].note, 't: справа на 10 px');
  assert.equal(run([box('t', 100, 100, 1840, 500)], 1920, 1080)[0].status, 'pass');
});

test('spans не больше 10, value считает все нарушения', () => {
  const boxes = Array.from({ length: 15 }, (_, i) => box(`t-${i}`, 0, 400, 100, 500));
  const [g14] = run(boxes);
  assert.equal(g14.value, 15);
  assert.equal(g14.spans.length, 10);
});

test('samples null с ошибкой – оба skipped, hint = текст ошибки', () => {
  const gates = textLayoutGates({ samples: null, width: 1080, height: 1920, error: 'нет кадров' });
  assert.deepEqual(gates.map((g) => g.status), ['skipped', 'skipped']);
  assert.equal(gates[0].hint, 'нет кадров');
});

test('пустые боксы – оба skipped «в кадрах нет размеченного текста»', () => {
  const gates = textLayoutGates({ samples: [{ timeSec: 0, boxes: [] }], width: 1080, height: 1920 });
  assert.deepEqual(gates.map((g) => g.status), ['skipped', 'skipped']);
  assert.equal(gates[0].hint, 'в кадрах нет размеченного текста');
});
