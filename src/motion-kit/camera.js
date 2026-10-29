import { Easing, interpolate, spring } from 'remotion';
import { secToFrame, ref25 } from './time.js';

export const DEFAULT_PRESETS = Object.freeze({
  W: { s: 1.0 },
  M: { s: 1.18 },
  L: { s: 1.12, dx: -170, fill: true },
  R: { s: 1.12, dx: 170, fill: true },
  top: { s: 1.0, dy: 380, fill: true },
});

export const CAMERA_DEFAULTS = Object.freeze({
  maxScale: 1.25,
  drift: { amp: 0.05, maxFrames: 150 },
  sway: [{ px: 22, period: 38 }, { px: 14, period: 97 }],
  punch: { damping: 14, stiffness: 180, mass: 0.6, releaseFrames: 10, k: 1.15 },
  blur: { px: 20, inFrames: 6, outFrames: 10, dimAt: 24, dim: 0.28 },
  away: { enterFrames: 8, exitFrames: 10, blurPx: 26 },
  // Мягкий край резкой копии над заливкой (fill): px кадра для короткой стороны 1080. Сторона
  // растушёвана на столько, сколько она открывает за план, в пределах [minFeatherPx, featherPx].
  fill: { featherPx: 96, minFeatherPx: 8 },
  // Наезд на элемент кадра (pushes): длина в кадрах эталона 25 fps и верхняя граница масштаба по
  // умолчанию. Без явного k наезд идёт до min(k, maxScale): при стандартном maxScale 1,25 – до 1,25.
  push: { frames: 12, k: 1.35 },
});

const CLAMP = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' };
const DRIFT = Easing.bezier(0.45, 0, 0.55, 1);
const ramp = (frame, from, len) => (len <= 0 ? (frame >= from ? 1 : 0) : interpolate(frame, [from, from + len], [0, 1], CLAMP));

export function compileCamera(spec, { fps, width, height, durationInFrames }) {
  if (!spec?.face || !Number.isFinite(spec.face.x) || !Number.isFinite(spec.face.y)) {
    throw new Error('camera.face {x, y} обязателен: точка лица в кадре исходника, px');
  }
  // Пресеты и покачивание заданы для кадра шириной 1080 (короткая сторона) – масштабируем под исходник.
  const k = Math.min(width, height) / 1080;
  const presets = Object.fromEntries(Object.entries({ ...DEFAULT_PRESETS, ...(spec.presets || {}) })
    .map(([name, p]) => [name, { ...p, ...(p.dx !== undefined ? { dx: p.dx * k } : {}), ...(p.dy !== undefined ? { dy: p.dy * k } : {}) }]));
  const f = (sec) => secToFrame(sec, fps);
  // Исходный индекс в spec.shots запоминаем ДО сортировки по at – иначе ошибка «camera.shots[N]»
  // называет позицию после сортировки, а не тот план, который написал человек в plan.js.
  const shots = (spec.shots || [])
    .map((shot, originalIndex) => ({ shot, originalIndex }))
    .sort((a, b) => a.shot.at - b.shot.at)
    .map(({ shot, originalIndex }, index) => {
      if (!presets[shot.preset]) throw new Error(`camera.shots[${originalIndex}]: неизвестный пресет «${shot.preset}»`);
      // shot.dx/dy – ручной сдвиг в пикселях кадра исходника (уже в реальном масштабе, k не
      // применяется); dx/dy пресета заданы для кадра шириной 1080 и масштабированы выше через k.
      return { index, from: f(shot.at), preset: shot.preset, drift: shot.drift || 'in', dx: shot.dx, dy: shot.dy };
    });
  if (!shots.length || shots[0].from !== 0) throw new Error('camera.shots: первый план должен начинаться с 0 с');
  shots.forEach((shot, i) => { shot.to = i + 1 < shots.length ? shots[i + 1].from : durationInFrames; });
  const maxScale = spec.maxScale ?? CAMERA_DEFAULTS.maxScale;
  const punches = (spec.punches || []).map((p) => ({ from: f(p.at), until: f(p.until ?? p.at + 1), k: p.k ?? CAMERA_DEFAULTS.punch.k }));
  return {
    fps, width, height, durationInFrames, k,
    face: { ...spec.face },
    maxScale,
    presets,
    shots,
    punches,
    pushes: compilePushes(spec.pushes, { fps, durationInFrames, maxScale, shots, punches }),
    blurs: (spec.blurs || []).map((b) => ({ from: f(b.from), to: f(b.to), px: b.px ?? CAMERA_DEFAULTS.blur.px })),
    aways: (spec.aways || []).map((a) => ({ from: f(a.from), to: f(a.to) })),
  };
}

