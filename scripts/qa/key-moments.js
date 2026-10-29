// Ключевые моменты preview: секунды, по которым лист кадров показывает критику самое важное –
// появление элементов («событие», начало + 0,3 с, когда анимация входа уже читается) и середину
// показа текста («удержание»). Чистый модуль без ffmpeg: источник – манифест motion-kit, иначе
// сцены ТЗ, иначе 16 равномерных кадров.
const { sheetTimes } = require('../layer/sheet');

const EVENT_DELAY_SEC = 0.3;
const MERGE_GAP_SEC = 0.15;
const MAX_MOMENTS = 48;
const EVEN_COUNT = 16;
const MAX_GAP_SEC = 3;
const LABEL_TEXT_MAX = 40;

const r3 = (value) => Math.round(value * 1000) / 1000;
const finite = (value) => typeof value === 'number' && Number.isFinite(value);

// Приводит момент к секундам отрывка; вне [0, durationSec) возвращает null.
function place(timeSec, kind, ref, label, { fromSec, durationSec }) {
  const t = r3(timeSec - fromSec);
  if (t < 0 || (finite(durationSec) && t >= durationSec)) return null;
  return { timeSec: t, kind, ref, label };
}

function momentsFromManifest(manifest, { fromSec = 0, durationSec } = {}) {
  if (!manifest || !finite(manifest.fps) || manifest.fps <= 0) return [];
  const { fps } = manifest;
  const range = { fromSec, durationSec };
  const out = [];
  const add = (moment) => { if (moment) out.push(moment); };
  // Элемент без id получает ссылку по номеру, чтобы подпись не стала «undefined: появление».
  const refOf = (item, prefix, index) => (typeof item.id === 'string' && item.id.trim() ? item.id : `${prefix}-${index + 1}`);
  (Array.isArray(manifest.texts) ? manifest.texts : []).forEach((item, index) => {
    if (!item || !finite(item.from)) return;
    const ref = refOf(item, 'text', index);
    const until = finite(item.until) ? item.until : (Array.isArray(item.frames) ? item.from + item.frames.length : null);
    add(place(item.from / fps + EVENT_DELAY_SEC, 'event', ref, `${ref}: появление`, range));
    if (until !== null && until > item.from) add(place(((item.from + until) / 2) / fps, 'hold', ref, `${ref}: удержание`, range));
  });
  (Array.isArray(manifest.inserts) ? manifest.inserts : []).forEach((insert, index) => {
    if (!insert || !finite(insert.from)) return;
    const ref = refOf(insert, 'insert', index);
    add(place(insert.from / fps + EVENT_DELAY_SEC, 'event', ref, `${ref}: вставка`, range));
  });
  // Наезд камеры на элемент: кадр на конце наезда, когда камера уже стоит на цели.
  const pushes = manifest.camera && Array.isArray(manifest.camera.pushes) ? manifest.camera.pushes : [];
  pushes.forEach((push, index) => {
    if (!push || !finite(push.from)) return;
    const ref = typeof push.target === 'string' && push.target.trim() ? push.target : `push-${index + 1}`;
    add(place((push.from + (finite(push.frames) ? push.frames : 0)) / fps, 'event', ref, `${ref}: наезд`, range));
  });
  const kept = manifest.cues && Array.isArray(manifest.cues.kept) ? manifest.cues.kept : [];
  kept.forEach((cue, index) => {
    if (!cue || cue.notable !== true || !finite(cue.hitFrame)) return;
    const ref = refOf(cue, 'cue', index);
    add(place(cue.hitFrame / fps, 'event', ref, `${ref}: акцент`, range));
  });
  return out;
}

// Текст сцены ТЗ для подписи: у разных сцен он лежит в разных полях.
function sceneText(scene) {
  const parts = [scene.caption, scene.title, scene.text, scene.big, scene.statCream, scene.statOrange,
    scene.quoteCream, scene.quoteOrange, scene.headCream, scene.headOrange];
  return parts.filter((part) => typeof part === 'string' && part.trim()).join(' ').trim().slice(0, LABEL_TEXT_MAX);
}

