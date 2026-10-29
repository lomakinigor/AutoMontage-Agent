# Горизонтальные motion-ролики 16:9 – Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Маршрут motion-reel (и ai-promo поверх него) собирает не только вертикальные 1080×1920, но и горизонтальные 1920×1080 ролики, где сцены заполняют кадр 16:9 своей раскладкой, а не узкой колонкой по центру.

**Architecture:** В ТЗ `output.aspect` становится `vertical | horizontal`; валидатор сверяет aspect с width/height. `src/motion/parts.jsx` получает две «сцены-сцены» (stage): 1080×1920 и 1920×1080 – выбор по aspect; safe-зона и `CONTENT_WIDTH` берутся по выбранной сцене (`safeFor(stage)`), `SceneFrame` масштабирует выбранную сцену к реальному кадру. Каждая сцена motion-reel получает горизонтальную раскладку (две колонки или широкий ряд), не трогая вертикальную. `automontage motion` и scaffold `--music-only` получают `--aspect horizontal`. Пакет ai-promo (`templates/motion-pack`) получает размер из параметра, а не константой.

**Tech Stack:** Remotion 4.0.536, React 19, Node.js 20, `node:test`.

**Spec:** решение Дмитрия 2026-10-19: «надо точно А – научить движок горизонтальным моушн-роликам»; первый ролик – 30 с 16:9 про «Автономку» для поста 21.10. Исследование кода 2026-10-19: размер уже проходит через props и `calculateMetadata`, блокируют схема (`aspect: const vertical`), `parts.jsx` (MOTION_WIDTH/HEIGHT, SAFE_9x16, колонка), фиксированные высоты в сценах, scaffold `build.js:169`, константы пакета ai-promo.

## Global Constraints

