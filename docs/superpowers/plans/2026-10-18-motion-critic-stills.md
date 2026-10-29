# Агент-критик без рендера видео – дополнение к плану 2026-10-18-motion-critic

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Круги критика не требуют ни одного рендера видео: кадры ключевых моментов рисуются прямо из композиции (`renderStill`) до рендера preview; видео рендерится один раз, когда критик сказал «стоп».

**Architecture:** Новый модуль `scripts/qa/moment-stills.js` по моментам (`keyMoments`) рисует кадры через `@remotion/bundler` + `@remotion/renderer` (один бандл и один браузер на все кадры – приём из `scripts/qa/text-boxes.js`), затем той же плиткой, что `buildMomentSheet`, собирает лист, телефонный лист и индекс. `automontage layer sheet --mode moments` получает флаг `--source stills|preview` (по умолчанию `stills`). Отчёт критика привязывается не только к sha preview, но и к sha входов кадров. Цикл в скиллах переносится до рендера preview.

**Tech Stack:** Node.js 20, Remotion 4.0.504 (`bundle`, `openBrowser`, `selectComposition`, `renderStill`), ffmpeg, `node:test`.

**Spec:** решение Дмитрия 2026-10-18: «не вижу смысла столько рендеров делать»; критик не должен добавлять рендеры видео. Длинные уроки (lesson) по-прежнему вне цикла критика. Параллельно Дмитрий ведёт задачу №110 «Чистый preview» (сборка preview/final) – этот код не трогать.

## Global Constraints

- Ветка та же: `feat/motion-critic`; поверх уже сделанных задач 1–4 основного плана.
- Не менять `scripts/preview.js`, `scripts/build.js`, `scripts/project/preview-workspace.js`, approve-логику – это зона задачи №110.
- Кадр для критика – 720 px по длинной стороне: `renderStill` с `scale = 720 / max(width, height)`; формат `jpeg`, качество 85.
- Рисование кадров берёт тяжёлый слот (`acquireHeavySlotSync`, метка `critic stills <папка>`), как рендер слоя; один бандл и один браузер на вызов, браузер закрывается в `finally`.
- Индекс кадров: поле `source: 'stills'|'preview'`; для `stills` – `inputsSha256` = sha256 от склейки (по порядку): содержимое плана слоя `motion-vNN/src/plan.js` или ТЗ, JSON входных props, sha256 исходника спикера из `layer.json`.
- Отчёт критика: вместо обязательного `previewSha256` – `subjectSha256` + `subject: 'preview'|'stills'`; старое поле `previewSha256` принимается как синоним `subject: 'preview'` (обратная совместимость с уже сделанным в задаче 3).
- Остальные правила основного плана (оси, пороги, 3 круга, документы без U+2014, копии motion-reel байт-в-байт) – в силе.

## Review Focus

1. Маршрут без собранного слоя (нет `motion-vNN/out/manifest.json`, `layer check` не запускался) – `--source stills` отказывает с подсказкой «сначала `automontage layer check`», код 2.
2. Проект, где спикер – длинный исходник (урок): `--source stills` для `currentPreview.kind` lesson отказывает «критик только для моушн-роликов».
3. Chrome не запустился – понятная ошибка, слот освобождён, временная папка кадров удалена.
4. План слоя поменяли после отчёта критика – `automontage critic` с отчётом к старому `inputsSha256` отклоняет его.
5. Прореживание до 48 моментов вытесняет события равномерными кадрами (замечание финального ревью) – сначала выбрасывать `even`, потом `hold`, `event` – последними. Тест в Task A.

---

### Task A: Прореживание моментов по приоритету

**Files:** Modify `scripts/qa/key-moments.js` (функция прореживания); Test `tests/qa-key-moments.test.js`.

**Interfaces:** `keyMoments` – прежняя сигнатура; при обрезке до `max` порядок отбрасывания `even` → `hold` → `event`, внутри типа – равномерно по времени.

- [ ] **Step 1:** Тест: 24 сцены ТЗ + равномерные кадры, `max 48` → все 24 события на месте.
- [ ] **Step 2:** Run – FAIL. **Step 3:** Implement. **Step 4:** Run `nice -n 10 node --test tests/qa-key-moments.test.js` – PASS.
- [ ] **Step 5: Commit** `fix(qa): при прореживании моментов события остаются последними`.