// Наезды камеры на элемент кадра: [{at, target, frames?, k?}]. at – секунды, frames – кадры эталона
// 25 fps (по умолчанию CAMERA_DEFAULTS.push.frames), k – масштаб (по умолчанию min(1,35, maxScale),
// явный k больше maxScale – ошибка). Бокс target ставит compileLayer (элементы камере не известны):
// здесь box = null, и такой наезд cameraAt пропускает. Наезд держится до ближайшего следующего
// плана или панча (hold); следующий наезд стартует из этого удержания.
function compilePushes(pushes, { fps, durationInFrames, maxScale, shots, punches }) {
  if (pushes === undefined || pushes === null) return [];
  if (!Array.isArray(pushes)) throw new Error('camera.pushes должен быть массивом {at, target, frames?, k?}');
  const f = (sec) => secToFrame(sec, fps);
  const list = pushes.map((push, index) => {
    const label = `camera.pushes[${index}]`;
    if (typeof push?.target !== 'string' || !push.target.trim()) throw new Error(`${label}: target должен быть id элемента из items`);
    const name = `${label} (${push.target})`;
    if (!Number.isFinite(push.at) || push.at < 0) throw new Error(`${name}: at – конечные секунды ≥ 0, получено ${JSON.stringify(push.at)}`);
    const from = f(push.at);
    if (from >= durationInFrames) throw new Error(`${name}: начинается после конца ролика`);
    const rawFrames = push.frames ?? CAMERA_DEFAULTS.push.frames;
    if (!Number.isFinite(rawFrames) || rawFrames <= 0) throw new Error(`${name}: frames должен быть положительным числом кадров при 25 fps`);
    const k = push.k ?? Math.min(CAMERA_DEFAULTS.push.k, maxScale);
    if (!Number.isFinite(k) || k < 1) throw new Error(`${name}: k должен быть числом ≥ 1, получено ${JSON.stringify(push.k)}`);
    if (k > maxScale + 1e-9) throw new Error(`${name}: k ${k} больше camera.maxScale ${maxScale} – уменьшите k или поднимите maxScale`);
    return { index, target: push.target, from, frames: ref25(rawFrames, fps), k, box: null };
  }).sort((a, b) => a.from - b.from);
  const next = (starts, push) => starts.filter((at) => at > push.from).reduce((min, at) => Math.min(min, at), durationInFrames);
  const planStarts = [...shots.map((s) => s.from), ...punches.map((p) => p.from)];
  for (const push of list) {
    // Ничто не начинается, пока наезд идёт: план, панч или другой наезд внутри [from, from + frames)
    // ломает движение (мгновенный выход из наезда посреди него). Ровно в from + frames – можно.
    const end = push.from + push.frames;
    const name = `camera.pushes[${push.index}] (${push.target})`;
    const at = (frame) => `${(frame / fps).toFixed(2)} с`;
    const shot = shots.find((s) => s.from > push.from && s.from < end);
    if (shot) throw new Error(`${name}: план «${shot.preset}» в ${at(shot.from)} начинается раньше конца наезда (${at(end)}) – сдвиньте план или наезд`);
    const punch = punches.find((p) => p.from >= push.from && p.from < end);
    if (punch) throw new Error(`${name}: панч в ${at(punch.from)} начинается раньше конца наезда (${at(end)}) – сдвиньте панч или наезд`);
    const other = list.find((p) => p !== push && p.from >= push.from && p.from < end && (p.from > push.from || p.index > push.index));
    if (other) throw new Error(`${name}: наезд на «${other.target}» в ${at(other.from)} начинается раньше конца наезда (${at(end)}) – сдвиньте один из наездов`);
    // hold – до следующего плана или панча: после конца наезда камера держит k и центр. Следующий
    // наезд начинается из этого удержания. until – конец участия наезда в кадре (для манифеста).
    push.hold = next(planStarts, push);
    push.until = next([...planStarts, ...list.map((p) => p.from)], push);
  }
  return list;
}

