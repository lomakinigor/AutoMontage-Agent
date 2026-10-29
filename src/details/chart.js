// Математика графика: раскладка столбиков и ритм анимации. Без React и тем.
const GROW_FRAMES_25 = 12;
const SHRINK_FRAMES_25 = 8;
const DRAW_FRAMES_25 = 15;
const HOLD_FRAMES_25 = 10;
const BAR_SHARE = 0.6;
export const DOT_SIZE = 28;
const BASE_THICKNESS = 4;

const clamp01 = (value) => Math.max(0, Math.min(1, value));
const easeOut = (value) => 1 - (1 - clamp01(value)) ** 3;
const round2 = (value) => Math.round(value * 100) / 100;
// Кадры эталона 25 fps переводятся в кадры ролика.
const ref25 = (frames, fps) => Math.max(1, Math.round((frames * fps) / 25));
const stepOf = (stepFrames25, fps) => ref25(Math.max(4, Math.min(6, stepFrames25)), fps);

const insets = (padding) => {
  const box = typeof padding === 'number' ? { top: padding, right: padding, bottom: padding, left: padding } : padding || {};
  return { top: box.top ?? 0, right: box.right ?? 0, bottom: box.bottom ?? 0, left: box.left ?? 0 };
};

// Высота столбика = value / max * доступная высота. Нулевые и отрицательные значения дают высоту 0
// (столбик лежит на линии основания), max никогда не 0, поэтому деления на ноль нет.
export const chartLayout = (points, { width, height, padding = 0 } = {}) => {
  const pad = insets(padding);
  const innerWidth = Math.max(0, width - pad.left - pad.right);
  const innerHeight = Math.max(0, height - pad.top - pad.bottom);
  const largest = Math.max(0, ...points.map((point) => Number(point.value) || 0));
  const max = largest > 0 ? largest : 1;
  const slot = points.length ? innerWidth / points.length : 0;
  const barWidth = slot * BAR_SHARE;
  const baseline = pad.top + innerHeight;
  const bars = points.map((point, index) => {
    const value = Number(point.value) || 0;
    const h = value > 0 ? (value / max) * innerHeight : 0;
    return {
      x: pad.left + slot * index + (slot - barWidth) / 2, y: baseline - h, w: barWidth, h,
      label: point.label, value: point.value,
    };
  });
  return { bars, baseline, max };
};

export const barGrowthFrames = (fps) => ref25(GROW_FRAMES_25, fps);

// Столбики растут по очереди: шаг 4–6 кадров эталона 25 fps (по умолчанию 5), рост easeOut.
export const barGrowth = (frame, fps, index, { stepFrames25 = 5 } = {}) =>
  easeOut((frame - index * stepOf(stepFrames25, fps)) / barGrowthFrames(fps));

// Линия идёт через центры верхушек столбиков.
export const linePath = (bars) => bars
  .map((bar, index) => `${index === 0 ? 'M' : 'L'} ${round2(bar.x + bar.w / 2)} ${round2(bar.y)}`)
  .join(' ');

// Линия прорисовывается за 15 кадров эталона 25 fps от startFrame.
export const lineProgress = (frame, fps, startFrame = 0) => clamp01((frame - startFrame) / ref25(DRAW_FRAMES_25, fps));

// Столбики сжимаются в точки за 8 кадров, затем линия прорисовывается за 15.
export const barToLine = (frame, fps, startFrame) => {
  const shrink = ref25(SHRINK_FRAMES_25, fps);
  return {
    barScale: 1 - clamp01((frame - startFrame) / shrink),
    lineProgress: lineProgress(frame, fps, startFrame + shrink),
  };
};

// Кадр, с которого столбики сжимаются: после роста последнего и короткой паузы,
// но так, чтобы линия дорисовалась не позже последнего кадра сцены (если длительность известна).
// В короткой сцене сжатие начинается раньше и может накладываться на хвост роста столбиков
// (фигура учитывает неполный рост). Если сцена короче сжатия и прорисовки вместе
// (23 кадра эталона 25 fps), старт зажимается в 0 и линия дорисуется, сколько хватит кадров.
export const barToLineStart = (count, fps, { stepFrames25 = 5, durationInFrames } = {}) => {
  const grown = Math.max(0, count - 1) * stepOf(stepFrames25, fps) + barGrowthFrames(fps);
  const wanted = grown + ref25(HOLD_FRAMES_25, fps);
  if (!Number.isFinite(durationInFrames)) return wanted;
  const latest = durationInFrames - 1 - ref25(SHRINK_FRAMES_25, fps) - ref25(DRAW_FRAMES_25, fps);
  return Math.max(0, Math.min(wanted, latest));
};

// Точка линии: круг с центром в вершине линии (cx, bar.y).
export const dotShape = (bar, growth = 1) => ({ cx: bar.x + bar.w / 2, cy: bar.y, r: (DOT_SIZE / 2) * growth });

// Прямоугольник столбика при масштабе сжатия scale (1 – столбик, 0 – точка). Форма линейно
// переходит в ту же геометрию, что и dotShape, поэтому при смене на круг нет скачка.
export const barShape = (bar, { growth = 1, scale = 1, baseline } = {}) => {
  const full = bar.h * growth;
  const zero = bar.h === 0;
  const start = zero
    ? { top: baseline - BASE_THICKNESS * 1.5, height: BASE_THICKNESS * 1.5 }
    : { top: baseline - full, height: full };
  const rx0 = Math.min(12, bar.w / 2);
  if (scale >= 1) {
    return { x: bar.x, y: start.top, width: bar.w, height: start.height, rx: rx0 };
  }
  const dot = dotShape(bar, growth);
  const size = dot.r * 2;
  const mix = (a, b) => b + (a - b) * scale;
  const width = mix(bar.w, size);
  return {
    x: dot.cx - width / 2,
    y: mix(start.top, dot.cy - dot.r),
    width,
    height: mix(start.height, size),
    rx: Math.min(mix(rx0, dot.r), width / 2),
  };
};
