# GPU Chrome для layer render на macOS – план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `layer render` на Apple Silicon рендерит слой Remotion с `--gl=angle` (вдвое быстрее, без потери качества), с выключателем `AUTOMONTAGE_GPU`, откатом на CPU и строкой в `npm run doctor`.

**Architecture:** Новый модуль `scripts/gpu.js` решает режим (env + платформа). `remotionLayerRenderCommand` получает два проверенных параметра: `gl` и лимит кэша OffthreadVideo. `scripts/layer/render.js` строит команду по плану GPU и при падении Remotion с GPU один раз повторяет рендер на CPU в тот же заявленный файл. Отчёт layer render не меняется (D-039).

**Tech Stack:** Node.js 20 CommonJS, node:test, Remotion 4.0.536 CLI, ffmpeg (SSIM).

**Spec:** решение в чате 20–21.10.2026 и замеры в Issue #93 (комментарий «macOS (Apple Silicon): замеры и план»); локально `knowledge/layer-render-speed-research-2026-10-20.md` на Mac.

## Global Constraints

- Переменная: `AUTOMONTAGE_GPU`, значения `auto` | `off`, пусто или не задано = `auto`, регистр и пробелы по краям не важны; любое другое значение – ошибка с текстом, где есть `AUTOMONTAGE_GPU` и `auto|off`.
- `auto` включает GPU только при `process.platform === 'darwin'` и `process.arch === 'arm64'`; на остальных платформах – CPU, причина «ускорение на этой платформе не проверено (#93)».
- Флаг GPU – ровно `--gl=angle`. Другие значения `gl` (в том числе `swangle`, `vulkan`, строки с `;`/пробелами) – отказ строителя команды.
- Лимит кэша: `--offthreadvideo-cache-size-in-bytes=2147483648` (2 ГиБ) в каждом layer render, в режиме GPU и CPU. Строитель принимает только целое от 268435456 (256 МиБ) до 68719476736 (64 ГиБ) или `null` (флаг не передаётся).
- VideoToolbox (`--hardware-acceleration`) не добавлять: замер не дал выигрыша.
- `--concurrency` остаётся `50%`.
- Откат: только один повтор на CPU и только если упала команда Remotion с `--gl=angle`; сбой CPU-рендера – прежнее поведение (отчёт с error, код 2).
- `scripts/layer/fast-preview.js`, preview, final, master – не трогать.
- Отчёт `qa/layer-*-render-NN.json` – без новых полей (layer import сверяет его целостность).
- Тексты для пользователя – по-русски, как в соседнем коде; комментарии в стиле файла.

## Review Focus

- `AUTOMONTAGE_GPU=OFF` или ` off ` – должно читаться как `off`, а не как ошибка (тест в Task 1).
- `AUTOMONTAGE_GPU=gpu` (опечатка) – layer render должен остановиться до занятия слота очереди с понятной ошибкой, а не тихо рендерить на CPU (тест в Task 3).
- GPU-рендер упал, CPU-повтор прошёл – слой, нормализация, G6/G7 и отчёт такие же, как у обычного рендера; в логе одно предупреждение об откате (тест в Task 3).
- GPU-рендер упал и CPU-повтор упал – ровно две попытки, отчёт с error, код 2, заявка снята (тест в Task 3).
- `AUTOMONTAGE_LAYER_LIMITED_RANGE=1` передаётся и в CPU-повтор (тест в Task 3).

---

### Task 1: Модуль режима GPU

**Files:**
- Create: `scripts/gpu.js`
- Test: `tests/gpu.test.js`

**Interfaces:**
- Produces:
  - `GPU_ENV = 'AUTOMONTAGE_GPU'`
  - `LAYER_OFFTHREAD_CACHE_BYTES = 2147483648`
  - `gpuMode(env = process.env) -> 'auto' | 'off'` (throw на неизвестном значении)
  - `layerGpuPlan({ env = process.env, platform = process.platform, arch = process.arch } = {}) -> { gl: 'angle' | null, reason: string }`

- [ ] **Step 1: Write the failing test** `tests/gpu.test.js`:

```js
test('gpuMode: пусто и auto – auto, off в любом регистре – off', () => {
  assert.equal(gpuMode({}), 'auto');
  assert.equal(gpuMode({ AUTOMONTAGE_GPU: '' }), 'auto');
  assert.equal(gpuMode({ AUTOMONTAGE_GPU: ' Auto ' }), 'auto');
  assert.equal(gpuMode({ AUTOMONTAGE_GPU: 'OFF' }), 'off');
});
test('gpuMode: неизвестное значение – ошибка с именем переменной', () => {
  for (const value of ['gpu', 'on', '1', 'angle', 'off;rm']) {
    assert.throws(() => gpuMode({ AUTOMONTAGE_GPU: value }), /AUTOMONTAGE_GPU.*auto\|off/);
  }
});
test('layerGpuPlan: angle только на darwin arm64 в режиме auto', () => {
  assert.equal(layerGpuPlan({ env: {}, platform: 'darwin', arch: 'arm64' }).gl, 'angle');
  assert.equal(layerGpuPlan({ env: { AUTOMONTAGE_GPU: 'off' }, platform: 'darwin', arch: 'arm64' }).gl, null);
  for (const [platform, arch] of [['darwin', 'x64'], ['linux', 'x64'], ['linux', 'arm64'], ['win32', 'x64']]) {
    const plan = layerGpuPlan({ env: {}, platform, arch });
    assert.equal(plan.gl, null);
    assert.match(plan.reason, /не проверено/);
  }
  assert.match(layerGpuPlan({ env: { AUTOMONTAGE_GPU: 'off' }, platform: 'darwin', arch: 'arm64' }).reason, /AUTOMONTAGE_GPU=off/);
});
test('LAYER_OFFTHREAD_CACHE_BYTES – 2 ГиБ', () => assert.equal(LAYER_OFFTHREAD_CACHE_BYTES, 2 * 1024 ** 3));
```

- [ ] **Step 2: Run** `node --test tests/gpu.test.js` – Expected: FAIL (`Cannot find module '../scripts/gpu'`).
- [ ] **Step 3: Implement** `scripts/gpu.js` по Interfaces; причины: GPU – «Apple Silicon: Chrome рисует через ANGLE (Metal)», off – «выключено AUTOMONTAGE_GPU=off», прочее – «ускорение на этой платформе не проверено (#93)». Шапка-комментарий файла: зачем (headless Chrome без `--gl` рисует программно), ссылка на D-052.
- [ ] **Step 4: Run** `node --test tests/gpu.test.js` – Expected: PASS.
- [ ] **Step 5: Commit** `feat(gpu): режим AUTOMONTAGE_GPU и план GPU для layer render (#93)`.

### Task 2: Строитель команды layer render

**Files:**
- Modify: `scripts/build-commands.js:123-139` (`remotionLayerRenderCommand`)
- Test: `tests/build-security.test.js` (рядом с тестом concurrency, строка ~169)

**Interfaces:**
- Produces: `remotionLayerRenderCommand(resolved, { entry, composition, output, publicDir, concurrency = '50%', gl = null, offthreadCacheBytes = null })` – при `gl === 'angle'` добавляет `--gl=angle`, при числе – `--offthreadvideo-cache-size-in-bytes=<N>`; при `null` флаги не добавляются (прежние аргументы байт в байт).

- [ ] **Step 1: Write the failing tests** в `tests/build-security.test.js`:

```js
test('remotionLayerRenderCommand: gl только angle, кэш только целое в разумных границах', () => {
  const resolved = { command: process.execPath, argsPrefix: ['/repo/remotion-cli.js', '--env-file=/repo/config/remotion-public.env'] };
  const base = { entry: 'motion-v01/src/index.jsx', composition: 'Layer', output: '/tmp/layer.mp4', publicDir: '/tmp/layer-public' };
  const plain = remotionLayerRenderCommand(resolved, base);
  assert.ok(!plain.args.some((arg) => /^--gl|offthreadvideo/.test(arg)));
  const gpu = remotionLayerRenderCommand(resolved, { ...base, gl: 'angle', offthreadCacheBytes: 2147483648 });
  assert.ok(gpu.args.includes('--gl=angle'));
  assert.ok(gpu.args.includes('--offthreadvideo-cache-size-in-bytes=2147483648'));
  for (const gl of ['swangle', 'vulkan', 'angle;touch sentinel', 'angle --log=verbose', '', 1, true]) {
    assert.throws(() => remotionLayerRenderCommand(resolved, { ...base, gl }), /gl/i);
  }
  for (const offthreadCacheBytes of [0, 1024, 268435455, 68719476737, 1.5, '2147483648', NaN, -1]) {
    assert.throws(() => remotionLayerRenderCommand(resolved, { ...base, offthreadCacheBytes }), /cache/i);
  }
});
```

- [ ] **Step 2: Run** `node --test tests/build-security.test.js` – Expected: новый тест FAIL, старые PASS.
- [ ] **Step 3: Implement** проверки и флаги в `remotionLayerRenderCommand`; флаги ставить после `--overwrite`.
- [ ] **Step 4: Run** `node --test tests/build-security.test.js tests/broll-render-env-security.test.js` – Expected: PASS.
- [ ] **Step 5: Commit** `feat(layer): флаги --gl=angle и лимит кэша видео в команде слоя (#93)`.

### Task 3: layer render – GPU, кэш и откат на CPU

**Files:**
- Modify: `scripts/layer/render.js` (`run`, `renderClaimed`, шапка-комментарий)
- Test: `tests/layer-render.test.js`

**Interfaces:**
- Consumes: `layerGpuPlan`, `LAYER_OFFTHREAD_CACHE_BYTES` (Task 1); `remotionLayerRenderCommand` с `gl`, `offthreadCacheBytes` (Task 2).
- Produces: `run(options, deps)` принимает `deps.gpuPlan` – функция без аргументов → `{ gl, reason }` (по умолчанию `() => layerGpuPlan()`). `renderClaimed` получает `command` (основная) и `fallbackCommand` (CPU-команда или `null`).

- [ ] **Step 1: Write the failing tests** в `tests/layer-render.test.js`, на существующем фейке `fakeRemotion` (строка ~28):
  - `layer render: GPU-план → --gl=angle и кэш 2 ГиБ в команде Remotion, лог называет причину` – `deps.gpuPlan = () => ({ gl: 'angle', reason: 'Apple Silicon: …' })`; в первой Remotion-команде есть `--gl=angle` и `--offthreadvideo-cache-size-in-bytes=2147483648`; код 0.
  - `layer render: план CPU → без --gl, но с кэшем 2 ГиБ` – `gl: null`.
  - `layer render: GPU упал → один повтор на CPU, тот же raw, отчёт обычный` – фейк бросает на команде с `--gl=angle` и рендерит на команде без него; ровно 2 Remotion-вызова, второй без `--gl=angle`, у обоих `env.AUTOMONTAGE_LAYER_LIMITED_RANGE === '1'` и одинаковый output; ровно одно предупреждение с «повторяю на CPU»; отчёт без error, код 0.
  - `layer render: GPU и CPU упали → две попытки, отчёт с error, код 2, заявка снята` – raw `layer-01.raw.mp4` после выхода отсутствует.
  - `layer render: AUTOMONTAGE_GPU=gpu → отказ до слота очереди` – `deps.gpuPlan` бросает `Error('AUTOMONTAGE_GPU: …')`; `deps.acquireSlot` не вызван; `run` отклоняется (rejects) с `/AUTOMONTAGE_GPU/`.
- [ ] **Step 2: Run** `node --test tests/layer-render.test.js` – Expected: новые тесты FAIL.
- [ ] **Step 3: Implement:**
  - в `run` после успешного первого `layer check` и до `acquireSlot` вызвать `gpuPlan()` и вывести `log('GPU рендера: angle – <reason>')` или `log('GPU рендера: нет – <reason>')`;
  - собрать `command` с `gl: plan.gl, offthreadCacheBytes: LAYER_OFFTHREAD_CACHE_BYTES` и, если `plan.gl`, `fallbackCommand` с `gl: null` и тем же кэшем;
  - в `renderClaimed` запуск Remotion: при исключении и наличии `fallbackCommand` – `warn('Remotion с GPU упал (<message>) – повторяю на CPU')`, затем запуск `fallbackCommand` с тем же `cwd`, `stage: 'layer Remotion render (CPU)'` и тем же `env`; второе исключение уходит в существующий `catch` (отчёт с error).
- [ ] **Step 4: Run** `node --test tests/layer-render.test.js tests/gpu.test.js tests/build-security.test.js` – Expected: PASS.
- [ ] **Step 5: Commit** `feat(layer): layer render на GPU Apple Silicon с откатом на CPU (#93)`.

### Task 4: doctor

**Files:**
- Modify: `scripts/doctor.js` (новый пункт после «5. node_modules»)
- Test: `tests/gpu.test.js`

**Interfaces:**
- Consumes: `layerGpuPlan`, `gpuMode` (Task 1).
- Produces: `describeLayerGpu({ env, platform, arch }) -> { level: 'ok' | 'warn', message: string }` в `scripts/gpu.js`.

- [ ] **Step 1: Write the failing test:** `describeLayerGpu` для darwin/arm64 → `level 'ok'`, message содержит `angle`; для `off` → `'ok'`, содержит `AUTOMONTAGE_GPU=off`; для linux → `'ok'`, содержит `CPU`; для `AUTOMONTAGE_GPU=gpu` → `'warn'`, содержит `auto|off`.
- [ ] **Step 2: Run** `node --test tests/gpu.test.js` – Expected: FAIL.
- [ ] **Step 3: Implement** `describeLayerGpu` и вызов в doctor: `ok`/`warn` по `level`, текст вида «Рендер слоя: GPU (angle) – Apple Silicon …» / «Рендер слоя: CPU – <reason>». Живую пробу браузера не делать: `remotion gpu` в 4.0.536 падает на `chrome://gpu` (net::ERR_FAILED) – указать это в комментарии.
- [ ] **Step 4: Run** `node --test tests/gpu.test.js && node scripts/doctor.js` – Expected: PASS; в выводе doctor есть строка «Рендер слоя».
- [ ] **Step 5: Commit** `feat(doctor): режим GPU рендера слоя (#93)`.

### Task 5: Эквивалентность GPU и CPU (opt-in, Mac)

**Files:**
- Create: `tests/layer-gpu-equivalence.test.js`

**Interfaces:**
- Consumes: `remotionLayerRenderCommand` (Task 2), подготовка синтетического слоя – как в `tests/layer-render-still.test.js`.

- [ ] **Step 1: Write the test:** skip, если не `AUTOMONTAGE_TEST_MOTION_RENDER === '1'` или не darwin/arm64 (текст причины пропуска как в `layer-render-still.test.js`). Готовит синтетический слой тем же способом, что `layer-render-still.test.js`, рендерит первые 50 кадров (`--frames=0-49` дописать к args) дважды – `gl: 'angle'` и `gl: null`, оба с `AUTOMONTAGE_LAYER_LIMITED_RANGE=1` и кэшем 2 ГиБ, затем ffmpeg `ssim=stats_file`: assert число кадров 50 в обоих файлах и минимальный покадровый SSIM ≥ 0,99.
- [ ] **Step 2: Run on the Mac** `AUTOMONTAGE_TEST_MOTION_RENDER=1 node --test tests/layer-gpu-equivalence.test.js` – Expected: PASS; на сервере без флага – skip.
- [ ] **Step 3: Commit** `test(layer): эквивалентность GPU и CPU рендера слоя (#93)`.

### Task 6: Документы

**Files:**
- Modify: `.env.example` (блок после очереди тяжёлых задач), `README.md` (раздел layer render, ~678–710), `ARCHITECTURE.md` (пункт `layer render`, ~1048–1060), `docs/MOTION-KIT.md` (шаг 4 «Рендер слоя»), `TESTING.md` (opt-in тест Task 5), `CHANGELOG.md` (`[Unreleased]` → «Добавлено»), `DECISIONS.md` (новый `## D-052` после D-051).

- [ ] **Step 1:** `.env.example`: `AUTOMONTAGE_GPU=auto` с комментарием «auto|off; auto – GPU Chrome (--gl=angle) для layer render только на Apple Silicon, off – всегда CPU».
- [ ] **Step 2:** README и MOTION-KIT: что делает GPU, как выключить, что при сбое рендер сам повторяется на CPU, `npm run doctor` показывает режим.
- [ ] **Step 3:** ARCHITECTURE: `layer render` строит команду с `--gl=angle` по `scripts/gpu.js`, лимит кэша 2 ГиБ, один CPU-повтор, отчёт не меняется.
- [ ] **Step 4:** TESTING: команда opt-in теста Task 5 и критерий SSIM ≥ 0,99.
- [ ] **Step 5:** CHANGELOG `[Unreleased]` → «Добавлено»: «layer render на Apple Silicon рисует кадры через GPU (`--gl=angle`): слой 24:39 – 30 мин вместо ~60, SSIM к CPU ≥ 0,99; `AUTOMONTAGE_GPU=off` возвращает CPU».
- [ ] **Step 6:** DECISIONS D-052 «GPU Chrome для layer render на Apple Silicon» (Дата 2026-10-21, Статус принято, Issue #93): причина (headless без `--gl` – SwiftShader), замеры (30 против 60 мин, SSIM ≥ 0,9903, RSS без роста), что отклонено и почему (VideoToolbox – не быстрее; concurrency 6/8 – не быстрее; `<Video>` из @remotion/media – соседний кадр исходника; рендер окнами – D-031/D-046), почему только darwin arm64 и почему проба через `remotion gpu` невозможна.
- [ ] **Step 7: Run** `node scripts/check-public-privacy.js` и `npm test` – Expected: privacy PASS, 0 fail.
- [ ] **Step 8: Commit** `docs: GPU рендер слоя на Apple Silicon – D-052 (#93)`.

### Task 7: Живая приёмка на Mac

- [ ] **Step 1:** Ветку подтянуть на Mac в отдельный worktree; `npm run doctor` – строка «Рендер слоя: GPU (angle)».
- [ ] **Step 2:** `AUTOMONTAGE_TEST_MOTION_RENDER=1 node --test tests/layer-gpu-equivalence.test.js` – PASS.
- [ ] **Step 3:** Полный `automontage layer render` урока-эталона из worktree с копией проекта вне клиентской папки (клиентские файлы не менять): время записать, G6/G7 зелёные, SSIM ко вчерашнему `layer-01.mp4` ≥ 0,99 на каждом кадре.
- [ ] **Step 4:** `AUTOMONTAGE_GPU=off` на коротком слое – в логе «GPU рендера: нет», рендер идёт.
- [ ] **Step 5:** Комментарий в #93: что сделано, как проверено; статус доски «Проверка». Push и PR – только по явному «да» владельца.