// Сцены ТЗ лежат в глобальном времени композиции (отрывок preview вырезает кадры fromFrame..toFrame
// из полной сборки), поэтому для отрывка их сдвигают на fromSec, как и моменты манифеста.
function momentsFromBrief(brief, { fromSec = 0, durationSec } = {}) {
  const scenes = brief && Array.isArray(brief.scenes) ? brief.scenes : [];
  const range = { fromSec, durationSec };
  const out = [];
  scenes.forEach((scene, index) => {
    if (!scene || !finite(scene.start) || !finite(scene.end) || scene.end <= scene.start) return;
    const ref = `scenes[${index}]`;
    const label = `${scene.scene} ${sceneText(scene)}`.trim();
    const event = place(scene.start + EVENT_DELAY_SEC, 'event', ref, label, range);
    const hold = place((scene.start + scene.end) / 2, 'hold', ref, label, range);
    if (event) out.push(event);
    if (hold) out.push(hold);
  });
  return out;
}

const RANK = { event: 0, hold: 1, even: 2 };
const rank = (m) => (m.kind in RANK ? RANK[m.kind] : 1);

// Сортировка и слияние близких моментов: при слиянии остаётся событие, затем удержание, затем равномерный кадр.
function mergeClose(moments) {
  const sorted = [...moments].sort((a, b) => a.timeSec - b.timeSec || rank(a) - rank(b));
  const merged = [];
  for (const moment of sorted) {
    const last = merged[merged.length - 1];
    if (last && moment.timeSec - last.timeSec < MERGE_GAP_SEC - 1e-9) {
      if (rank(moment) < rank(last)) merged[merged.length - 1] = moment;
      continue;
    }
    merged.push(moment);
  }
  return merged;
}

// Равномерный выбор count элементов списка по порядку: первый и последний остаются.
function pickEvenly(list, count) {
  if (count >= list.length) return list;
  if (count <= 0) return [];
  if (count === 1) return [list[0]];
  const picked = new Set(Array.from({ length: count }, (_, k) => Math.round((k * (list.length - 1)) / (count - 1))));
  return list.filter((_, i) => picked.has(i));
}

// Прореживание по приоритету: сначала уходят равномерные кадры, затем удержания, события – последними.
// Тип, который не помещается целиком, прореживается равномерно по времени; результат упорядочен по времени.
function thin(list, max) {
  if (list.length <= max) return list;
  const limit = Math.max(0, max);
  const chosen = new Set();
  let left = limit;
  for (const kind of ['event', 'hold', 'even']) {
    const group = list.filter((m) => (m.kind in RANK ? m.kind : 'hold') === kind);
    const taken = pickEvenly(group, left);
    taken.forEach((m) => chosen.add(m));
    left -= taken.length;
  }
  return list.filter((m) => chosen.has(m));
}

function evenMoments(durationSec) {
  return finite(durationSec) && durationSec > 0
    ? sheetTimes(durationSec, EVEN_COUNT).map((timeSec, i) => ({ timeSec, kind: 'even', ref: `even-${i + 1}`, label: `кадр ${i + 1} из ${EVEN_COUNT}` }))
    : [];
}

// Моментов мало или между ними (и от начала/до конца отрывка) дыра больше MAX_GAP_SEC: одна длинная
// сцена (так пишет `layer brief`) иначе дала бы только два кадра на весь ролик.
function needsEven(moments, durationSec) {
  if (moments.length < EVEN_COUNT) return true;
  if (!finite(durationSec)) return false;
  const points = [0, ...moments.map((m) => m.timeSec).sort((a, b) => a - b), durationSec];
  return points.some((t, i) => i > 0 && t - points[i - 1] > MAX_GAP_SEC);
}

function keyMoments({ manifest = null, brief = null, fromSec = 0, manifestOffsetSec = 0, durationSec, max = MAX_MOMENTS } = {}) {
  let moments = momentsFromManifest(manifest, { fromSec: fromSec - manifestOffsetSec, durationSec });
  if (!moments.length) {
    moments = momentsFromBrief(brief, { fromSec, durationSec });
    if (needsEven(moments, durationSec)) moments = [...moments, ...evenMoments(durationSec)];
  }
  return thin(mergeClose(moments), max);
}

module.exports = { keyMoments, momentsFromBrief, momentsFromManifest };
