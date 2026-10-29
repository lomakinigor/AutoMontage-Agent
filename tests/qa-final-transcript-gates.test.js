'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const {
  alignWords, finalTranscriptGates, normalizeWord, FINAL_PAUSE_MAX_SEC, VOICED_GAP_MIN_SEC,
  MISSING_RUN_MIN, EXTRA_RUN_MIN, SINGLE_MISSING_MIN_CHARS, SPANS_MAX,
} = require('../scripts/qa/final-transcript-gates');
const { isFillerWord } = require('../scripts/tighten');

// Слова идут встык с шагом 0,4 с и длиной 0,3 с, если время не задано.
function words(text, start = 0, step = 0.4) {
  return text.split(' ').filter(Boolean).map((w, i) => ({ w, s: start + i * step, e: start + i * step + 0.3 }));
}
const byId = (gates, id) => gates.find((g) => g.id === id);
const run = (expected, actual, extra = {}) => finalTranscriptGates({ expected, actual, voicedGaps: [], ...extra });

test('константы порогов', () => {
  assert.equal(FINAL_PAUSE_MAX_SEC, 1.2);
  assert.equal(VOICED_GAP_MIN_SEC, 0.25);
  assert.equal(MISSING_RUN_MIN, 2);
  assert.equal(EXTRA_RUN_MIN, 2);
  assert.equal(SINGLE_MISSING_MIN_CHARS, 4);
  assert.equal(SPANS_MAX, 10);
});

test('normalizeWord: регистр, ё, знаки', () => {
  assert.equal(normalizeWord(' Ёлка, '), 'елка');
  assert.equal(normalizeWord('...'), '');
});

test('isFillerWord: список из tighten', () => {
  assert.equal(isFillerWord('эм'), true);
  assert.equal(isFillerWord('Короче,'), true);
  assert.equal(isFillerWord('программа'), false);
});

test('alignWords: пропуск, лишнее, совпадение', () => {
  const ops = alignWords(words('раз два три четыре'), words('раз три три четыре'));
  // Два равноценных минимальных выравнивания (лишнее «три» до или после совпавшего): берём любое.
  const count = (k) => ops.filter((o) => o.op === k).length;
  assert.deepEqual([count('same'), count('missing'), count('extra')], [3, 1, 1]);
  assert.equal(ops.find((o) => o.op === 'missing').expected.w, 'два');
  assert.equal(ops.find((o) => o.op === 'extra').actual.w, 'три');
  assert.equal(ops[0].op, 'same');
  assert.equal(ops.at(-1).op, 'same');
});

test('alignWords: пустые входы и сохранение порядка', () => {
  assert.deepEqual(alignWords([], []), []);
  assert.deepEqual(alignWords(words('а б'), []).map((o) => o.op), ['missing', 'missing']);
  assert.deepEqual(alignWords([], words('а б')).map((o) => o.op), ['extra', 'extra']);
});

test('F1 находит «эм» и «короче», игнорирует обычные слова', () => {
  const g = byId(run(words('привет мир'), words('привет эм мир короче'), {}), 'F1');
  assert.equal(g.title, 'Слова-паразиты в финале');
  assert.equal(g.value, 2);
  assert.equal(g.status, 'warn');
  assert.equal(byId(run(words('привет'), words('привет мир')), 'F1').status, 'pass');
});

test('F2: дубль из трёх слов – warn, одно лишнее слово – pass', () => {
  const exp = words('начало конец');
  const dup = words('начало мы пошли домой конец');
  const g = byId(run(exp, dup), 'F2');
  assert.equal(g.status, 'warn');
  assert.equal(g.value, 1);
  assert.equal(byId(run(exp, words('начало мы конец')), 'F2').status, 'pass');
});

test('F3: два пропавших подряд – warn; «и» – pass; «программа» между совпадениями – warn', () => {
  assert.equal(byId(run(words('а б в г'), words('а г')), 'F3').status, 'warn');
  assert.equal(byId(run(words('а и в'), words('а в')), 'F3').status, 'pass');
  const g = byId(run(words('мы программа делаем'), words('мы делаем')), 'F3');
  assert.equal(g.status, 'warn');
  assert.equal(g.value, 1);
});

