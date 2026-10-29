# Детали моушна: счётчик-одометр, графики, текстура кадра – Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Цифры в роликах прокручиваются, как одометр, и мягко останавливаются на точном значении; появляется сцена-график с точными данными (столбики растут, могут перетечь в линию); кадр получает лёгкую «живую» текстуру – зерно, медленный дрейф фона и блик по карточке.

**Architecture:** Общий набор деталей `src/details/` (чистая математика в `.js`, компоненты в `.jsx`), экспортируется и в motion-reel, и в motion-kit (`@automontage/motion-kit`). Motion-reel: сцена `counter` переходит на `Odometer`; новая сцена `chart`; поле ТЗ `style.texture: 'none'|'subtle'` включает `Grain` + `Drift`, а `Sheen` проходит по карточкам на входе. Motion-kit: те же компоненты доступны проектным сценам через `item.props.view` (без нового `kind`). Зерно – готовая детерминированная плитка PNG, сдвигаемая по кадрам (дёшево для рендера), а не SVG-фильтр.

**Tech Stack:** Remotion 4.0.536 (после плана «Обновление Remotion и переходы»), `@remotion/paths` (`evolvePath`, `getLength`), React 19, Node.js 20, `node:test`.

**Spec:** программа доработок, пункты 17, 18, 19 (память проекта `engine-upgrade-program`; источники – product-launch-motion, charlie947 animated-chart, claude-motion, промпт студии моушна Дмитрия); решение Дмитрия 2026-10-18: моушн-апгрейды – главный приоритет. Исследование кода 2026-10-18: `counter` считает от 0 кубической кривой без разрядов; `SceneChart` – жёстко заданный демо-график, недоступный из ТЗ; в пакете ai-promo нет зерна и блика по карточкам (только блик по тексту `Chrome`), в основном движке текстур нет.

## Global Constraints

- Ветка `feat/motion-details` от `origin/main` **после** мержа плана «Обновление Remotion и переходы»; отдельный worktree со своими `node_modules` (`npm ci`).
- `@remotion/paths` объявить в `package.json` точной версией, равной `remotion` (4.0.536).
- Одометр: прокрутка 1,2–1,8 с (по умолчанию 1,5 с), затем «оседание» – пружина с перелётом не больше 0,15 высоты цифры; в покое – ровно утверждённое число. Разряды – неразрывный пробел U+00A0 для `ru`; цифры `tabular-nums`; префикс и суффикс – в одной строке с числом (`inline`) или стопкой как сейчас (`stack`), по умолчанию `inline`.
- График: 2–8 точек; значения и подписи – из ТЗ дословно; столбики растут по очереди с шагом 4–6 кадров при 25 fps; `bar-to-line` – столбики сжимаются в точки за 8 кадров при 25 fps, затем линия прорисовывается за 15 кадров при 25 fps; одна точка может быть выделена акцентом (`highlight`).
- Текстура `subtle`: зерно – непрозрачность не больше 0,06, плитка 256×256 px сдвигается на случайный (детерминированный от номера кадра) шаг каждые 2 кадра; дрейф фона – период 8 с, амплитуда не больше 6 % размера кадра; блик – один проход по карточке на её входе, 12 кадров при 25 fps, не в цикле.
- Цвета и шрифты – только из темы маршрута (`motionTheme` для motion-reel, `useTheme()`/`tk()` для блоков); motion-kit – из пропсов проекта.
- Текстовые элементы размечены для проверок G14/G15: число одометра – `data-motion-text` на внешнем элементе, `overflow: hidden` – только на внутренних окнах цифр; подписи графика – `data-motion-text`.
- Lesson и шаблон ai-promo не менять (кроме экспорта общих деталей, если пакету это нужно – нет).
- Документы по-русски, без U+2014; копии motion-reel в `.agents/`/`.codex/` – байт-в-байт.
- На Mac – только короткий ролик (demo `--motion`).

## Review Focus

1. Отрицательное число, дробь с запятой (`12,5 %`) и большое число (`1 250 000 ₽`) – в покое строка совпадает с утверждённой форматированной строкой символ в символ. Тест в Task 1.
2. Число меняет количество разрядов при прокрутке (0 → 1 250 000) – ширина блока не «прыгает»: ширина считается по итоговому числу с первого кадра. Тест в Task 1.
3. Все значения графика равны или есть ноль – высоты не делятся на ноль, нулевой столбик виден как линия основания. Тест в Task 2.
4. Сцена `counter` из старого ТЗ (без новых полей) – рендерится одометром с `inline`, ТЗ валидно без изменений. Тест в Task 1.
5. Текстура `subtle` на светлой теме motion-reel (фон `#EDF0F4`) не снижает контраст текста ниже WCAG 4,5 – зерно и дрейф лежат под панелями, не над текстом. Тест в Task 3.

---

### Task 1: Одометр

