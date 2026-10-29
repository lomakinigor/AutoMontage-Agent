# Агент-критик и лист ключевых кадров – Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Перед показом preview Дмитрию его оценивает отдельный агент-критик по кадрам ключевых моментов; сборщик исправляет три худшие сцены и перерендеривает, пока оценка не дойдёт до 9 или не перестанет расти (не больше 3 кругов).

**Architecture:** (1) Чистый модуль `scripts/qa/key-moments.js` выводит моменты из манифеста motion-kit (`motion-vNN/out/manifest.json`) или из сцен ТЗ (`currentPreview.briefPath`). (2) `automontage layer sheet --mode moments` по этим моментам режет кадры текущего preview: отдельные кадры для критика, лист 4×N и тот же лист в ширину телефона 360 px, плюс индекс JSON. (3) Задание критику – канонический документ `skills/reel-turnkey/references/motion-critic.md` и определение субагента `.claude/agents/motion-critic.md` (только чтение). (4) `automontage critic` проверяет JSON-отчёт критика по схеме, сохраняет `qa/critic-<NN>.json|txt` и печатает решение: исправлять три худшие сцены или остановиться. (5) Шаг проверки preview в motion-скиллах дополняется циклом критика.

**Tech Stack:** Node.js 20 (CommonJS), `node:test`, ffmpeg, JSON Schema (как в `schema/`).

**Spec:** программа доработок, пункты 1 и 7 (память проекта `engine-upgrade-program`; источники идей – claude-motion-design, animate, промпт студии моушна Дмитрия); решение Дмитрия 2026-10-18 делать эту доработку первой из нового ТОП-3.

## Global Constraints

- Ветка `feat/motion-critic` от `origin/main` (v1.17.0) в отдельном worktree; основную папку проекта не трогать – там работают сессии монтажа.
- Цикл критика – только для маршрутов Creative Motion: reel-turnkey, motion-reel, reel-from-donor, ai-promo. Lesson (длинные уроки) не затрагивается.
- Критик только читает: инструменты `Read`, `Glob`, `Grep`; никаких правок и рендеров. Правит и рендерит сборщик.
- Пять осей оценки, ключи ровно такие: `idea` (мысль понятна без звука), `composition`, `motion`, `typography`, `rhythm`; целые 1–10.
- Оценка сцены – среднее пяти осей, округление до 0,1. Общая оценка круга – среднее оценок сцен, до 0,1.
- Остановка: общая ≥ 9 и ни одной сцены ниже 7; или круг 3; или рост общей меньше 0,3 к прошлому кругу. Иначе – исправить 3 сцены с наименьшей оценкой (при равенстве – более ранняя).
- Момент «событие» – начало элемента + 0,3 с; «удержание» – середина показа текста. Моменты ближе 0,15 с друг к другу сливаются; не больше 48 моментов.
- Ширина кадров: для критика 720 px по длинной стороне; лист – 270 px (портрет) / 480 px (ландшафт), как у `thumbWidth`; телефонный лист – 360 px по ширине кадра.
- Отчёт критика привязан к `currentPreview.sha256`; отчёт к другому preview отклоняется.
- Документы по-русски, без U+2014, без личных абсолютных путей. Копии motion-reel в `.agents/` и `.codex/` – байт-в-байт с каноном.
- Тяжёлые прогоны на реальных роликах – только на Mac и только на коротком ролике. Push, PR, merge, релиз – по правилам проекта после зелёного CI.

## Review Focus

1. Preview – отрывок (`currentPreview.fromSec > 0`): моменты из манифеста слоя должны сдвигаться на `fromSec`, а вне отрывка – отбрасываться. Тест в Task 1.
2. У маршрута нет манифеста и у ТЗ нет сцен (пустой `scenes`) – не падать: 16 равномерных моментов (`sheetTimes`) с `kind: 'even'`. Тест в Task 1.
3. Критик вернул оценку 0, 11, дробь или пропустил ось – отчёт отклоняется с понятной ошибкой, решение не печатается. Тест в Task 3.
4. Отчёт сохранён для старого preview, а сборщик уже перерендерил – `automontage critic` отклоняет его по `sha256`. Тест в Task 3.
5. Две сцены с одинаковой худшей оценкой и меньше трёх сцен всего – `worst` содержит все сцены ниже порога, без дублей и без падения. Тест в Task 3.

