# ТОП-3 / 2. Повторная расшифровка готового ролика – Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** После сборки финала движок сам заново расшифровывает готовый файл локальным Whisper и пишет отчёт: оставшиеся слова-паразиты, лишние куски (дубли), пропавшие или обрезанные слова, длинные паузы и звук без слов (вздохи) – чтобы агент ловил такое до показа Дмитрию.

**Architecture:** Чистый модуль гейтов `scripts/qa/final-transcript-gates.js` сравнивает слова финала с ожидаемыми словами проекта (активная расшифровка уже лежит на таймлайне финала) и возвращает гейты в принятом формате `gate()` из `scripts/qa/report.js`. Раннер `scripts/qa/final-qa.js` извлекает звук, вызывает `transcribe.py`, меряет громкость, собирает отчёт `qa/final-<stamp>.json/.txt`. Отчёт только предупреждает: финал не блокируется. `build.js` вызывает раннер в конце рендера (урок и dynamic), есть флаг отключения и отдельная CLI-команда.

**Tech Stack:** Node.js 20 (CommonJS), `node:test`, Python faster-whisper через существующий `scripts/transcribe.py`, ffmpeg.

**Spec:** программа доработок, пункт 4 (память проекта `engine-upgrade-program`) + правка Дмитрия «вздох на 4:03» в ролике Jev (2026-10-17), которую движок сам не поймал.

## Global Constraints

- Ветка `feat/top3-final-transcript` от `main` в отдельном worktree.
- Тяжёлые прогоны (Whisper, ffmpeg по реальному ролику) – только на Mac; на сервере – юнит-тесты с заглушками.
- Модель по умолчанию `large-v3-turbo`, как в `build.js:139`; облачная расшифровка запрещена.
- Все новые гейты – статус `warn` или `pass`, никогда `fail`: финал публикуется в любом случае. Ошибка раннера пишется в лог и в отчёт (`error`), рендер не падает.
- Пороги (константы в `final-transcript-gates.js`): `FINAL_PAUSE_MAX_SEC = 1.2`, `VOICED_GAP_MIN_SEC = 0.25`, `MISSING_RUN_MIN = 2`, `EXTRA_RUN_MIN = 2`, `SINGLE_MISSING_MIN_CHARS = 4`, `SPANS_MAX = 10`.
- Слова-паразиты – только существующий список `FILLER` из `scripts/tighten.js:12`, без второй копии.
- В режиме `lessonAction === 'render'` переменная `PY` равна `null` (`build.js:137`) – раннер сам получает интерпретатор через `python()`.
- Имя отчёта соответствует `/^[a-z0-9][a-z0-9._-]{0,80}$/` (`writeReport`).
- Документы по-русски, без U+2014. Push и PR – только по «да» Дмитрия.

## Review Focus

1. Ролик без активной расшифровки (`--no-transcribe`, пустой `[]`) – ожидается гейты сравнения `skipped` с причиной, паузы и вздохи всё равно проверяются. Тест в Task 1.
2. Whisper вернул слово с нулевой длительностью или пустым текстом – не падать, слово пропускается. Тест в Task 1.
3. Длинный урок (24 мин, около 6000 слов с каждой стороны) – сравнение укладывается в 2 с и не съедает память. Тест производительности в Task 1.
4. В финале подмешана музыка, и между словами она звучит громко – вздохи не должны сыпаться на каждую паузу: громкость считается относительно порога `analyzeLevels`, а для роликов с музыкой (`prepared.music`) гейт вздохов получает `skipped` с причиной «музыка мешает замеру». Тест в Task 2.
5. Раннер упал (нет python, битый файл) – финал всё равно опубликован, в логе понятная строка, отчёт с `error`. Тест в Task 2.

---

### Task 1: Чистые гейты сравнения финала

**Files:**
- Modify: `scripts/tighten.js` (экспортировать `FILLER` и `isFillerWord(word: string) -> boolean`, поведение tighten не меняется)
- Create: `scripts/qa/final-transcript-gates.js`
- Test: `tests/qa-final-transcript-gates.test.js`