**Files:**
- Create: `src/details/odometer.js` (математика), `src/details/Odometer.jsx`, `src/details/index.js`
- Modify: `src/motion/CounterScene.jsx` (вместо `counterValue`/`formatCounter` – `Odometer`; полоса прогресса остаётся), `schema/motion-brief.schema.json` (`counterScene.layout?: 'inline'|'stack'`), `src/motion-kit/index.js` (экспорт `Odometer`)
- Test: `tests/details-odometer.test.js`

**Interfaces:**
- Produces:
  - `formatNumber(value: number, {decimals?: number, locale = 'ru'}) -> string` – разряды U+00A0, десятичная запятая; `decimals` по умолчанию – как в утверждённом значении.
  - `odometerColumns(finalText: string, progress: number) -> Array<{char: string, digit: boolean, offset: number}>` – для каждой цифры итоговой строки `offset` в «высотах цифры» (0 – стоит на итоговой цифре); младшие разряды крутятся больше оборотов, чем старшие; при `progress = 1` все `offset = 0`.
  - `odometerProgress(frame, fps, {rollSec = 1.5, delayFrames = 0}) -> number` – 0..1 с easeOut, затем пружина оседания (перелёт ≤ 0.15).
  - `<Odometer value prefix suffix decimals layout fontSize color data-motion-text />`.

- [ ] **Step 1: Write the failing tests:** `formatNumber(1250000)` → `'1 250 000'`; `formatNumber(12.5, {decimals: 1})` → `'12,5'`; `-40` → `'-40'`; `odometerColumns('1 250', 1)` – все offset 0, пробел `digit: false`; при `progress 0.5` младший разряд имеет |offset| больше старшего; `odometerProgress` на 0 кадре 0, после `rollSec` плюс 0,5 с – ровно 1, максимум не больше 1.15; рендер `CounterScene` через `loadMotion` на последнем кадре содержит итоговую строку в `data-counter-value`; старое ТЗ без `layout` валидно.
- [ ] **Step 2: Run** `node --test tests/details-odometer.test.js` – FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `nice -n 10 node --test tests/details-odometer.test.js tests/motion-timing.test.js tests/motion-render.test.js tests/motion-brief.test.js` – PASS.
- [ ] **Step 5: Commit** `feat(details): счётчик-одометр в сцене counter`.

### Task 2: Сцена-график

**Files:**
- Create: `src/details/chart.js`, `src/details/Chart.jsx`, `src/motion/ChartScene.jsx`
- Modify: `schema/motion-brief.schema.json` (`chartScene`: `title` (shortText), `chartType: 'bar'|'line'|'bar-to-line'`, `points: [{label (≤24), value: number}]` 2–8, `unit?` (≤16), `highlight?: integer`, `caption?`; в `oneOf`), `scripts/motion/brief.js` (`MOTION_SCENES`, `sceneSummary`, проверки длины `points` и индекса `highlight`), `src/MotionDirector.jsx` (`MOTION_COMPONENTS.chart`), `review/timeline.js` (`sceneDisplayText`), `examples/motion-brief-demo.json` и `scripts/generate-neutral-fixtures.js` (demo покрывает все сцены – требование `check-release.js:410`), `tests/helpers/motion-render.js` (список сцен), `package.json` (`@remotion/paths` 4.0.536), `src/motion-kit/index.js` (экспорт `Chart`)
- Test: `tests/details-chart.test.js`

**Interfaces:**
- Produces:
  - `chartLayout(points, {width, height, padding}) -> {bars: [{x, y, w, h, label, value}], baseline: number, max: number}` – нулевые и равные значения – Review Focus 3.
  - `barGrowth(frame, fps, index, {stepFrames25 = 5}) -> 0..1`; `linePath(bars) -> string` (SVG path через центры верхушек); `barToLine(frame, fps, startFrame) -> {barScale, lineProgress}`.
  - `<Chart points chartType unit highlight theme />`; сцена `ChartScene` с `TextBox` заголовка и подписи.

- [ ] **Step 1: Write the failing tests:** 3 точки 10/20/40 → высоты в пропорции 1:2:4, максимум = доступная высота; все нули → высоты 0, `max` не 0; `barGrowth` второго столбика начинается на 5 кадров позже первого (25 fps); `linePath` начинается с `M` и проходит через 3 точки; `bar-to-line` на кадре старта + 8 (25 fps) `barScale = 0`, на +23 `lineProgress = 1`; ТЗ с 1 или 9 точками – ошибка валидатора; `highlight: 5` при 3 точках – ошибка; демо-ТЗ содержит сцену `chart` и проходит `check-release`.
- [ ] **Step 2: Run** – FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `nice -n 10 node --test tests/details-chart.test.js tests/motion-brief.test.js tests/motion-render.test.js tests/motion-demo.test.js && node scripts/check-release.js` (+ `AUTOMONTAGE_TEST_MOTION_RENDER=1` для `motion-render`) – PASS.
- [ ] **Step 5: Commit** `feat(motion): сцена-график с точными данными`.

