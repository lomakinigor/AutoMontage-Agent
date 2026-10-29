// Математика текстуры кадра: сдвиг зерна, дрейф фона, проход блика. Без React и тем.
import { ref25 } from '../motion-kit/time.js';

export const GRAIN_OPACITY = 0.06;
export const GRAIN_TILE = 256;
// Непрозрачность слоя дрейфа: от неё зависит худший контраст подписи над пятном.
export const DRIFT_OPACITY = 0.3;
// Ключи motionTheme для двух пятен дрейфа: оба не темнее accentSoft, чтобы подпись держала контраст 4.5.
export const DRIFT_COLOR_KEYS = Object.freeze(['accentSoft', 'panel']);
const SHEEN_FRAMES_25 = 12;

// Детерминированный хеш (целое от шага и seed): один и тот же кадр всегда даёт один сдвиг.
const hash = (a, b) => {
  let h = Math.imul(a ^ 0x9E3779B9, 0x85EBCA6B) ^ Math.imul(b + 0x7F4A7C15, 0xC2B2AE35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2C1B3C6D);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297A2D39);
  h ^= h >>> 15;
  return h >>> 0;
};

// Зерно неподвижно: сдвиг зависит только от seed. Меняющееся раз в 2 кадра зерно – полнокадровый
// шум, h264 его не сжимает (27 с ролика весили 78–136 МБ вместо ~1 МБ). animated: true – явный
// старый режим (шаг раз в stepFrames кадров); маршруты сборки его не используют.
export const grainOffset = (frame, { stepFrames = 2, seed = 7, animated = false } = {}) => {
  const step = animated ? Math.floor(Math.max(0, frame) / stepFrames) : 0;
  return { x: hash(step, seed) % GRAIN_TILE, y: hash(step, seed + 101) % GRAIN_TILE };
};

// Порог относительной яркости (WCAG): ниже – фон тёмный и зерно на нём заметно.
export const DARK_LUMINANCE = 0.4;

const parseColor = (color) => {
  if (typeof color !== 'string') return null;
  const value = color.trim();
  let match = /^#([0-9a-f]{3})$/i.exec(value);
  if (match) return [...match[1]].map((c) => parseInt(c + c, 16));
  match = /^#([0-9a-f]{6})$/i.exec(value);
  if (match) return [0, 2, 4].map((i) => parseInt(match[1].slice(i, i + 2), 16));
  match = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(value);
  // Полупрозрачный цвет лежит поверх неизвестного фона: тёмным его не считаем.
  if (match && match[4] !== undefined && Number(match[4]) < 1) return null;
  if (match) return match.slice(1, 4).map(Number).map((c) => Math.min(255, c));
  return null;
};

// true – фон тёмный (относительная яркость < 0.4). Нераспознанный цвет считается светлым: зерно не рисуем.
export const isDarkBackground = (color) => {
  const rgb = parseColor(color);
  if (!rgb) return false;
  const [r, g, b] = rgb.map((c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < DARK_LUMINANCE;
};

// Доли размера кадра; период замкнут, поэтому кадр 0 и кадр через periodSec совпадают.
export const driftAt = (frame, fps, { periodSec = 8, amplitude = 0.06 } = {}) => {
  const phase = (2 * Math.PI * frame) / (fps * periodSec);
  return { x: amplitude * Math.sin(phase), y: amplitude * Math.cos(phase) };
};

// Пятна дрейфа в порядке рисования: CSS кладёт первый фон сверху, поэтому второе пятно – первым.
// Центр в долях слоя, stop – доля радиуса farthest-corner, где пятно становится прозрачным.
const DRIFT_SPOTS = [
  { color: 1, cx: 0.8, cy: 0.85, stop: 0.5 },
  { color: 0, cx: 0.25, cy: 0.2, stop: 0.55 },
];

// ctx.fillStyle нормализует любой CSS-цвет в '#rrggbb' или 'rgba(r, g, b, a)'.
const rgbaStops = (ctx, color) => {
  ctx.fillStyle = color;
  const value = String(ctx.fillStyle);
  let rgb = [0, 0, 0];
  let alpha = 1;
  const hexMatch = /^#([0-9a-f]{6})$/i.exec(value);
  const rgbaMatch = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(value);
  if (hexMatch) rgb = [0, 2, 4].map((i) => parseInt(hexMatch[1].slice(i, i + 2), 16));
  else if (rgbaMatch) {
    rgb = rgbaMatch.slice(1, 4).map(Number);
    if (rgbaMatch[4] !== undefined) alpha = Number(rgbaMatch[4]);
  }
  const of = (a) => `rgba(${rgb.join(', ')}, ${a})`;
  return [of(alpha), of(0)];
};

// Рисует дрейф в canvas один раз: те же два radial-gradient (circle farthest-corner), что прежний
// CSS-фон слоя. Конец пятна – тот же цвет с нулевой альфой: так CSS интерполирует transparent
// (premultiplied), и кадр совпадает с CSS-версией (разница не больше 3 из 255 от сглаживания).
// width/height – CSS-размер слоя, scale – плотность canvas (devicePixelRatio).
export const paintDrift = (ctx, { width, height, scale = 1, colors }) => {
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, width, height);
  for (const spot of DRIFT_SPOTS) {
    const [solid, clear] = rgbaStops(ctx, colors[spot.color]);
    const cx = spot.cx * width;
    const cy = spot.cy * height;
    const radius = Math.hypot(Math.max(cx, width - cx), Math.max(cy, height - cy));
    const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
    gradient.addColorStop(0, solid);
    gradient.addColorStop(spot.stop, clear);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
  }
};

// 0..1 внутри одного прохода, null вне него (до входа и после 12 кадров при 25 fps; при другом fps
// те же 0,48 с через ref25).
export const sheenProgress = (frame, fps, enterFrame = 0, { frames25 = SHEEN_FRAMES_25 } = {}) => {
  const frames = ref25(frames25, fps);
  const local = frame - enterFrame;
  if (local < 0 || local >= frames) return null;
  return local / frames;
};