### Task B: Кадры моментов из композиции

**Files:**
- Create: `scripts/qa/moment-stills.js`
- Modify: `scripts/layer/sheet.js` (флаг `source`: `stills` по умолчанию в режиме `moments`, `preview` – прежнее поведение; тайлинг вынести в общую функцию `tileMomentFrames(frames, {outDir, name, width, height})`, которую используют оба источника)
- Modify: `scripts/layer/cli.js` (справка)
- Test: `tests/qa-moment-stills.test.js`

**Interfaces:**
- Consumes: `keyMoments` (основной план, Task 1); `readCheckedManifest` (`scripts/layer/render.js`); способ получить entry/composition/props слоя – как в `scripts/layer/render.js` (`motion-vNN/src/index.jsx`, композиция `Layer`, public-dir слоя); для motion-reel – как в существующем рендере preview motion-reel (композиция и props ТЗ), без изменения этих файлов.
- Produces:
  - `resolveStillsTarget(projectDir, manifest) -> {entry, compositionId, inputProps, publicDir, width, height, fps, durationSec, planPath, kind: 'layer'|'motion-reel'}` – бросает с кодом подсказки из Review Focus 1–2.
  - `renderMomentStills({target, moments, outDir, name, log}, deps = {bundle, openBrowser, selectComposition, renderStill, acquireSlot}) -> Promise<{framesDir, sheetPath, phonePath, indexPath, inputsSha256}>`.
  - `inputsSha256(target, readFile) -> string` – по правилу из Global Constraints.

- [ ] **Step 1: Write the failing tests** (deps-заглушки, без Chrome): 3 момента → 3 вызова `renderStill` с кадрами `round(timeSec * fps)` и `scale` 720/1920; один `bundle`, один `openBrowser`, браузер закрыт и слот освобождён даже при ошибке `renderStill`; индекс содержит `source: 'stills'` и `inputsSha256`; изменение `plan.js` меняет `inputsSha256`; нет манифеста → ошибка с «сначала `automontage layer check`»; lesson → «критик только для моушн-роликов». Плюс рендер-тест под флагом `AUTOMONTAGE_TEST_MOTION_RENDER=1` на шаблоне слоя: 2 кадра, ширина 405 (портрет 1080×1920 → 720 по высоте).
- [ ] **Step 2:** Run – FAIL. **Step 3:** Implement. **Step 4:** Run `nice -n 10 node --test tests/qa-moment-stills.test.js tests/layer-sheet-moments.test.js tests/layer-sheet.test.js` – PASS.
- [ ] **Step 5: Commit** `feat(qa): кадры критика из композиции без рендера видео`.

### Task C: Отчёт критика к кадрам и цикл до preview

**Files:**
- Modify: `schema/critic-report.schema.json`, `scripts/qa/critic.js` (`subject`, `subjectSha256`, синоним `previewSha256`; CLI сверяет `subjectSha256` с последним индексом `qa/moments-*.json` соответствующего источника)
- Modify: `skills/reel-turnkey/references/motion-critic.md`, четыре motion-скилла и `qa-checklist.md`: цикл «`layer check` → `layer sheet --mode moments` (кадры из композиции) → критик → правки → снова кадры» идёт **до** рендера preview; preview рендерится один раз после `stop`; рендер видео внутри цикла запрещён
- Modify: копии motion-reel в `.agents/`/`.codex/`, `README.md`, `ARCHITECTURE.md`, `CHANGELOG.md` (`[Unreleased]`: критик без рендеров видео)
- Test: `tests/qa-critic.test.js` (дополнить), `tests/motion-critic-instructions.test.js` (дополнить)

- [ ] **Step 1: Write the failing tests:** отчёт с `subject: 'stills'` и верным `subjectSha256` принимается; со старым – код 2; старый формат с `previewSha256` принимается как preview; в четырёх SKILL.md шаг критика стоит раньше шага рендера preview и содержит фразу «рендер видео внутри цикла запрещён»; копии равны канону.
- [ ] **Step 2:** Run – FAIL. **Step 3:** Implement. **Step 4:** Run `nice -n 10 node --test tests/qa-critic.test.js tests/motion-critic-instructions.test.js tests/creative-motion-instructions.test.js tests/motion-demo.test.js && node scripts/check-release.js` – PASS.
- [ ] **Step 5: Commit** `feat(qa): цикл критика до рендера preview`.
