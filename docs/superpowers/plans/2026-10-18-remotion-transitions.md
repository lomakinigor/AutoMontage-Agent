# Обновление Remotion и переходы-превращения – Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Движок переходит на Remotion 4.0.536, а сцены перестают сменяться жёсткой склейкой: в motion-роликах появляются переходы между сценами, в слое motion-kit – вставка, вырастающая из конкретного элемента кадра, и наезд камеры на элемент.

**Architecture:** (1) Все пакеты `remotion`/`@remotion/*` закрепляются точной версией 4.0.536, `@remotion/bundler` и `@remotion/renderer` объявляются явно (сейчас приходят транзитивно). (2) Motion-reel: необязательное поле `transition` у сцены ТЗ описывает вход в эту сцену; `MotionDirector` рендерит сцены через `TransitionSeries`, удлиняя предыдущую сцену на длину перехода, поэтому таймлайн ТЗ, валидатор «без наложений» и синхрон с дикторским текстом не меняются. (3) Motion-kit: у вставки появляется `origin: '<id элемента>'` – карточка растёт из рамки этого элемента, а не из безопасной зоны; у камеры – `pushes: [{at, target, frames}]` – наезд в центр рамки элемента. (4) Правила в `motion-craft.md`, `docs/MOTION-KIT.md`, схемах и скиллах.

**Tech Stack:** Remotion 4.0.536 (`@remotion/transitions`: `TransitionSeries`, `linearTiming`, `springTiming`, презентации `fade`, `slide`, `wipe`, `push-cut`), React 19.0.0, Node.js 20, `node:test`.

**Spec:** программа доработок, пункты 16 и 24 (память проекта `engine-upgrade-program`; источники идей – claude-motion, charlie947, HyperFrames); решение Дмитрия 2026-10-18: моушн-апгрейды – главный приоритет нового ТОП-3. Исследование кода 2026-10-18: `@remotion/transitions` установлен, но не используется; motion-reel и lesson склеивают сцены встык; валидаторы `scripts/motion/brief.js:113-116`, `scripts/lesson/brief.js:71-72` запрещают наложение сцен.

## Global Constraints

- Ветка `feat/remotion-transitions` от `origin/main` **после** мержа плана «Агент-критик» (иначе конфликты в `CHANGELOG.md` и скиллах); отдельный worktree со **своими** `node_modules` (`npm ci`): симлинк на основную папку запрещён – обновление пакетов сломало бы работающие сессии монтажа.
- Все `remotion` и `@remotion/*` в `package.json` – точная версия `4.0.536` без `^`; `react`/`react-dom` остаются 19.0.0.
- Презентации на HTML-in-canvas (`book-flip`, `crosswarp`, `cross-zoom`, `dreamy-zoom`, `dissolve`, `film-burn`, `linear-blur`, `ripple`, `swap`, `zoom-blur`, `zoom-in-out`) не использовать: они опираются на экспериментальный API Chromium.
- Типы перехода сцены motion-reel, ровно: `cut` (по умолчанию, текущее поведение), `fade`, `slide`, `wipe`, `push`. Длительность по умолчанию 10 кадров при 25 fps (0,4 с), допустимо 6–15 кадров при 25 fps, пересчёт через `ref25`.
- Переход не меняет время начала сцены: содержимое сцены B начинается ровно в `scenes[i].start`, сцена A удлиняется на длину перехода. Общая длительность композиции не меняется.
- Lesson и шаблон ai-promo не трогать.
- Длительность морфа вставки – 9 кадров при 25 fps (как `REVEAL_FRAMES`), наезда камеры – 12 кадров при 25 fps; масштаб наезда не больше `maxScale` профиля.
- Документы по-русски, без U+2014, без личных путей. Копии motion-reel и creative-motion в `.agents/`/`.codex/` – байт-в-байт с каноном.
- Тяжёлые проверки рендера на сервере – по одному, через `nice -n 10`; на Mac – только короткий ролик (demo `--motion`, 27 с).
- После релиза на Mac обязательно `npm ci`: изменились зависимости, без этого новая версия там не заработает.

## Review Focus