---

### Task 1: Ключевые моменты (чистый модуль)

**Files:**
- Create: `scripts/qa/key-moments.js`
- Test: `tests/qa-key-moments.test.js`

**Interfaces:**
- Consumes: `sheetTimes(duration, n)` из `scripts/layer/sheet.js`.
- Produces:
  - `Moment = {timeSec: number, kind: 'event'|'hold'|'even', ref: string, label: string}`; `ref` – id элемента плана (`title-2`, `caption-3`, `insert-1`) или `scenes[i]` для ТЗ.
  - `momentsFromManifest(manifest, {fromSec = 0, durationSec}) -> Moment[]` – события: `texts[].from`, `inserts[].from`, `cues.kept[]` с `notable: true` (`hitFrame`); удержания: середина `[from, until]` у текстов (`until = from + frames.length`, у субтитров – поле `until`). Кадры → секунды через `manifest.fps`, минус `fromSec`, только внутри `[0, durationSec)`.
  - `momentsFromBrief(brief, {durationSec}) -> Moment[]` – по `brief.scenes[i]`: событие `start + 0.3`, удержание – середина `[start, end]`, `label` = `scene` + первые 40 символов текста/заголовка.
  - `keyMoments({manifest = null, brief = null, fromSec = 0, durationSec, max = 48}) -> Moment[]` – манифест в приоритете, иначе ТЗ, иначе `sheetTimes(durationSec, 16)` с `kind: 'even'`; сортировка, слияние ближе 0,15 с (остаётся `event`), обрезка до `max` с равномерным прореживанием.

- [ ] **Step 1: Write the failing tests** – по манифесту из `tests/helpers/manifest-fixtures.js` (`manifestFixture`): событие `title-1` с `from: 25` при fps 25 → `timeSec 1.3`; удержание текста `from 25`, 50 кадров → `2.0`; отрывок `fromSec: 1` → `0.3` и `1.0`, элемент до отрывка отброшен; ТЗ из двух сцен `0–3`, `3–6` → `[0.3, 1.5, 3.3, 4.5]`; пустые `scenes` → 16 моментов `even`; два момента 1.30 и 1.40 → один; 100 текстов → 48 моментов, по возрастанию.

- [ ] **Step 2: Run** `node --test tests/qa-key-moments.test.js` – FAIL, модуль не найден.

- [ ] **Step 3: Implement** три функции в `scripts/qa/key-moments.js`.

- [ ] **Step 4: Run** `nice -n 10 node --test tests/qa-key-moments.test.js tests/layer-sheet.test.js` – PASS.

- [ ] **Step 5: Commit** `feat(qa): ключевые моменты preview для листа кадров`.

### Task 2: `layer sheet --mode moments` – кадры, листы и индекс

**Files:**
- Modify: `scripts/layer/sheet.js` (флаг `mode` со значениями `even` (по умолчанию, текущее поведение) и `moments`; новая функция сборки)
- Modify: `scripts/layer/cli.js:13` (строка справки)
- Test: `tests/layer-sheet-moments.test.js`

**Interfaces:**
- Consumes: `keyMoments` (Task 1); `thumb`, `thumbWidth`, `probeMediaPath`, `projectFrom` из текущего `sheet.js`; `readCheckedManifest` из `scripts/layer/render.js` – экспортировать его.
- Produces:
  - `buildMomentSheet({videoPath, width, height, duration, fps, moments, outDir, name, log}) -> {sheetPath, phonePath, framesDir, indexPath, gate}`:
    - `framesDir = <outDir>/<name>/`, кадры `NN-<timeSec>.jpg` 720 px по длинной стороне, без рамки безопасной зоны;
    - `sheetPath = <outDir>/<name>.jpg` – плитка 4 колонки с рамкой безопасной зоны (как текущий лист);
    - `phonePath = <outDir>/<name>-phone.jpg` – те же кадры шириной 360 px, 4 колонки;
    - `indexPath = <outDir>/<name>.json` – `{version: 1, previewSha256, moments: [{file, timeSec, kind, ref, label}]}`, `file` – путь относительно папки проекта;
    - `gate` – G12 по этим кадрам (как в `buildSheet`).
  - В режиме `moments` `run` берёт манифест слоя через `readCheckedManifest`, если `currentPreview.kind` – слой motion-kit; иначе ТЗ из `currentPreview.briefPath`; имя `moments-<sha256[:8]>`; печатает пути и отчёт G12.

