// Гейты F1–F5 «Расшифровка финала» – чистое сравнение того, что должно звучать (слова активной
// расшифровки проекта, manifest.transcript.words), с тем, что расшифровано из готового MP4. Модуль не читает файлы и не
// запускает процессы; расшифровку и поиск звука между словами делает отдельный раннер.
// Все гейты дают только pass или warn (skipped – когда нет данных для сравнения): финал
// публикуется в любом случае, гейты лишь подсказывают, куда послушать.
'use strict';
const { gate } = require('./report');
const { isFillerWord } = require('../tighten');

const FINAL_PAUSE_MAX_SEC = 1.2;
const VOICED_GAP_MIN_SEC = 0.25;
const MISSING_RUN_MIN = 2;
const EXTRA_RUN_MIN = 2;
const SINGLE_MISSING_MIN_CHARS = 4;
const SPANS_MAX = 10;
// Сколько слов пропавшего куска показывать в note: длинный обрыв не должен раздувать отчёт.
const NOTE_WORDS_MAX = 8;
// Предел расстояния правок для точного выравнивания: трасса Майерса хранит копию массива
// диагоналей на каждом шаге, это O(D·limit) памяти (D – найденное расстояние, limit – этот предел).
// Если тексты расходятся сильнее, середина считается «всё пропало, всё лишнее» – это и так
// сигнал «финал не тот», подробности по словам уже не нужны.
const MAX_EDIT_DISTANCE = 3000;

const ru = (value) => String(Math.round(value * 100) / 100).replace('.', ',');

function normalizeWord(w) {
  return String(w ?? '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, '');
}

// Слова без текста или без длительности (нулевой/отрицательной) не участвуют в выравнивании.
function usableWords(list) {
  return (Array.isArray(list) ? list : [])
    .filter((x) => x && Number.isFinite(x.s) && Number.isFinite(x.e) && x.e > x.s && normalizeWord(x.w))
    .map((x) => ({ word: x, key: normalizeWord(x.w) }));
}

// Алгоритм Майерса O(ND) по нормализованным ключам; возвращает операции в порядке текста.
function myersOps(a, b) {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const limit = Math.min(max, MAX_EDIT_DISTANCE);
  const offset = limit + 1;
  let v = new Int32Array(2 * offset + 2);
  const trace = [];
  let found = -1;
  for (let d = 0; d <= limit && found < 0; d += 1) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x += 1; y += 1; }
      v[offset + k] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
  }
  if (found < 0) return null;
  const ops = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d -= 1) {
    const pv = trace[d];
    const k = x - y;
    const down = k === -d || (k !== d && pv[offset + k - 1] < pv[offset + k + 1]);
    const pk = down ? k + 1 : k - 1;
    const px = pv[offset + pk];
    const py = px - pk;
    while (x > px && y > py) { x -= 1; y -= 1; ops.push(['same', x, y]); }
    if (down) { y -= 1; ops.push(['extra', x, y]); } else { x -= 1; ops.push(['missing', x, y]); }
  }
  while (x > 0 && y > 0) { x -= 1; y -= 1; ops.push(['same', x, y]); }
  return ops.reverse();
}

function alignWords(expected, actual) {
  const e = usableWords(expected);
  const a = usableWords(actual);
  // Общие начало и конец отрезаем сразу: у почти одинаковых текстов остаётся маленькая середина.
  let head = 0;
  while (head < e.length && head < a.length && e[head].key === a[head].key) head += 1;
  let tail = 0;
  while (tail < e.length - head && tail < a.length - head && e[e.length - 1 - tail].key === a[a.length - 1 - tail].key) tail += 1;
  const eMid = e.slice(head, e.length - tail);
  const aMid = a.slice(head, a.length - tail);
  const result = [];
  for (let i = 0; i < head; i += 1) result.push({ op: 'same', expected: e[i].word, actual: a[i].word });
  const raw = myersOps(eMid.map((x) => x.key), aMid.map((x) => x.key))
    || [...eMid.map((_, i) => ['missing', i, 0]), ...aMid.map((_, j) => ['extra', 0, j])];
  for (const [op, i, j] of raw) {
    if (op === 'same') result.push({ op, expected: eMid[i].word, actual: aMid[j].word });
    else if (op === 'missing') result.push({ op, expected: eMid[i].word });
    else result.push({ op, actual: aMid[j].word });
  }
  for (let t = tail; t > 0; t -= 1) result.push({ op: 'same', expected: e[e.length - t].word, actual: a[a.length - t].word });
  return result;
}

// Подряд идущие операции одного вида: [{from, to}] – индексы в ops, включительно.
function runsOf(ops, kind) {
  const runs = [];
  let start = -1;
  for (let i = 0; i <= ops.length; i += 1) {
    const hit = i < ops.length && ops[i].op === kind;
    if (hit && start < 0) start = i;
    if (!hit && start >= 0) { runs.push({ from: start, to: i - 1 }); start = -1; }
  }
  return runs;
}