- Ветка `feat/motion-horizontal` от ветки `fix/texture-size` (PR #124: размер и скорость текстуры выпускаются вместе с этим планом). Отдельный worktree со своими `node_modules`.
- Вертикаль не меняется ни на пиксель: все существующие тесты и рендер-тесты проходят без правки ожиданий (кроме схемы, где добавляется значение).
- Горизонтальная сцена – 1920×1080; safe-зона `SAFE_16x9 = {top: 60, bottom: 60, left: 80, right: 80}` (из `src/scenes/safezone.js`, без новых чисел). Масштаб по короткой стороне `k = min(width, height) / 1080`.
- `MediaScene` с `frame: "full"` уже не зависит от aspect – не трогать.
- Лист кадров критика для горизонтали: «телефонный» лист – 640 px по ширине кадра (вместо 360 у вертикали), критик знает формат из индекса.
- Документы по-русски, без U+2014; копии motion-reel в `.agents/`/`.codex/` байт-в-байт.
- Тяжёлые проверки рендера на сервере – по одному через `nice -n 10`.

## Review Focus

1. ТЗ `aspect: horizontal` с `width 1080, height 1920` – ошибка валидатора с понятным текстом; и наоборот.
2. Самый длинный кириллический текст в каждой сцене горизонтали остаётся в safe-зоне (рендер-тест по образцу `motion-render.test.js` для 1920×1080).
3. Переходы (slide/wipe/push) и текстура в горизонтали – без пустых полос по краям: фон и текстура покрывают весь кадр 1920×1080.
4. `MediaScene` не-full (карточка медиа) в горизонтали не растягивает видео 9:16 на весь кадр, а вписывает его.
5. Старое вертикальное ТЗ без изменений рендерится как раньше (тест на равенство пропсов и раскладки).

---

### Task 1: ТЗ, валидатор, scaffold

**Files:** `schema/motion-brief.schema.json` (`aspect` enum `vertical|horizontal`), `scripts/motion/brief.js` (сверка aspect ↔ width>height, сообщение по-русски), `scripts/motion/build.js` (флаг `--aspect vertical|horizontal`, по умолчанию vertical; черновик 1920×1080 для horizontal), `scripts/cli.js` (справка), тест `tests/motion-horizontal-brief.test.js`.
- [ ] Тесты: horizontal 1920×1080 валиден; несоответствие aspect/размера – ошибка; `--aspect horizontal` даёт черновик 1920×1080; без флага – прежний 1080×1920; неизвестное значение – код 2.
- [ ] Run – FAIL; Implement; Run – PASS: `tests/motion-horizontal-brief.test.js tests/motion-brief.test.js tests/motion-music-only.test.js tests/motion-demo.test.js`.
- [ ] Commit `feat(motion): aspect horizontal в ТЗ и scaffold`.

### Task 2: Сцена 16:9 в parts.jsx и SceneFrame

**Files:** `src/motion/parts.jsx` (`MOTION_STAGES = {vertical: {width:1080,height:1920}, horizontal: {width:1920,height:1080}}`; `stageFor(width, height)`; `useMotionStage()` возвращает `{stage, safe, contentWidth, horizontal}`; `SceneFrame` масштабирует выбранную сцену, safe-контейнер `data-motion-safe` по `safeFor(stage)`; акцент и подпись – по сцене), `src/MotionDirector.jsx` (водяной знак «черновик» – по короткой стороне), `src/motion/motion-theme.js` (`risePx` по k), тест `tests/motion-horizontal-stage.test.js`.
- [ ] Тесты: при 1080×1920 значения прежние (MOTION_WIDTH/HEIGHT, CONTENT_WIDTH 880); при 1920×1080 stage горизонтальный, contentWidth = 1920-80-80, safe-контейнер на 60/80; масштаб 1 для 1920×1080.
- [ ] Run – FAIL; Implement; Run – PASS + все `tests/motion-*.test.js`.
- [ ] Commit `feat(motion): сцена 16:9 в SceneFrame`.

### Task 3: Горизонтальная раскладка сцен

**Files:** `src/motion/{KineticTitle,CardScene,StepsScene,ListScene,CounterScene,ChartScene,MediaScene,CtaScene}.jsx` – ветка `horizontal` из `useMotionStage()`: заголовок крупно слева/сверху, содержимое – вторая колонка или широкий ряд (шаги – горизонтальная цепочка, список – две колонки при 4+ пунктах, график – шире и ниже, счётчик – число слева, подпись справа), высоты `TextBox` – свои для 16:9; вертикальная ветка без изменений. Тест-хелпер `tests/helpers/motion-render.js` – параметр размера; рендер-тест `tests/motion-render-horizontal.test.js` (под `AUTOMONTAGE_TEST_MOTION_RENDER=1`): все 8 сцен при максимальной длине текста – тексты внутри `data-motion-safe`, без переполнения.
- [ ] Тесты unit (loadMotion с `useVideoConfig` 1920×1080) + рендер-тест; Run – FAIL; Implement; Run – PASS, плюс вертикальный `motion-render.test.js` – PASS без изменений.
- [ ] Commit `feat(motion): горизонтальная раскладка всех сцен`.

### Task 4: Критик, ai-promo, документы

**Files:** `scripts/qa/moment-stills.js` и `scripts/layer/sheet.js` (телефонный лист 640 px для горизонтали), `skills/reel-turnkey/references/motion-critic.md` и `.claude/agents/motion-critic.md` (формат из индекса), `skills/ai-promo/templates/motion-pack/src/tokens.js` (WIDTH/HEIGHT/SAFE из параметра `--aspect`/props; `render.cjs` проверяет выбранный размер), `skills/ai-promo/SKILL.md` и `references/{engine-path,storyboard-and-prompts,model-selection,vfx-kit,qa-checklist}.md` (16:9: кадры Higgsfield 16:9), `skills/motion-reel/SKILL.md`, `references/brief-package.md` (+ копии), `docs/SCENE-CATALOG.md`, `README.md`, `ARCHITECTURE.md`, `CHANGELOG.md` (`[Unreleased]` → `### Добавлено`), тесты документов.
- [ ] Тесты; Run – FAIL; Implement; Run – PASS + `node scripts/check-release.js`.
- [ ] Commit `feat(ai-promo): горизонтальный пакет и документы 16:9`.

### Task 5: Реальный ролик (внешний координатор, Mac) и публикация

- [ ] Полный `npm test`, рендер-тесты под флагом.
- [ ] Ролик «Автономка» 30 с 16:9 на Mac по маршруту ai-promo (Higgsfield-вставки по согласованному бюджету кредитов), критик по кадрам, один рендер; замер веса и времени рендера с текстурой и без.
- [ ] PR, CI, merge, релиз (вместе с PR #124), `git pull --ff-only` на сервере и Mac.