### Task 3: Текстура кадра

**Files:**
- Create: `scripts/gen-grain.js` (детерминированная плитка 256×256 PNG, seed фиксирован), `public/textures/grain-256.png` (результат, в git), `src/details/texture.js`, `src/details/Texture.jsx` (`Grain`, `Drift`, `Sheen`)
- Modify: `schema/motion-brief.schema.json` (`style.texture: 'none'|'subtle'`, по умолчанию `none`), `src/MotionDirector.jsx` (подложка `Drift` + `Grain` под сценами при `subtle`), `src/motion/parts.jsx` (`Panel` получает `Sheen` на входе при `subtle`), `src/motion-kit/index.js` (экспорт)
- Test: `tests/details-texture.test.js`

**Interfaces:**
- Produces:
  - `grainOffset(frame, {stepFrames = 2, seed = 7}) -> {x, y}` – детерминирован, меняется раз в 2 кадра.
  - `driftAt(frame, fps, {periodSec = 8, amplitude = 0.06}) -> {x, y}` – доли кадра, |x|,|y| ≤ amplitude.
  - `sheenProgress(frame, fps, enterFrame, {frames25 = 12}) -> number | null` – `null` вне прохода.
  - `<Grain opacity={0.06} />`, `<Drift colors />`, `<Sheen enterFrame />`.

- [ ] **Step 1: Write the failing tests:** `grainOffset` одинаков для кадров 10 и 11, разный для 10 и 12, повторяем между запусками; `driftAt` на 0 и через 8 с совпадает, никогда не больше 0,06; `sheenProgress` до входа и после 12 кадров (25 fps) – `null`; `gen-grain.js` даёт файл с тем же sha256 при повторном запуске; ТЗ без `style.texture` валидно и рендерит без `Grain`; при `subtle` `Grain` и `Drift` в DOM идут раньше контейнера сцены (под текстом); контраст `motionTheme.ink` к `motionTheme.panel` после наложения зерна 0,06 (расчёт по худшему пикселю плитки) не ниже 4,5.
- [ ] **Step 2: Run** – FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `nice -n 10 node --test tests/details-texture.test.js tests/motion-render.test.js tests/motion-brief.test.js` – PASS.
- [ ] **Step 5: Commit** `feat(details): текстура кадра – зерно, дрейф фона, блик карточки`.

### Task 4: Правила для агента и документация

**Files:**
- Modify: `skills/reel-turnkey/references/motion-craft.md` (раздел `## Детали`: одометр 1,2–1,8 с и только для проверенного числа; график – не больше 6 столбиков в рилсе, подписи дословно, один акцент; текстура `subtle` по умолчанию для новых motion-ТЗ, зерно ≤ 0,06, один блик на карточку), `skills/motion-reel/references/brief-package.md` (сцена `chart`, `layout`, `style.texture`), `skills/motion-reel/SKILL.md` («восемь сцен»), копии в `.agents/`/`.codex/`, `docs/SCENE-CATALOG.md`, `docs/MOTION-KIT.md` (таблица деталей: `Odometer`, `Chart`, `Grain`, `Drift`, `Sheen` для проектных сцен через `item.props.view`), `skills/reel-turnkey/references/motion-critic.md` (критик проверяет читаемость цифр и графиков в оси `typography`), `README.md`, `ARCHITECTURE.md`, `CHANGELOG.md`
- Test: `tests/motion-details-docs.test.js`

- [ ] **Step 1: Write the failing test:** раздел `## Детали` с числами `1,2–1,8 с`, `0,06`, `6 столбиков`; `brief-package.md` описывает `chart`, `layout`, `texture`; «восемь сцен» в SKILL.md; копии равны канону; `MOTION-KIT.md` содержит пять компонентов; нет U+2014.
- [ ] **Step 2: Run** – FAIL. **Step 3: Write.** **Step 4: Run** вместе с `motion-craft-instructions`, `motion-kit-docs`, `creative-motion-instructions`, `motion-demo`, `check-release` – PASS.
- [ ] **Step 5: Commit** `docs: одометр, графики и текстура в справочнике и каталоге сцен`.

### Task 5: Проверка на коротком ролике (Mac) и публикация

- [ ] **Step 1:** Полный `nice -n 10 npm test`, рендер-тесты под флагом.
- [ ] **Step 2:** PR, зелёный CI, merge, релиз minor; на сервере и Mac `git pull --ff-only` и `npm ci`.
- [ ] **Step 3:** На Mac: demo `--motion` с `style.texture: 'subtle'`, сценами `counter` (1 250 000 ₽) и `chart` (`bar-to-line`); засечь время preview с текстурой и без (рост не больше 15 %); кадры ключевых моментов – Дмитрию.
