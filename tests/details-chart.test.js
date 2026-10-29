const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { loadMotion, dense } = require('./helpers/motion-render');
const { validateMotionBrief, MOTION_SCENES } = require('../scripts/motion/brief');

const ROOT = path.join(__dirname, '..');
const NBSP = ' ';
const math = () => loadMotion('src/details/chart.js');
const textOf = (markup) => markup.replace(/<[^>]*>/g, '');
const pts = (...values) => values.map((value, index) => ({ label: 'П' + (index + 1), value }));

test('chartLayout: heights are proportional and the maximum fills the available height', () => {
  const { chartLayout } = math();
  const layout = chartLayout(pts(10, 20, 40), { width: 600, height: 400, padding: 20 });
  const [a, b, c] = layout.bars;
  assert.ok(Math.abs(b.h - 2 * a.h) < 1e-9 && Math.abs(c.h - 4 * a.h) < 1e-9);
  assert.equal(c.h, 360);
  assert.equal(layout.max, 40);
  assert.equal(layout.baseline, 380);
  assert.deepEqual(layout.bars.map((bar) => bar.value), [10, 20, 40]);
  assert.deepEqual(layout.bars.map((bar) => bar.label), ['П1', 'П2', 'П3']);
  for (const bar of layout.bars) assert.ok(Math.abs(bar.y + bar.h - layout.baseline) < 1e-9);
  assert.ok(a.x < b.x && b.x < c.x && c.x + c.w <= 580);
});

test('chartLayout: all zeros or equal values never divide by zero', () => {
  const { chartLayout } = math();
  const zeros = chartLayout(pts(0, 0, 0), { width: 600, height: 400, padding: 20 });
  assert.ok(zeros.max > 0);
  for (const bar of zeros.bars) {
    assert.equal(bar.h, 0);
    assert.equal(bar.y, zeros.baseline);
  }
  const equal = chartLayout(pts(7, 7), { width: 600, height: 400, padding: 20 });
  assert.equal(equal.bars[0].h, 360);
  assert.equal(equal.bars[1].h, 360);
  const mixed = chartLayout(pts(0, 5), { width: 600, height: 400, padding: 20 });
  assert.equal(mixed.bars[0].h, 0);
  assert.equal(mixed.bars[1].h, 360);
  for (const bar of [...zeros.bars, ...equal.bars, ...mixed.bars]) {
    assert.ok(Number.isFinite(bar.x) && Number.isFinite(bar.y) && Number.isFinite(bar.w) && Number.isFinite(bar.h));
  }
});

test('barGrowth: bars grow one after another with a 5 frame step at 25 fps', () => {
  const { barGrowth } = math();
  assert.equal(barGrowth(0, 25, 0), 0);
  assert.ok(barGrowth(1, 25, 0) > 0);
  assert.equal(barGrowth(5, 25, 1), 0);
  assert.ok(barGrowth(6, 25, 1) > 0);
  assert.ok(barGrowth(5, 25, 0) > barGrowth(5, 25, 1));
  assert.equal(barGrowth(500, 25, 2), 1);
  assert.equal(barGrowth(10, 25, 2), 0);
  assert.ok(barGrowth(6, 25, 1, { stepFrames25: 4 }) > barGrowth(6, 25, 1, { stepFrames25: 6 }));
  // шаг считается от FPS: при 50 fps это 10 кадров
  assert.equal(barGrowth(10, 50, 1), 0);
  assert.ok(barGrowth(11, 50, 1) > 0);
});

test('linePath starts with M and goes through the tops of all bars', () => {
  const { chartLayout, linePath } = math();
  const { bars } = chartLayout(pts(10, 20, 40), { width: 600, height: 400, padding: 20 });
  const d = linePath(bars);
  assert.match(d, /^M/);
  assert.equal((d.match(/[ML]/g) || []).length, 3);
  for (const bar of bars) {
    const point = Math.round((bar.x + bar.w / 2) * 100) / 100 + ' ' + Math.round(bar.y * 100) / 100;
    assert.ok(d.includes(point), d);
  }
});

test('barToLine: bars shrink in 8 frames, then the line draws in 15 frames (25 fps)', () => {
  const { barToLine } = math();
  assert.deepEqual(barToLine(10, 25, 10), { barScale: 1, lineProgress: 0 });
  const shrunk = barToLine(18, 25, 10);
  assert.equal(shrunk.barScale, 0);
  assert.equal(shrunk.lineProgress, 0);
  assert.ok(barToLine(14, 25, 10).barScale > 0 && barToLine(14, 25, 10).barScale < 1);
  assert.ok(barToLine(25, 25, 10).lineProgress > 0 && barToLine(25, 25, 10).lineProgress < 1);
  assert.equal(barToLine(33, 25, 10).lineProgress, 1);
  assert.equal(barToLine(500, 25, 10).lineProgress, 1);
});