// Центр окна масштаба s вдоль стороны size: окно size/s целиком внутри исходника, центр в
// [size/(2s), size − size/(2s)]. При s ≤ 1 окно не меньше кадра – только середина.
function clampCenter(c, size, s) {
  const half = size / (2 * s);
  if (half >= size / 2) return size / 2;
  return Math.min(size - half, Math.max(half, c));
}

// Центр наезда: центр бокса {x, y, w, h} В КООРДИНАТАХ ИСХОДНИКА, ограниченный так, чтобы при
// масштабе k видимое окно (width/k × height/k) целиком оставалось внутри исходника – без чёрных
// полей у края кадра. Экранный бокс элемента сначала переводится в исходник (screenToSource).
export function pushCenter(targetBox, { width, height, k }) {
  return {
    cx: clampCenter(targetBox.x + targetBox.w / 2, width, k),
    cy: clampCenter(targetBox.y + targetBox.h / 2, height, k),
  };
}

// Камера (s, dx, dy) рисует точку исходника q на экране в face + (q − face) · s + d
// (speakerTransform), значит точка экрана p показывает точку исходника face + (p − face − d) / s.
export function screenToSource(box, { s, dx, dy }, face) {
  return { x: face.x + (box.x - face.x - dx) / s, y: face.y + (box.y - face.y - dy) / s, w: box.w / s, h: box.h / s };
}

const PUSH_EASE = Easing.bezier(0.65, 0, 0.35, 1);
// Наезд в кадре среди первых limit наездов (track.pushes отсортированы по from): последний
// начавшийся, ещё удерживаемый (до следующего плана или панча) и с известным боксом цели. Следующий
// наезд вытесняет предыдущий; без него (limit) виден предыдущий – это и есть стартовое состояние.
function activePush(track, frame, limit) {
  const pushes = track.pushes || [];
  for (let i = Math.min(limit, pushes.length) - 1; i >= 0; i -= 1) {
    const push = pushes[i];
    if (push.box && push.from <= frame && frame < (push.hold ?? push.until)) return i;
  }
  return -1;
}

// Уходы в кадрах (например, из полноэкранных вставок) добавляются к уже скомпилированной камере.
export function withAways(track, aways) {
  return { ...track, aways: [...track.aways, ...aways] };
}

export function cameraAt(track, frame) {
  return withPushes(track, frame, (track.pushes || []).length);
}

// Камера в кадре начала наезда i без него самого. Зависит только от трека и i, поэтому считается
// один раз: без кэша каждый уровень цепочки удерживаемых наездов вызывал withPushes дважды (2^n).
// Кэш по объекту трека: скомпилированный трек не меняется, новый трек (withAways) – новый ключ.
const anchorCache = new WeakMap();
function pushAnchor(track, i) {
  let cache = anchorCache.get(track);
  if (!cache) { cache = new Map(); anchorCache.set(track, cache); }
  if (!cache.has(i)) {
    const from = track.pushes[i].from;
    cache.set(i, i > 0 ? withPushes(track, from, i) : planAt(track, from));
  }
  return cache.get(i);
}