// Время финала для пропавшего слова: у него своего времени в финале нет, поэтому берём конец
// ближайшего слева слова финала и начало ближайшего справа (на краю – то, что есть с одной стороны).
function missingSpan(ops, run) {
  let left = null;
  for (let i = run.from - 1; i >= 0; i -= 1) if (ops[i].actual) { left = ops[i].actual; break; }
  let right = null;
  for (let i = run.to + 1; i < ops.length; i += 1) if (ops[i].actual) { right = ops[i].actual; break; }
  const fromSec = left ? left.e : (right ? right.s : 0);
  const toSec = right ? right.s : fromSec;
  return { fromSec, toSec: Math.max(fromSec, toSec) };
}

function shortText(list) {
  const head = list.slice(0, NOTE_WORDS_MAX).join(' ');
  return list.length > NOTE_WORDS_MAX ? `${head} … (+${list.length - NOTE_WORDS_MAX})` : head;
}

function result(id, title, findings, threshold, hint) {
  return gate(id, title, {
    status: findings.length ? 'warn' : 'pass',
    value: findings.length,
    unit: 'шт.',
    threshold,
    spans: findings.slice(0, SPANS_MAX),
    hint: findings.length ? hint : '',
  });
}

function skipped(id, title, hint) {
  return gate(id, title, { status: 'skipped', hint });
}

function finalTranscriptGates({ expected, actual, voicedGaps, skipReasons = {} } = {}) {
  const act = usableWords(actual).map((x) => x.word);
  const gates = [];

  const fillers = act.filter((w) => isFillerWord(String(w.w).trim()))
    .map((w) => ({ fromSec: w.s, toSec: w.e, note: `слово-паразит «${String(w.w).trim()}»` }));
  gates.push(result('F1', 'Слова-паразиты в финале', fillers, 'слов-паразитов нет',
    'послушайте эти места: паразит остался в речи или попал из шва склейки'));

  if (expected == null) {
    const why = 'нет текста для сравнения';
    gates.push(skipped('F2', 'Лишние куски (дубли)', why), skipped('F3', 'Пропавшие и обрезанные слова', why));
  } else {
    const ops = alignWords(expected, act);
    const extras = runsOf(ops, 'extra').filter((r) => r.to - r.from + 1 >= EXTRA_RUN_MIN)
      .map((r) => ({ fromSec: ops[r.from].actual.s, toSec: ops[r.to].actual.e, note: `лишних слов подряд: ${r.to - r.from + 1}` }));
    gates.push(result('F2', 'Лишние куски (дубли)', extras, `лишних слов подряд меньше ${EXTRA_RUN_MIN}`,
      'в финале звучит текст, которого нет в утверждённом тексте: возможен повтор дубля'));
    const lost = [];
    for (const r of runsOf(ops, 'missing')) {
      const len = r.to - r.from + 1;
      const single = len === 1
        && r.from > 0 && r.to < ops.length - 1
        && ops[r.from - 1].op === 'same' && ops[r.to + 1].op === 'same'
        && normalizeWord(ops[r.from].expected.w).length >= SINGLE_MISSING_MIN_CHARS;
      if (len >= MISSING_RUN_MIN || single) {
        const text = shortText(ops.slice(r.from, r.to + 1).map((o) => o.expected.w));
        lost.push({ ...missingSpan(ops, r), note: `пропало: «${text}»` });
      }
    }
    gates.push(result('F3', 'Пропавшие и обрезанные слова', lost,
      `подряд пропавших слов меньше ${MISSING_RUN_MIN}, одиночных длиннее ${SINGLE_MISSING_MIN_CHARS - 1} букв нет`,
      'слово из утверждённого текста не расслышано в финале: возможно, обрезано монтажом'));
  }

  const pauses = [];
  for (let i = 1; i < act.length; i += 1) {
    const gap = act[i].s - act[i - 1].e;
    if (gap > FINAL_PAUSE_MAX_SEC) pauses.push({ fromSec: act[i - 1].e, toSec: act[i].s, note: `пауза ${ru(gap)} с` });
  }
  gates.push(result('F4', 'Длинные паузы', pauses, `пауза между словами не больше ${ru(FINAL_PAUSE_MAX_SEC)} с`,
    'длинная тишина между словами: возможно, остался невырезанный кусок'));

  if (voicedGaps == null) {
    gates.push(skipped('F5', 'Звук без слов (вздохи)', skipReasons.voiced || 'не удалось проверить звук между словами'));
  } else {
    const gaps = voicedGaps.filter((g) => g && Number.isFinite(g.fromSec) && Number.isFinite(g.toSec))
      .map((g) => ({ fromSec: g.fromSec, toSec: g.toSec, note: `звук без слов ${ru(g.toSec - g.fromSec)} с` }));
    gates.push(result('F5', 'Звук без слов (вздохи)', gaps, `звук без слов короче ${ru(VOICED_GAP_MIN_SEC)} с`,
      'между словами слышен голос без слов: вздох, чмокание или обрывок слова'));
  }
  return gates;
}

module.exports = {
  EXTRA_RUN_MIN, FINAL_PAUSE_MAX_SEC, MISSING_RUN_MIN, NOTE_WORDS_MAX, SINGLE_MISSING_MIN_CHARS, SPANS_MAX, VOICED_GAP_MIN_SEC,
  alignWords, finalTranscriptGates, normalizeWord,
};