**Interfaces:**
- Consumes: `gate(id, title, fields)` из `scripts/qa/report.js`.
- Produces:
  - `normalizeWord(w: string) -> string` – нижний регистр, `ё→е`, без пробелов и знаков препинания.
  - `alignWords(expected: Word[], actual: Word[]) -> Array<{op: 'same'|'missing'|'extra', expected?: Word, actual?: Word}>`, где `Word = {w: string, s: number, e: number}`; по нормализованным словам, порядок сохраняется.
  - `finalTranscriptGates({expected: Word[] | null, actual: Word[], voicedGaps: Array<{fromSec, toSec}> | null, skipReasons?: {voiced?: string}}) -> Gate[]` – ровно пять гейтов в порядке:
    - `F1 'Слова-паразиты в финале'` – слова `actual`, для которых `isFillerWord`;
    - `F2 'Лишние куски (дубли)'` – подряд идущие `extra` длиной не меньше `EXTRA_RUN_MIN`;
    - `F3 'Пропавшие и обрезанные слова'` – подряд идущие `missing` длиной не меньше `MISSING_RUN_MIN`, плюс одиночное `missing` длиной не меньше `SINGLE_MISSING_MIN_CHARS` букв между двумя `same`;
    - `F4 'Длинные паузы'` – промежуток между соседними словами `actual` больше `FINAL_PAUSE_MAX_SEC`;
    - `F5 'Звук без слов (вздохи)'` – каждый элемент `voicedGaps`.
  - У каждого гейта `spans` – не больше `SPANS_MAX`, `{fromSec, toSec, note}` по времени финала; `value` – общее число находок; `status` – `warn` при находках, иначе `pass`; `expected === null` → F2 и F3 `skipped`; `voicedGaps === null` → F5 `skipped` с `hint` из `skipReasons.voiced`.

- [ ] **Step 1: Write the failing tests**

```js
test('alignWords: пропуск, лишнее, совпадение', () => {
  const ops = alignWords(words('раз два три четыре'), words('раз три три четыре'));
  assert.deepEqual(ops.map(o => o.op), ['same', 'missing', 'same', 'extra', 'same']); // или эквивалентное минимальное выравнивание
});
test('F1 находит «эм» и «короче», игнорирует обычные слова', ...);         // value === 2
test('F2: дубль из трёх слов – warn, одно лишнее слово – pass', ...);
test('F3: пропали два слова подряд – warn; пропало «и» – pass; пропало «программа» между совпадениями – warn', ...);
test('F4: пауза 1,3 с – warn со span 10.0–11.3; пауза 1,1 с – pass', ...);
test('F5: два voicedGaps – warn, value 2; voicedGaps null – skipped с причиной', ...);
test('expected null – F2 и F3 skipped, F1/F4 работают', ...);
test('слово с нулевой длительностью или пустым текстом пропускается без ошибки', ...);
test('6000 × 6000 слов выравниваются быстрее 2 с', ...);              // performance.now()
test('spans не больше 10 при 50 находках', ...);
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/qa-final-transcript-gates.test.js`
Expected: FAIL – `Cannot find module '../scripts/qa/final-transcript-gates'`.

- [ ] **Step 3: Implement** `normalizeWord`, `alignWords`, `finalTranscriptGates` и экспорт `FILLER`/`isFillerWord` из `tighten.js`. Выравнивание – алгоритм Майерса O(ND) по массивам нормализованных слов (LCS-таблица 6000×6000 не проходит по памяти); новых зависимостей не добавлять.

- [ ] **Step 4: Run tests**

Run: `node --test tests/qa-final-transcript-gates.test.js tests/tighten.test.js`
Expected: PASS (если отдельного теста tighten нет – запустить `tests/*tighten*` и `tests/rough-cut.test.js`).

- [ ] **Step 5: Commit**

```bash
git add scripts/tighten.js scripts/qa/final-transcript-gates.js tests/qa-final-transcript-gates.test.js
git commit -m "feat(qa): гейты сравнения расшифровки финала"
```

### Task 2: Раннер финального QA, подключение к build.js и CLI

**Files:**
- Create: `scripts/qa/final-qa.js`
- Modify: `scripts/build.js` (перед `return outMp4L` ~строка 498 и перед `return outMp4` ~строка 713; флаг `--no-final-qa`)
- Modify: `scripts/cli.js` (команда `automontage qa-final <projectDir> [--final <path>] [--model <name>]`, по образцу ветки `clean` ~строка 227, плюс строка в справке ~65)
- Modify: `skills/reel-turnkey/references/qa-checklist.md` (после финала прочитать `qa/final-*.txt`; каждую находку исправить или объяснить Дмитрию до показа)
- Modify: `CHANGELOG.md` (`[Unreleased]` → `### Добавлено`)
- Test: `tests/qa-final.test.js`