test('F3: длинный пропавший кусок – в note первые 8 слов и «… (+N)»; F2 note короткий', () => {
  const lost = 'раз два три четыре пять шесть семь восемь девять десять одиннадцать двенадцать';
  const g = byId(run(words(`начало ${lost} конец`), words('начало конец')), 'F3');
  assert.equal(g.status, 'warn');
  assert.equal(g.spans[0].note, 'пропало: «раз два три четыре пять шесть семь восемь … (+4)»');
  assert.equal(byId(run(words('а б в г'), words('а г')), 'F3').spans[0].note, 'пропало: «б в»');
  const extra = byId(run(words('начало конец'), words(`начало ${lost} конец`)), 'F2');
  assert.equal(extra.spans[0].note, 'лишних слов подряд: 12');
});

test('F3: одиночное пропавшее на краю не считается', () => {
  assert.equal(byId(run(words('программа мы делаем'), words('мы делаем')), 'F3').status, 'pass');
});

test('F4: пауза 1,3 с – warn со span 10.0–11.3; пауза 1,1 с – pass', () => {
  const a = [{ w: 'раз', s: 9.5, e: 10.0 }, { w: 'два', s: 11.3, e: 11.8 }];
  const g = byId(run(null, a), 'F4');
  assert.equal(g.status, 'warn');
  assert.equal(g.spans[0].fromSec, 10.0);
  assert.equal(g.spans[0].toSec, 11.3);
  const b = [{ w: 'раз', s: 9.5, e: 10.0 }, { w: 'два', s: 11.1, e: 11.6 }];
  assert.equal(byId(run(null, b), 'F4').status, 'pass');
});

test('F5: два voicedGaps – warn, value 2; null – skipped с причиной', () => {
  const gaps = [{ fromSec: 1, toSec: 1.5 }, { fromSec: 4, toSec: 4.4 }];
  const g = byId(finalTranscriptGates({ expected: null, actual: words('а б'), voicedGaps: gaps }), 'F5');
  assert.equal(g.status, 'warn');
  assert.equal(g.value, 2);
  const s = byId(finalTranscriptGates({ expected: null, actual: words('а б'), voicedGaps: null, skipReasons: { voiced: 'нет ffmpeg' } }), 'F5');
  assert.equal(s.status, 'skipped');
  assert.equal(s.hint, 'нет ffmpeg');
});

test('expected null – F2 и F3 skipped, F1/F4 работают', () => {
  const gates = run(null, words('эм привет'));
  assert.deepEqual(gates.map((g) => g.id), ['F1', 'F2', 'F3', 'F4', 'F5']);
  assert.equal(byId(gates, 'F2').status, 'skipped');
  assert.equal(byId(gates, 'F3').status, 'skipped');
  assert.equal(byId(gates, 'F1').value, 1);
});

test('слово с нулевой длительностью или пустым текстом пропускается без ошибки', () => {
  const actual = [{ w: 'раз', s: 0, e: 0.3 }, { w: '', s: 0.4, e: 0.7 }, { w: 'два', s: 1, e: 1 }, { w: 'три', s: 1.4, e: 1.7 }];
  const gates = run(words('раз три'), actual);
  assert.equal(byId(gates, 'F2').status, 'pass');
  assert.equal(byId(gates, 'F3').status, 'pass');
});

test('spans не больше 10 при 50 находках', () => {
  const actual = [];
  for (let i = 0; i < 50; i += 1) actual.push({ w: 'эм', s: i * 3, e: i * 3 + 0.3 });
  const g = byId(run(null, actual), 'F1');
  assert.equal(g.value, 50);
  assert.equal(g.spans.length, 10);
  assert.equal(byId(run(null, actual), 'F4').spans.length, 10);
});

test('F2/F3 спаны – по времени финала; пропавшее слово берёт время соседа', () => {
  const g = byId(run(words('а б в г'), words('а г', 0, 5)), 'F3');
  assert.equal(g.spans.length, 1);
  assert.equal(g.spans[0].fromSec, 0.3);
  assert.equal(g.spans[0].toSec, 5);
});

test('6000 × 6000 слов выравниваются быстрее 2 с', () => {
  const n = 6000;
  const exp = [];
  for (let i = 0; i < n; i += 1) exp.push({ w: `сл${i}`, s: i, e: i + 0.5 });
  const act = exp.filter((_, i) => i % 500 !== 7).map((x) => ({ ...x }));
  act.splice(3000, 0, { w: 'лишнее', s: 3000, e: 3000.5 });
  const t0 = performance.now();
  const ops = alignWords(exp, act);
  const ms = performance.now() - t0;
  assert.ok(ms < 2000, `заняло ${ms} мс`);
  assert.equal(ops.filter((o) => o.op === 'missing').length, 12);
  assert.equal(ops.filter((o) => o.op === 'extra').length, 1);
});