// Камера с учётом первых limit наездов. Наезд ведёт центр видимого окна исходника и масштаб от
// стартового состояния к цели. Стартовое состояние – камера в этом кадре БЕЗ этого наезда (план с
// дрейфом, покачиванием и панчем или удержание предыдущего наезда), поэтому наезд за наездом
// стартует из удержания, без скачка. Цель – точка исходника под центром рамки элемента в кадре
// начала наезда (экранный бокс переведён в исходник камерой того кадра), с клэмпом окна.
function withPushes(track, frame, limit) {
  const plain = planAt(track, frame);
  const i = activePush(track, frame, limit);
  if (i < 0) return plain;
  const push = track.pushes[i];
  const start = i > 0 ? withPushes(track, frame, i) : plain;
  const anchor = pushAnchor(track, i);
  const { width: W, height: H, face } = track;
  const t = PUSH_EASE(Math.min(1, Math.max(0, (frame - push.from) / push.frames)));
  const target = pushCenter(screenToSource(push.box, anchor, face), { width: W, height: H, k: push.k });
  // Центр окна исходника камеры (s, d) – face + (W/2 − face − d) / s. Окно, которое было внутри
  // исходника, и целевое окно внутри исходника дают окно внутри на каждом промежуточном кадре
  // (край – линейная функция плюс выпуклая 1/s); клэмп ниже – подстраховка от шума. На плане с
  // заливкой (fill) исходное окно может выходить за исходник – края закрывает заливка, пока наезд
  // не дошёл до конца.
  const c0x = face.x + (W / 2 - face.x - start.dx) / start.s;
  const c0y = face.y + (H / 2 - face.y - start.dy) / start.s;
  const sp = start.s + (push.k - start.s) * t;
  let cx = c0x + (target.cx - c0x) * t;
  let cy = c0y + (target.cy - c0y) * t;
  const fill = t >= 1 ? false : start.fill;
  if (!fill) { cx = clampCenter(cx, W, sp); cy = clampCenter(cy, H, sp); }
  return {
    ...plain,
    s: sp,
    // requested/base плавно идут к k: G3 видит наезд как задуманный масштаб, а не «съеденный» панч.
    requested: start.requested + (push.k - start.requested) * t,
    base: start.base + (push.k - start.base) * t,
    dx: W / 2 - face.x - (cx - face.x) * sp,
    dy: H / 2 - face.y - (cy - face.y) * sp,
    fill,
  };
}

// Камера плана без наездов: пресет, дрейф, панчи, покачивание, размытие и уход.
function planAt(track, frame) {
  const cfg = CAMERA_DEFAULTS;
  const fps = track.fps;
  // Все длительности cfg заданы в кадрах эталона 25 fps – переводим в кадры композиции, чтобы
  // ритм дрейфа, панча, размытия и ухода был одинаковым в секундах на любом fps.
  const shot = track.shots.reduce((current, s) => (s.from <= frame ? s : current), track.shots[0]);
  const preset = track.presets[shot.preset];
  const span = Math.max(1, Math.min(shot.to - shot.from, ref25(cfg.drift.maxFrames, fps)));
  const p = DRIFT(Math.min(1, Math.max(0, (frame - shot.from) / span)));
  const grow = shot.drift === 'in' ? p : shot.drift === 'out' ? 1 - p : 0;
  let s = preset.s * (1 + cfg.drift.amp * grow);
  // base – масштаб пресета с дрейфом, ДО панчей и ДО ограничения maxScale: гейт G3 (scripts/qa/
  // timeline-gates.js) читает его, чтобы отличить «пресет сам крупнее предела» от «панч упёрся в
  // потолок» – причину клэмпа нельзя достоверно угадать по форме кривой (ступенька/спираль), а
  // база всегда знает, что было задумано ДО панча.
  const base = s;

  for (const punch of track.punches) {
    // После релиза (until + releaseFrames) множитель панча уже точно равен 1 – не вызываем
    // spring() дальше: Remotion заново проигрывает симуляцию от кадра 0 на каждый вызов, и цикл
    // по всем кадрам до конца ролика делает манифест квадратичным по длине (120 с × 60 fps с
    // одним панчем – секунды вместо десятков мс).
    if (frame < punch.from || frame >= punch.until + ref25(cfg.punch.releaseFrames, fps)) continue;
    // spring() сам переводит кадры в секунды через переданный fps, поэтому реальную скорость
    // подъёма панча масштабировать не нужно – только releaseFrames ниже (это ramp, не spring).
    const on = spring({
      frame: frame - punch.from, fps,
      config: { damping: cfg.punch.damping, stiffness: cfg.punch.stiffness, mass: cfg.punch.mass },
    });
    const off = ramp(frame, punch.until, ref25(cfg.punch.releaseFrames, fps));
    s *= 1 + (punch.k - 1) * on * (1 - off);
  }

  let blur = 0;
  for (const b of track.blurs) {
    if (frame < b.from) continue;
    const inV = b.from === 0 ? 1 : ramp(frame, b.from, ref25(cfg.blur.inFrames, fps));
    const outV = 1 - ramp(frame, b.to, ref25(cfg.blur.outFrames, fps));
    blur = Math.max(blur, b.px * Math.min(inV, outV));
  }

  let gone = 0;
  for (const a of track.aways) {
    gone = Math.max(gone, ramp(frame, a.from, ref25(cfg.away.enterFrames, fps)) * (1 - ramp(frame, a.to, ref25(cfg.away.exitFrames, fps))));
  }
  blur = Math.max(blur, cfg.away.blurPx * gone);

  const requested = s;
  s = Math.min(s, track.maxScale);
  // Период покачивания cfg.sway задан в секундах через кадры при 25 fps – frame * 25 / fps
  // переводит текущий кадр в «кадры на 25 fps», поэтому период колебания одинаков в секундах.
  const sway = cfg.sway.reduce((sum, w) => sum + w.px * track.k * Math.sin(((frame * 25) / fps) / w.period), 0);
  let dx = (shot.dx ?? preset.dx ?? 0) + sway;
  let dy = shot.dy ?? preset.dy ?? 0;
  if (!preset.fill) {
    dx = Math.min((s - 1) * track.face.x, Math.max(-(s - 1) * (track.width - track.face.x), dx));
    dy = Math.min((s - 1) * track.face.y, Math.max(-(s - 1) * (track.height - track.face.y), dy));
  }
  const dim = 1 - (cfg.blur.dim * Math.min(blur, cfg.blur.dimAt)) / cfg.blur.dimAt;
  const opacity = 1 - gone;
  return { s, requested, base, dx, dy, blur, dim, opacity, visible: opacity > 0.01, shot: shot.index, fill: Boolean(preset.fill) };
}