**Interfaces:**
- Consumes: `finalTranscriptGates`, `normalizeWord` (Task 1); `transcribeTakeFile({videoPath, model, prompt}, deps)` из `scripts/project/takes.js:114`; `readTakeLevels(filePath, deps)`, `analyzeLevels`, `isSilentSpan(analysis, start, end)` из `scripts/project/take-pauses.js`; `collectWords(segments)` из `scripts/tighten.js`; `buildReport`, `formatReport`, `writeReport` из `scripts/qa/report.js`.
- Produces (их использует план ТОП-3 / 3):
  - `FINAL_CHECKS` – массив проверок; проверка = `{id: string, run: (ctx) => Promise<Gate[]>}`, где `ctx = {projectDir, finalPath, manifest, hasMusic, model, deps}`. В этом плане одна проверка `{id: 'transcript', run: transcriptCheck}`.
  - `runFinalQa({projectDir, finalPath, hasMusic = false, model = 'large-v3-turbo', write = true, now = new Date(), checks = FINAL_CHECKS}, deps = {}) -> Promise<{report, paths: {json, txt} | null}>` – отчёт `kind: 'final'`, имя `final-<YYYYMMDD-HHMMSS>`.
  - `maybeRunFinalQa({enabled, projectDir, finalPath, hasMusic, log}, deps) -> Promise<void>` – ничего не бросает: печатает `formatReport(report)`, при исключении печатает `final QA не выполнен: <сообщение>`.
  - `readExpectedWords(projectDir, manifest) -> Word[] | null` – слова активной расшифровки (`manifest.transcript.words`) через `collectWords`; файла нет или он пуст → `null`.
  - `findVoicedGaps(words: Word[], analysis, minSec = VOICED_GAP_MIN_SEC) -> Array<{fromSec, toSec}>` – промежутки между словами длиннее `minSec`, где `isSilentSpan` вернул `false`.

- [ ] **Step 1: Write the failing tests** (все тяжёлые шаги – заглушки через `deps`):

```js
test('runFinalQa: пишет qa/final-<stamp>.json и .txt с пятью гейтами F1–F5', async () => {
  // deps.transcribeImpl => сегменты с «эм» и паузой 1,5 с; deps.readLevelsImpl => тишина
  // assert: report.kind === 'final', gates ids ['F1','F2','F3','F4','F5'], F1.status === 'warn', F4.status === 'warn'
});
test('без активной расшифровки F2/F3 skipped', ...);
test('hasMusic: F5 skipped с причиной «музыка мешает замеру»', ...);
test('findVoicedGaps: громкий промежуток 0,4 с между словами – находка; тихий – нет; 0,2 с – нет', ...);
test('maybeRunFinalQa: transcribeImpl бросает – не бросает дальше, в лог строка «final QA не выполнен»', ...);
test('maybeRunFinalQa: enabled false – transcribeImpl не вызывается', ...);
test('cli qa-final без projectDir – код 2 и подсказка', ...);
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/qa-final.test.js`
Expected: FAIL – модуль не найден.

- [ ] **Step 3: Implement `scripts/qa/final-qa.js`**, затем в `build.js` в обоих местах вызвать `maybeRunFinalQa({enabled: !flag('no-final-qa'), projectDir: buildContext.project && buildContext.project.dir, finalPath: outMp4L /* outMp4 */, hasMusic: Boolean(prepared.music), log})` до `return` (внутри тяжёлого слота, до публикации финала). Без проекта (`buildContext.project` пуст) отчёт пишется рядом с финалом в `qa/` его папки. В `cli.js` – команда `qa-final`.

- [ ] **Step 4: Run tests**

Run: `node --test tests/qa-final.test.js tests/qa-final-transcript-gates.test.js tests/qa-report.test.js tests/lesson-preview.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/qa/final-qa.js scripts/build.js scripts/cli.js skills/reel-turnkey/references/qa-checklist.md CHANGELOG.md tests/qa-final.test.js
git commit -m "feat(qa): повторная расшифровка финала после сборки"
```

### Task 3: Проверка на ролике Jev (Mac)

**Files:** нет изменений в коде, если проверка не нашла ошибок.

- [ ] **Step 1:** После мержа (по «да» Дмитрия) `git pull --ff-only` на Mac.
- [ ] **Step 2:** `node scripts/cli.js qa-final projects/2026.10.16_jev-codex-prep --final projects/2026.10.16_jev-codex-prep/final/jev-codex-obzor.mp4` на Mac, засечь время.
- [ ] **Step 3:** Сверить отчёт с известным: «вздох на 4:03» был исправлен в v02 – в F5 его быть не должно; проверить 3 случайные находки на слух по таймкодам. Если ложных находок больше половины – поднять пороги в константах отдельным коммитом и повторить.
- [ ] **Step 4:** Отчёт Дмитрию: время прогона, число находок по гейтам, примеры с таймкодами.