1. Переход у первой сцены ТЗ (входить не из чего) – валидатор отклоняет с понятной ошибкой `scenes[0].transition`. Тест в Task 2.
2. Переход длиннее предыдущей сцены (сцена 0,3 с, переход 0,4 с) – валидатор отклоняет; рендер не должен показывать пустой кадр. Тест в Task 2.
3. `origin` ссылается на id, которого нет или который ещё не появился к началу вставки – `layer check` даёт ❌ с id; рендер не падает. Тест в Task 3.
4. Наезд камеры на элемент у края кадра – центр наезда ограничен так, чтобы кадр не уходил за край исходника (нет чёрных полей). Тест в Task 3.
5. После обновления Remotion старый проект с ТЗ без `transition` рендерится кадр-в-кадр как раньше (`cut`). Тест в Task 2 сравнивает длительность и границы `Sequence`; визуально – Task 5.

---

### Task 1: Remotion 4.0.536

**Files:**
- Modify: `package.json` (точные версии; добавить `@remotion/bundler`, `@remotion/renderer` 4.0.536), `package-lock.json` (через `npm install`)
- Modify: `skills/reel-turnkey/references/motion-craft.md:~59` («сейчас 4.0.536»), `HANDOFF.md:~26`
- Modify при необходимости: `tests/remotion-ffmpeg-override.test.js` (фикстура argv стичера), `scripts/remotion-ffmpeg-override.js`, `scripts/remotion-webpack.js`, `scripts/qa/text-boxes.js`, тесты, читающие `@remotion/cli/dist/*` и `Internals` – только если они реально сломались
- Test: `tests/remotion-version.test.js`

**Interfaces:**
- Produces: зависимости 4.0.536; `node_modules/.remotion/chrome-headless-shell` скачан (`npx remotion browser ensure`).

- [ ] **Step 1: Write the failing test** `tests/remotion-version.test.js`: каждая зависимость `remotion`/`@remotion/*` в `package.json` равна точной строке `4.0.536`; `@remotion/bundler` и `@remotion/renderer` объявлены; версия в lockfile совпадает; `motion-craft.md` называет её.
- [ ] **Step 2: Run** `node --test tests/remotion-version.test.js` – FAIL.
- [ ] **Step 3:** Обновить `package.json`, `npm install`, `npx remotion browser ensure`, обновить документы.
- [ ] **Step 4: Run** `nice -n 10 npm test` – сравнить с базой (1.17.0/1.18.0: известные нестабильные `broll-remote`, `project-mutation-transaction`); затем `AUTOMONTAGE_TEST_MOTION_RENDER=1 nice -n 10 node --test tests/motion-render.test.js tests/layer-render-still.test.js tests/motion-kit-render.test.js` – PASS. Каждую поломку – чинить в коде движка минимально, не откатывая версию; причину записать в коммит.
- [ ] **Step 5: Commit** `chore(deps): Remotion 4.0.536, явные bundler и renderer`.

### Task 2: Переходы между сценами motion-reel

**Files:**
- Modify: `schema/motion-brief.schema.json` (у сцены необязательное `transition: {type: 'cut'|'fade'|'slide'|'wipe'|'push', frames?: integer, direction?: 'left'|'right'|'up'|'down'}`)
- Modify: `scripts/motion/brief.js` (проверки из Review Focus 1–2; `frames` в пределах 6–15 при 25 fps)
- Create: `src/motion/transitions.js` – чистые функции
- Modify: `src/MotionDirector.jsx` (при наличии хотя бы одного не-`cut` перехода – `TransitionSeries`, иначе прежние `Sequence`)
- Test: `tests/motion-transitions.test.js`

**Interfaces:**
- Produces:
  - `TRANSITION_TYPES = ['cut','fade','slide','wipe','push']`; `DEFAULT_TRANSITION_FRAMES_25 = 10`.
  - `planSceneTransitions(scenes, fps) -> Array<{index, from, durationInFrames, transition: null | {type, frames, direction}}>` – `from` и длительности в кадрах; сцена перед не-`cut` переходом удлиняется на `frames`; сумма видимых интервалов совпадает с прежней длительностью композиции.
  - `presentationFor(transition, {width, height}) -> {presentation, timing}` – `fade()`, `slide({direction})`, `wipe({direction})`, `pushCut({...})` из `@remotion/transitions/*`; `timing = linearTiming({durationInFrames: frames})`, для `push` – `springTiming` с `durationInFrames: frames`.

