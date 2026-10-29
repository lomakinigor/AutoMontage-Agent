const test = require('node:test');
const assert = require('node:assert/strict');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { loadMotion } = require('./helpers/motion-render');
const { validateMotionBrief } = require('../scripts/motion/brief');

const NBSP = ' ';
const math = () => loadMotion('src/details/odometer.js');
const textOf = (markup) => markup.replace(/<[^>]*>/g, '');

test('formatNumber groups digits with U+00A0 and uses a decimal comma', () => {
  const { formatNumber } = math();
  assert.equal(formatNumber(1250000), `1${NBSP}250${NBSP}000`);
  assert.equal(formatNumber(12.5, { decimals: 1 }), '12,5');
  assert.equal(formatNumber(12.5), '12,5');
  assert.equal(formatNumber(-40), '-40');
  assert.equal(formatNumber(-1234567.89), `-1${NBSP}234${NBSP}567,89`);
  assert.equal(formatNumber(1250000, { locale: 'en' }), '1,250,000');
});

test('odometerColumns: rest is exact, non-digits are static, low places spin more', () => {
  const { odometerColumns } = math();
  const rest = odometerColumns(`1${NBSP}250`, 1);
  assert.equal(rest.map((c) => c.char).join(''), `1${NBSP}250`);
  assert.ok(rest.every((c) => c.offset === 0));
  assert.equal(rest[1].digit, false);
  const half = odometerColumns(`1${NBSP}250`, 0.5);
  const digits = half.filter((c) => c.digit);
  assert.ok(Math.abs(digits.at(-1).offset) > Math.abs(digits[0].offset));
  assert.equal(half[1].offset, 0);
});

test('odometerProgress rolls to 1, settles with overshoot of at most 0.15 and rests at exactly 1', () => {
  const { odometerProgress } = math();
  assert.equal(odometerProgress(0, 30), 0);
  assert.equal(odometerProgress(60, 30), 1);
  assert.equal(odometerProgress(500, 30), 1);
  assert.equal(odometerProgress(10, 30, { delayFrames: 20 }), 0);
  let max = 0;
  for (let frame = 0; frame <= 90; frame++) {
    const value = odometerProgress(frame, 30);
    assert.ok(value >= 0 && value <= 1.15, `frame ${frame}: ${value}`);
    max = Math.max(max, value);
  }
  assert.ok(max > 1, 'spring overshoots');
});

function renderOdometer(frame, props) {
  const { Odometer } = loadMotion('src/details/Odometer.jsx', { useCurrentFrame: () => frame });
  return renderToStaticMarkup(React.createElement(Odometer, props));
}

test('odometer at rest shows the approved string symbol for symbol', () => {
  for (const [value, expected, extra] of [
    [-40, '-40', {}],
    [12.5, '12,5', { suffix: ' %' }],
    [1250000, `1${NBSP}250${NBSP}000`, { suffix: ' ₽' }],
  ]) {
    const markup = renderOdometer(300, { value, ...extra });
    assert.match(markup, /data-motion-text="true"/);
    assert.ok(markup.includes(`data-counter-value="${expected}"`), markup);
    assert.equal(textOf(markup), `${expected}${extra.suffix || ''}`);
    assert.doesNotMatch(markup, /overflow:\s*hidden/);
  }
});

test('odometer width is fixed by the final number from the first frame', () => {
  const sizer = (markup) => markup.match(/<span[^>]*data-odometer-sizer="true"[^>]*>(.*?)<\/span>/)[1];
  const first = renderOdometer(0, { value: 1250000 });
  const mid = renderOdometer(20, { value: 1250000 });
  const last = renderOdometer(300, { value: 1250000 });
  assert.equal(sizer(first), `1${NBSP}250${NBSP}000`);
  assert.equal(sizer(mid), sizer(first));
  assert.equal(sizer(last), sizer(first));
  assert.match(first, /overflow:\s*hidden/, 'digit windows clip only while rolling');
});

test('layout inline keeps affixes in one line, stack puts them above and below', () => {
  const inline = renderOdometer(300, { value: 5, prefix: 'до ', suffix: ' лет' });
  assert.equal(textOf(inline), 'до 5 лет');
  assert.match(inline, /data-odometer-layout="inline"/);
  const stack = renderOdometer(300, { value: 5, prefix: 'до', suffix: 'лет', layout: 'stack' });
  assert.match(stack, /data-odometer-layout="stack"/);
  assert.match(stack, /flex-direction:\s*column/);
});

test('CounterScene renders the Odometer and keeps the final string in data-counter-value', () => {
  let frame = 0;
  const { CounterScene } = loadMotion('src/motion/CounterScene.jsx', { useCurrentFrame: () => frame });
  const scene = { label: 'Выручка', value: 1250000, suffix: ' ₽', durationInFrames: 120 };
  const at = (next) => { frame = next; return renderToStaticMarkup(React.createElement(CounterScene, scene)); };
  const final = `1${NBSP}250${NBSP}000`;
  assert.ok(at(119).includes(`data-counter-value="${final}"`));
  assert.ok(at(0).includes(`data-counter-value="${final}"`));
  assert.match(at(30), /data-odometer-layout="inline"/);
  assert.match(at(30), /data-odometer-sizer/);
  assert.match(at(30), /data-odometer-roll/);
  assert.doesNotMatch(at(119), /data-odometer-roll/);
  assert.match(at(119), /width:\s*100%/, 'progress bar stays');
});

test('old counter brief without layout stays valid, layout accepts inline and stack only', () => {
  const base = {
    version: 1, kind: 'motion-reel', status: 'draft', source: 'input/narration.mp3',
    theme: 'motion-neutral', title: 'Счётчик',
    output: { aspect: 'vertical', width: 1080, height: 1920, fps: 30, durationInFrames: 90 },
    scenes: [{ scene: 'counter', start: 0, end: 3, label: 'Результат', value: 42, suffix: '%' }],
  };
  assert.equal(validateMotionBrief(base).ok, true);
  for (const layout of ['inline', 'stack']) {
    assert.equal(validateMotionBrief({ ...base, scenes: [{ ...base.scenes[0], layout }] }).ok, true);
  }
  assert.equal(validateMotionBrief({ ...base, scenes: [{ ...base.scenes[0], layout: 'grid' }] }).ok, false);
});

test('odometerColumns: after the roll all digits settle by the same small offset (no backwards re-roll)', () => {
  const { odometerColumns, odometerProgress, odometerRolled } = math();
  const text = `1${NBSP}250${NBSP}000`;
  for (const fps of [25, 30]) {
    for (let frame = 0; frame < fps * 3; frame += 1) {
      if (!odometerRolled(frame, fps)) continue;
      const offsets = odometerColumns(text, odometerProgress(frame, fps), { rolled: true })
        .filter(column => column.digit).map(column => column.offset);
      assert.ok(offsets.every(offset => Math.abs(offset) <= 0.15 + 1e-9), `fps ${fps} frame ${frame}: ${offsets}`);
      assert.ok(offsets.every(offset => offset === offsets[0]), `fps ${fps} frame ${frame} uniform`);
    }
  }
});