- [ ] **Step 1: Write the failing tests** (`{ skip: !hasFfmpeg }`, проект через `tests/helpers/layer-project.js`): 3 момента → 3 файла в `framesDir`, ширина кадра 720 (ffprobe), `phonePath` шириной 360 × 4 колонки ≤ 1440, индекс содержит `previewSha256` и 3 записи с относительными путями; `--mode even` даёт прежний `sheet-<sha8>.jpg`; неизвестный `--mode x` – код 2 и подсказка; моменты в последней доле секунды не выходят за длительность.

- [ ] **Step 2: Run** `node --test tests/layer-sheet-moments.test.js` – FAIL.

- [ ] **Step 3: Implement** `buildMomentSheet`, режим в `run`, экспорт `readCheckedManifest`, строку справки.

- [ ] **Step 4: Run** `nice -n 10 node --test tests/layer-sheet-moments.test.js tests/layer-sheet.test.js tests/layer-render.test.js` – PASS (если `tests/layer-render.test.js` нет – соседние `tests/layer-*.test.js`).

- [ ] **Step 5: Commit** `feat(layer): лист ключевых моментов и телефонная ширина`.

### Task 3: Отчёт критика – схема, проверка, решение и CLI

**Files:**
- Create: `schema/critic-report.schema.json`
- Create: `scripts/qa/critic.js`
- Modify: `scripts/cli.js` (команда `automontage critic --project-dir <папка> --report <файл.json>` и строка справки)
- Test: `tests/qa-critic.test.js`

**Interfaces:**
- Consumes: `writeReport` из `scripts/qa/report.js` (имя `critic-<NN>`), `readProjectManifest` (как в `sheet.js`).
- Produces:
  - Отчёт критика: `{version: 1, round: 1..3, previewSha256: string, scenes: [{ref, fromSec, toSec, scores: {idea, composition, motion, typography, rhythm}, issues: [{text, fix}]}], summary: string}`; `issues` у сцены с оценкой ниже 9 – минимум 1.
  - `validateCriticReport(report) -> {ok: boolean, errors: string[]}` – проверка по схеме и правилам из Global Constraints.
  - `sceneScore(scene) -> number`, `overallScore(report) -> number`.
  - `criticDecision(history: Report[]) -> {action: 'fix'|'stop', reason: string, overall: number, worst: string[]}` – правила остановки и выбор трёх худших из Global Constraints; `reason` по-русски («цель достигнута», «третий круг», «оценка перестала расти»).
  - CLI: отчёт к чужому `previewSha256` → код 2 «отчёт к другому preview»; номер круга – следующий после уже сохранённых `qa/critic-*.json` того же preview; сохраняет `qa/critic-<NN>.json` и `.txt` (оценки по сценам, решение, список правок), печатает решение; код 0.

- [ ] **Step 1: Write the failing tests:** валидный отчёт проходит; оценка 0 / 11 / 7.5 / нет `rhythm` – ошибки с именем сцены и оси; сцена с оценкой 6 без `issues` – ошибка; `overall` 9.2 и все сцены ≥ 7 → `stop` «цель достигнута»; 9.2, но сцена 6.4 → `fix`; круг 3 → `stop`; 7.0 → 7.2 → `stop` «оценка перестала расти»; 5 сцен → `worst` из трёх наименьших, при равенстве – более ранняя; 2 сцены → `worst` из двух; CLI с чужим sha → код 2; два вызова подряд → `critic-01` и `critic-02`.

- [ ] **Step 2: Run** `node --test tests/qa-critic.test.js` – FAIL.

- [ ] **Step 3: Implement** схему, `scripts/qa/critic.js`, команду в `cli.js` (по образцу ветки `clean`/`qa-final`).