test('barShape: the last shrink frame equals the dot, with no jump at the swap', () => {
  const { chartLayout, barShape, barToLine, dotShape, barGrowth } = math();
  const { bars, baseline } = chartLayout(pts(10, 20, 40, 0), { width: 800, height: 400, padding: { top: 56, bottom: 130 } });
  const fps = 25;
  const start = 40;
  bars.forEach((bar, index) => {
    const growth = barGrowth(start + 8, fps, index);
    const last = barShape(bar, { growth, scale: barToLine(start + 8, fps, start).barScale, baseline });
    const dot = dotShape(bar, growth);
    assert.equal(last.x + last.width / 2, dot.cx);
    assert.equal(last.y + last.height / 2, dot.cy);
    assert.equal(last.width, dot.r * 2);
    assert.equal(last.height, dot.r * 2);
    assert.equal(last.rx, dot.r);
    assert.equal(dot.cy, bar.y);
    // в начале сжатия фигура – обычный столбик
    const first = barShape(bar, { growth: 1, scale: 1, baseline });
    assert.equal(first.width, bar.w);
  });
});

test('barToLineStart: the line finishes by the last frame even in a short scene', () => {
  const { barToLineStart, barToLine } = math();
  for (const [count, duration, fps] of [[8, 90, 25], [8, 60, 25], [8, 120, 50], [2, 200, 25], [5, 45, 30]]) {
    const start = barToLineStart(count, fps, { durationInFrames: duration });
    assert.equal(barToLine(duration - 1, fps, start).lineProgress, 1, `${count}/${duration}/${fps}`);
    assert.ok(start >= 0);
  }
  // длинная сцена: пауза после роста сохраняется
  assert.equal(barToLineStart(3, 25, { durationInFrames: 500 }), 2 * 5 + 12 + 10);
  // сцена короче 8+15 кадров: сжатие начинается с кадра 0
  assert.equal(barToLineStart(8, 25, { durationInFrames: 10 }), 0);
});

function renderChart(frame, props) {
  const { Chart } = loadMotion('src/details/Chart.jsx', { useCurrentFrame: () => frame });
  return renderToStaticMarkup(React.createElement(Chart, { width: 800, height: 600, ...props }));
}

const theme = { accent: '#335E99', ink: '#202A36', muted: '#546477', line: '#C3CEDB', fontFamily: 'Onest, sans-serif' };

test('line chart value label keeps a gap from the dot edge of at least 4 px', () => {
  const markup = renderChart(300, { chartType: 'line', theme,
    points: [{ label: 'А', value: 10 }, { label: 'Б', value: 30 }, { label: 'В', value: 20 }] });
  const dots = [...markup.matchAll(/data-chart-dot="true" cx="[\d.]+" cy="([\d.]+)" r="([\d.]+)"/g)];
  const values = [...markup.matchAll(/data-chart-value="true" style="[^"]*?top:([\d.-]+)px;font-size:([\d.]+)px;line-height:1.16/g)];
  assert.equal(dots.length, 3);
  assert.equal(values.length, 3);
  dots.forEach((dot, index) => {
    const bottom = Number(values[index][1]) + Number(values[index][2]) * 1.16;
    assert.ok(Number(dot[1]) - Number(dot[2]) - bottom >= 4, `dot ${index}: gap ${Number(dot[1]) - Number(dot[2]) - bottom}`);
  });
});

test('Chart at rest keeps labels and values verbatim and marks them for text checks', () => {
  const markup = renderChart(300, {
    chartType: 'bar', theme, highlight: 1,
    points: [{ label: 'Январь', value: 1250000 }, { label: 'Февраль', value: 12.5 }, { label: 'Март', value: 0 }],
  });
  const text = textOf(markup);
  for (const expected of ['Январь', 'Февраль', 'Март', '1' + NBSP + '250' + NBSP + '000', '12,5']) {
    assert.ok(text.includes(expected), expected);
  }
  assert.match(markup, /data-motion-text="true"/);
  assert.match(markup, /data-chart-type="bar"/);
  assert.match(markup, /data-chart-highlight="1"/);
  assert.ok(markup.includes(theme.accent));
  assert.ok(markup.includes(theme.fontFamily));
});

test('Chart with zero values renders a visible base line and no NaN', () => {
  const markup = renderChart(300, { chartType: 'bar', theme, points: pts(0, 0, 0) });
  assert.doesNotMatch(markup, /NaN|Infinity/);
  assert.match(markup, /data-chart-baseline/);
});

test('Chart bar-to-line: bars first, then the line with dots', () => {
  const props = { chartType: 'bar-to-line', theme, points: pts(10, 20, 40) };
  assert.doesNotMatch(renderChart(10, props), /data-chart-line/);
  assert.match(renderChart(10, props), /data-chart-bar/);
  const end = renderChart(300, props);
  assert.match(end, /data-chart-line/);
  assert.match(end, /data-chart-dot/);
  assert.doesNotMatch(renderChart(300, { ...props, chartType: 'bar' }), /data-chart-line/);
});