const PUNCT = /[.,!?…:;]$/u;
const SENTENCE_END = /[.!?…]$/u;

// Раскадровка по словам: план не длиннее maxSec, режем по концу слова (по возможности на знаке
// препинания). Молчание без подходящего слова – долгое начало до первой реплики, пауза внутри
// речи, хвост после последнего слова – режем поровну на куски ≤ maxSec, чтобы не оставить план
// длиннее лимита. Рядом с самым концом (ближе minSec к endSec) разрез не ставим, чтобы не оставить
// вспышку короче minSec в последних кадрах.
// Горизонталь (aspect: 'horizontal') – длинный ролик 16:9: лицо не должно мелькать, ритм держит
// графика, а не камера. Поэтому отдельный спокойный режим calmShots: только общий и крупный план.
export const CALM_SHOTS = Object.freeze({ minSec: 8, maxSec: 16, cycle: Object.freeze(['W', 'M']) });

export function autoShots(words, { endSec, aspect, ...options } = {}) {
  if (aspect === 'horizontal') return calmShots(words, { endSec, ...options });
  if (aspect !== undefined && aspect !== 'vertical' && aspect !== 'source') {
    throw new Error(`autoShots: неизвестный aspect «${aspect}» – используй vertical или horizontal`);
  }
  return rhythmShots(words, { endSec, ...options });
}