- [ ] **Step 1: Write the failing tests:** ТЗ без `transition` → `planSceneTransitions` даёт прежние `from`/длительности; сцены `0–3`, `3–6` с `transition: {type: 'fade'}` у второй при 30 fps → первая длится 102 кадра (90 + 12), вторая начинается на кадре 90; `frames: 20` → ошибка валидатора; переход у `scenes[0]` → ошибка `scenes[0].transition`; сцена 0,3 с перед переходом 0,4 с → ошибка; `presentationFor({type:'slide', direction:'left'})` возвращает объект с `component`; неизвестный тип → ошибка валидатора; рендер-тест (под флагом `AUTOMONTAGE_TEST_MOTION_RENDER`) – кадр в середине перехода `fade` не пустой (G12 edgeShare > 0,001) и содержит элементы обеих сцен.
- [ ] **Step 2: Run** – FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `nice -n 10 node --test tests/motion-transitions.test.js tests/motion-brief.test.js tests/motion-render.test.js tests/motion-demo.test.js` (+ рендер-флаг) – PASS.
- [ ] **Step 5: Commit** `feat(motion): переходы между сценами через TransitionSeries`.

### Task 3: Морф вставки из элемента и наезд камеры (motion-kit)

**Files:**
- Modify: `src/motion-kit/inserts.js`, `src/motion-kit/Inserts.jsx` (поле вставки `origin`; карточка анимирует рамку от бокса элемента `origin` на кадре начала вставки до полного кадра за 9 кадров при 25 fps; закрытие – обратно в бокс, если элемент ещё виден, иначе прежние 6 кадров)
- Modify: `src/motion-kit/camera.js` (`pushes: [{at, target, frames?, k?}]`: камера за `frames` (по умолчанию 12 при 25 fps) масштабируется до `k` (по умолчанию 1.35, не больше `maxScale`) с центром в центре бокса `target`, центр ограничен так, чтобы кадр не выходил за исходник; после – держит до следующего shot/punch)
- Modify: `src/motion-kit/compile.js` (связать `origin`/`target` с `itemExtentAt`; ошибки компиляции по несуществующим id)
- Modify: `scripts/qa/timeline-gates.js` (❌ для `origin`/`target`, которые не видны в кадре начала)
- Modify: `src/motion-kit/manifest.js` (в `inserts[]` – `origin`; в манифест – `camera.pushes` для листа ключевых моментов)
- Test: `tests/motion-kit-morph.test.js`

**Interfaces:**
- Consumes: `itemExtentAt(item, frame, fps)` из `src/motion-kit/motion.js`; `compileCamera`, `cameraAt`; `safeRect`.
- Produces: поля плана `inserts[].origin: string`, `camera.pushes[]`; функции `morphRect(fromBox, toBox, progress) -> {x,y,w,h}`, `pushCenter(targetBox, {width, height, k}) -> {cx, cy}`.

- [ ] **Step 1: Write the failing tests:** `morphRect` при 0 и 1 даёт исходный и полный бокс, при 0.5 – середину; вставка с `origin: 'title-1'` на кадре старта открывается от бокса `title-1`; несуществующий `origin` – ошибка компиляции с id; `origin`, который скрыт к началу вставки, – ❌ гейта; `pushCenter` для бокса в правом верхнем углу при k 1.35 ограничен краем; `cameraAt` в середине наезда даёт масштаб между 1 и k, после наезда – k; k больше `maxScale` – ошибка; рендер-тест под флагом – кадр середины морфа не пустой.
- [ ] **Step 2: Run** – FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `nice -n 10 node --test tests/motion-kit-morph.test.js tests/qa-timeline-gates.test.js tests/motion-kit-*.test.js tests/layer-*.test.js` (+ рендер-флаг для `layer-render-still`) – PASS.
- [ ] **Step 5: Commit** `feat(motion-kit): вставка из элемента и наезд камеры на элемент`.