- [ ] **Step 4: Run** `nice -n 10 node --test tests/qa-critic.test.js tests/qa-report.test.js tests/project-cli-options.test.js` – PASS.

- [ ] **Step 5: Commit** `feat(qa): отчёт агента-критика и решение цикла`.

### Task 4: Задание критику и цикл в motion-скиллах

**Files:**
- Create: `skills/reel-turnkey/references/motion-critic.md` – задание критику: что получает (индекс `moments-*.json`, кадры, телефонный лист, ТЗ/план), как смотреть (каждую сцену по пяти осям с описанием, что такое 1, 5 и 10 по каждой оси; сверка с `motion-craft.md`), формат ответа – строго JSON по схеме, `fix` – конкретное действие для сборщика со ссылкой на `ref`; запрет предлагать новые эффекты вне справочника.
- Create: `.claude/agents/motion-critic.md` – frontmatter `name: motion-critic`, `description`, `tools: Read, Glob, Grep`; тело – «прочитай `skills/reel-turnkey/references/motion-critic.md` и следуй ему».
- Modify: `skills/reel-turnkey/SKILL.md:~445`, `skills/motion-reel/SKILL.md:~256`, `skills/reel-from-donor/SKILL.md:~259`, `skills/ai-promo/SKILL.md:~102-108` – после шага `layer sheet` новый шаг «Цикл критика»: `automontage layer sheet --mode moments`; запустить субагента `motion-critic` (в Codex – отдельного агента с заданием из `motion-critic.md`), сохранить ответ `automontage critic --report`; при `fix` – исправить три сцены, перерендерить preview, повторить; при `stop` – в пульт; оценки и причина остановки – в сообщении Дмитрию.
- Modify: `skills/reel-turnkey/references/qa-checklist.md` (пункт: «последний `qa/critic-*.txt` с решением stop»)
- Modify: `.agents/skills/motion-reel/SKILL.md`, `.codex/skills/motion-reel/SKILL.md` (копии канона)
- Modify: `README.md` (команды `layer sheet --mode moments`, `critic`), `ARCHITECTURE.md` (модули), `CHANGELOG.md` (`[Unreleased]` → `### Добавлено`)
- Test: `tests/motion-critic-instructions.test.js`

**Interfaces:**
- Consumes: команды Task 2 и Task 3; `motion-craft.md`.
- Produces: документы выше; ничего программного.

- [ ] **Step 1: Write the failing test:** `motion-critic.md` содержит пять ключей осей, слова «только JSON», ссылку на `motion-craft.md` и на `schema/critic-report.schema.json`; `.claude/agents/motion-critic.md` имеет `tools: Read, Glob, Grep` и ссылку на канон; четыре SKILL.md содержат `layer sheet --mode moments` и `automontage critic`; копии motion-reel равны канону; нет U+2014 и личных путей.

- [ ] **Step 2: Run** `node --test tests/motion-critic-instructions.test.js` – FAIL.

- [ ] **Step 3: Write** документы и правки.

- [ ] **Step 4: Run** `nice -n 10 node --test tests/motion-critic-instructions.test.js tests/creative-motion-instructions.test.js tests/motion-craft-instructions.test.js tests/ai-promo-skill.test.js tests/reel-from-donor-skill.test.js tests/motion-demo.test.js && node scripts/check-release.js` – PASS.

- [ ] **Step 5: Commit** `docs(skills): цикл агента-критика перед показом preview`.

### Task 5: Проверка на коротком ролике (Mac) и публикация

- [ ] **Step 1:** Полный `nice -n 10 npm test` на сервере; сравнить с 1.17.0 (известные нестабильные: `broll-remote`, `project-mutation-transaction`).
- [ ] **Step 2:** PR в `main`, зелёный CI, merge, релиз minor по `AGENTS.md:324-335`; `git pull --ff-only` на сервере и Mac.
- [ ] **Step 3:** На Mac на коротком готовом ролике с текущим preview: `layer sheet --mode moments`, открыть индекс и телефонный лист; один круг критика по `motion-critic.md`; `automontage critic --report` – решение печатается. Ничего не перерендеривать без нужды.
- [ ] **Step 4:** Отчёт Дмитрию: оценки по сценам, что критик предложил исправить, время шага.