// Спокойная раскадровка горизонтали: план не короче minSec, смена – только на конце предложения
// (. ! ? …), после maxSec – на любом знаке препинания. Молчание не дробим: пауза на одном плане
// лучше лишней смены крупности. Сдвигов L/R нет – говорящий не прыгает по горизонтали.
// hidden – окна в секундах ({ from, to }), где спикера не видно: полноэкранные вставки и размытие.
// Видимый план считается от выхода спикера из-под окна, иначе смена через 0,3 с после вставки
// мелькает (G17), хотя от прошлой смены прошло больше minSec.
export function calmShots(words, { endSec, minSec = CALM_SHOTS.minSec, maxSec = CALM_SHOTS.maxSec, cycle = CALM_SHOTS.cycle, hidden = [] } = {}) {
  if (!(minSec > 0) || !(maxSec >= minSec) || !Array.isArray(cycle) || !cycle.length) {
    throw new Error('calmShots: нужны minSec > 0, maxSec ≥ minSec и непустой cycle');
  }
  if (!Array.isArray(words)) throw new Error('calmShots: words должен быть массивом слов транскрипта');
  if (!Array.isArray(hidden) || hidden.some((h) => !Number.isFinite(h?.from) || !Number.isFinite(h?.to))) {
    throw new Error('calmShots: hidden – массив окон { from, to } в секундах');
  }
  const list = words.filter((w) => Number.isFinite(w?.e));
  const end = Number.isFinite(endSec) ? endSec : (list.at(-1)?.e ?? 0);
  // Последний выход спикера из-под окна не позже t; смена внутри окна не видна – отсчёт не сбивает.
  const revealedAt = (t) => hidden.reduce((at, h) => (h.to <= t && h.to > at ? h.to : at), 0);
  const shots = [{ at: 0, preset: cycle[0], drift: 'none' }];
  let last = 0;
  for (const word of list) {
    const cut = word.e;
    if (end - cut < minSec) break; // хвост короче minSec не отрезаем
    const since = cut - Math.max(last, revealedAt(cut));
    const text = word.t ?? word.w ?? '';
    if (since >= minSec && (SENTENCE_END.test(text) || (since >= maxSec && PUNCT.test(text)))) {
      shots.push({ at: Number(cut.toFixed(3)), preset: cycle[shots.length % cycle.length], drift: 'none' });
      last = cut;
    }
  }
  return shots;
}

function rhythmShots(words, { endSec, maxSec = 2.2, minSec = 1.2, cycle = ['W', 'M', 'W', 'L', 'W', 'R'] } = {}) {
  // Проверяем ДО цикла split(): maxSec ≤ 0 делает шаг деления на ноль и зацикливает split()
  // навсегда, а не просто выдаёт плохой результат – поэтому это исключение, а не тихий дефолт.
  if (!(maxSec > 0) || !(minSec >= 0) || minSec > maxSec || !Array.isArray(cycle) || !cycle.length) {
    throw new Error('autoShots: нужны maxSec > 0, 0 ≤ minSec ≤ maxSec и непустой cycle');
  }
  if (!Array.isArray(words)) throw new Error('autoShots: words должен быть массивом слов транскрипта');
  const drift = (preset) => (preset === 'W' ? 'in' : 'out');
  const list = words.filter((w) => Number.isFinite(w?.e));
  const end = Number.isFinite(endSec) ? endSec : (list.at(-1)?.e ?? 0);
  const shots = [{ at: 0, preset: cycle[0], drift: drift(cycle[0]) }];
  let last = 0;
  let k = 1;
  const push = (at) => {
    const preset = cycle[k % cycle.length];
    shots.push({ at: Number(at.toFixed(3)), preset, drift: drift(preset) });
    last = at;
    k += 1;
  };
  // Молчание без слова (пауза, хвост, долгое начало) делим на равные куски ≤ maxSec.
  const split = (until) => {
    while (until - last > maxSec + 1e-9) push(last + (until - last) / Math.ceil((until - last) / maxSec - 1e-9));
  };
  for (let i = 0; i < list.length; i += 1) {
    const word = list[i];
    if (Number.isFinite(word.s)) split(Math.min(word.s, end));
    const cut = word.e;
    if (end - cut < minSec) break; // не оставлять вспышку короче minSec в самом конце
    if (cut - last > maxSec) split(cut);
    const next = i + 1 < list.length ? Math.min(list[i + 1].e, end) : end;
    const since = cut - last;
    const urgent = next - last > maxSec;
    // Обычный порог minSec – на паузе или знаке препинания; если иначе план неизбежно
    // превысит maxSec к следующему слову – режем раньше, но не короче половины minSec.
    if ((since >= minSec && (PUNCT.test(word.t ?? word.w) || urgent)) || (urgent && since >= minSec / 2)) push(cut);
  }
  split(end);
  return shots;
}