### Task 4: Правила для агента и документация

**Files:**
- Modify: `skills/reel-turnkey/references/motion-craft.md` – новый раздел `## Переходы`: переход делает объект в кадре; один тип «большого» перехода (`push`, морф вставки) на ролик, остальные – `cut`/`fade`/`slide`; переход только на смене мысли; длительности из Global Constraints; запрет переходов на HTML-in-canvas.
- Modify: `docs/MOTION-KIT.md` (LayerPlan ~195-230: `origin`, `pushes`; таблица деталей ~300-342), `skills/reel-turnkey/references/creative-motion.md` (палитра: морф и наезд), `skills/motion-reel/references/brief-package.md` (поле `transition`), `skills/motion-reel/SKILL.md`, копии в `.agents/`/`.codex/`, `README.md`, `ARCHITECTURE.md`, `CHANGELOG.md`
- Modify: `skills/reel-turnkey/references/motion-critic.md` (критик оценивает переходы в оси `motion`)
- Test: `tests/motion-transitions-docs.test.js`

- [ ] **Step 1: Write the failing test:** раздел `## Переходы` в `motion-craft.md` с типами и числами `10 кадров (0,4 с)`, `6–15`, `12 кадров`; `MOTION-KIT.md` упоминает `origin` и `pushes`; `brief-package.md` – `transition`; копии равны канону; нет U+2014.
- [ ] **Step 2: Run** – FAIL.
- [ ] **Step 3: Write** документы.
- [ ] **Step 4: Run** `nice -n 10 node --test tests/motion-transitions-docs.test.js tests/motion-craft-instructions.test.js tests/motion-kit-docs.test.js tests/creative-motion-instructions.test.js tests/motion-demo.test.js && node scripts/check-release.js` – PASS.
- [ ] **Step 5: Commit** `docs: переходы и морфы в справочнике и MOTION-KIT`.

### Task 5: Проверка на коротком ролике (Mac) и публикация

- [ ] **Step 1:** Полный `nice -n 10 npm test`; рендер-тесты под флагом.
- [ ] **Step 2:** PR, зелёный CI (job `motion-smoke` рендерит demo), merge, релиз minor; на сервере и Mac `git pull --ff-only` и **`npm ci`**; `npx remotion browser ensure` на Mac.
- [ ] **Step 3:** На Mac: `automontage demo --motion` (27 с) с ТЗ, где у сцен стоят `fade`, `slide`, `push`; preview; кадры на каждой границе сцен (`layer sheet --mode moments` или ffmpeg) – переходы видны, пустых кадров нет; отчёт Дмитрию с листом кадров.
- [ ] **Step 4:** Обновить глобальный Remotion-скилл на Mac до версии под 4.0.536, если он установлен из git; иначе сообщить Дмитрию, как обновить.

## Решения Дмитрия по вопросам после Task 2 (2026-10-18)

- **Видео в хвосте сцены.** Если клип сцены заканчивается раньше, чем кончится переход, на время перехода держится последний кадр клипа (стоп-кадр, `Freeze` / `trimAfter` по длине клипа), а не пустота и не продолжение. Тест: клип короче сцены + переход → в середине перехода кадр не пустой и совпадает с последним кадром клипа.
- **Переход после паузы между сценами.** Валидатор больше не отклоняет: предыдущая сцена автоматически удлиняется через паузу до начала следующей, затем идёт переход. Тест: сцены 0–3 и 4–7 с `fade` у второй → первая длится до 4 с + переход, вторая начинается ровно в 4 с.
- **Лишние поля** (`direction` у fade/push, `frames`/`direction` у cut) – остаются ошибкой валидатора с точным текстом, что убрать.
- **Переход `push`.** Новая сцена должна быть видна ровно в своё время по ТЗ: для `push` переход начинается на половину своей длины раньше границы (предыдущая сцена удлиняется на `frames/2`, следующая стартует на `frames/2` раньше, её собственная анимация входа сдвигается так, чтобы содержимое было видно в `start`). Тест: середина `push` приходится на кадр `start` сцены.
- **Направление `direction`** – как есть (`left` – новая сцена въезжает справа), описать в документации для агента одной строкой.