test('ChartScene renders title, points and unit inside the safe frame', () => {
  const { ChartScene } = loadMotion('src/motion/ChartScene.jsx', { useCurrentFrame: () => 89 });
  const markup = renderToStaticMarkup(React.createElement(ChartScene, {
    title: 'Выручка по кварталам', chartType: 'bar-to-line', unit: 'млн ₽', highlight: 2, caption: 'Подпись',
    points: [{ label: 'I кв.', value: 10 }, { label: 'II кв.', value: 20 }, { label: 'III кв.', value: 40 }],
    durationInFrames: 90,
  }));
  assert.match(markup, /data-motion-safe/);
  assert.match(markup, /data-motion-caption/);
  const text = textOf(markup);
  for (const expected of ['Выручка по кварталам', 'I кв.', 'III кв.', 'млн ₽', '40']) assert.ok(text.includes(expected), expected);
});

test('ChartScene survives eight schema-maximum points', () => {
  const { ChartScene } = loadMotion('src/motion/ChartScene.jsx', { useCurrentFrame: () => 89 });
  const points = Array.from({ length: 8 }, (_, index) => ({ label: dense(24), value: (index + 1) * 123456 }));
  const markup = renderToStaticMarkup(React.createElement(ChartScene, {
    title: dense(80), chartType: 'bar', points, unit: dense(16), durationInFrames: 90,
  }));
  assert.doesNotMatch(markup, /NaN/);
  assert.equal((markup.match(/data-chart-label/g) || []).length, 8);
});

const briefWith = (scene) => ({
  version: 1, kind: 'motion-reel', status: 'draft', source: 'input/narration.mp3',
  theme: 'motion-neutral', title: 'График',
  output: { aspect: 'vertical', width: 1080, height: 1920, fps: 30, durationInFrames: 90 },
  scenes: [{ scene: 'chart', start: 0, end: 3, title: 'Рост', chartType: 'bar', points: pts(1, 2, 3), ...scene }],
});

test('brief: chart is a motion scene; 2-8 points, highlight index and value types are validated', () => {
  assert.ok(MOTION_SCENES.includes('chart'));
  assert.equal(validateMotionBrief(briefWith({})).ok, true);
  assert.equal(validateMotionBrief(briefWith({ points: pts(1, 2), unit: '%', highlight: 1, caption: 'Подпись' })).ok, true);
  assert.equal(validateMotionBrief(briefWith({ points: pts(1, 2, 3, 4, 5, 6, 7, 8) })).ok, true);
  assert.equal(validateMotionBrief(briefWith({ points: pts(1) })).ok, false);
  assert.equal(validateMotionBrief(briefWith({ points: pts(1, 2, 3, 4, 5, 6, 7, 8, 9) })).ok, false);
  assert.equal(validateMotionBrief(briefWith({ highlight: 5 })).ok, false);
  assert.equal(validateMotionBrief(briefWith({ highlight: 3 })).ok, false);
  assert.equal(validateMotionBrief(briefWith({ highlight: 2 })).ok, true);
  assert.equal(validateMotionBrief(briefWith({ highlight: -1 })).ok, false);
  assert.equal(validateMotionBrief(briefWith({ chartType: 'pie' })).ok, false);
  assert.equal(validateMotionBrief(briefWith({ points: [{ label: 'Щ'.repeat(25), value: 1 }, { label: 'Б', value: 2 }] })).ok, false);
  assert.equal(validateMotionBrief(briefWith({ points: [{ label: 'А', value: '5' }, { label: 'Б', value: 2 }] })).ok, false);
  assert.equal(validateMotionBrief(briefWith({ points: [{ label: 'А', value: -5 }, { label: 'Б', value: 2 }] })).ok, false);
  assert.equal(validateMotionBrief(briefWith({ unit: 'Щ'.repeat(17) })).ok, false);
  assert.match(validateMotionBrief(briefWith({ highlight: 5 })).errors.join('\n'), /highlight/);
});

test('public demo brief covers the chart scene and the release check names eight scenes', () => {
  const demo = JSON.parse(fs.readFileSync(path.join(ROOT, 'examples/motion-brief-demo.json'), 'utf8'));
  assert.ok(demo.scenes.some((scene) => scene.scene === 'chart'));
  assert.equal(validateMotionBrief(demo).ok, true);
  const release = fs.readFileSync(path.join(ROOT, 'scripts/check-release.js'), 'utf8');
  assert.match(release, /'chart'/);
  assert.match(release, /eight scenes/);
});

test('review timeline shows chart text', () => {
  const source = fs.readFileSync(path.join(ROOT, 'review/timeline.js'), 'utf8');
  assert.match(source, /'chart'/);
});
