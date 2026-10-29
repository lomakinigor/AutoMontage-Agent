# Путь через движок

Все команды – из корня движка. `<id>` – папка проекта, `vNN` – номер ревизии из `project.json`,
`motion-vNN` – папка пакета. Пути в brief – относительные внутри проекта.

Если `automontage` нет в PATH (оболочка отвечает «command not found» или «не является
внутренней или внешней командой»), та же команда запускается так: `node scripts/cli.js <команда>
…`, например `node scripts/cli.js motion --project-dir projects/<id> --music-only`. На Windows
пути пиши через `\` и в двойных кавычках, если в них есть пробел.

## 1. Проект без речи

Саундтрек ([audio-recipe.md](audio-recipe.md)) собирается до проекта во временной папке
`tmp/ai-promo/<slug>/` движка (она не попадает в Git) и обрезан до целых кадров.

```bash
automontage motion tmp/ai-promo/<slug>/soundtrack.wav --project "Промо <продукт>" --music-only
# горизонтальный ролик 16:9 (1920×1080) – добавь --aspect horizontal; без флага вертикаль 1080×1920
```

- Whisper не запускается, `transcript/words.json` = `[]`, scaffold brief получает
  `audioRole: "music"` и одну `kinetic-title`-сцену с названием проекта.
- Саундтрек копируется в `input/narration.wav` и становится мастер-аудио.
- Если проект уже создан обычной командой и упал на пустом транскрипте или Whisper упал
  раньше, чем записал `transcript/words.json`, – не создавай новый, продолжи:
  `automontage motion --project-dir projects/<id> --music-only`.
- Проект, в транскрипте которого уже есть речь, флаг не переделывает: команда отказывает
  `--music-only refuses a project whose transcript already has speech; use the narration path`.
  Это ролик с голосом – веди его обычным маршрутом motion-reel.
- Флаг нельзя сочетать с `--model`, `--brief`, `--version-label`, `--script`, `--voice`,
  `--voice-id`, `--accept-provider-cost`.
- Новый саундтрек (другой трек, другая длина, сдвиг ударов) – новый проект с `--music-only`:
  источник связан хэшами с brief. `assets/ai/` и `motion-vNN/` копируются в новую папку,
  пути в `provenance.json` относительные и остаются верными.

Дальше все материалы ролика живут в `projects/<id>/`: `assets/ai/` (кадры, клипы, референсы,
`provenance.json`), `copy.md` (согласованный текст), `motion-vNN/` (пакет).

## 2. Длина пакета

```bash
node -e "const m=require('./projects/<id>/brief/v01-draft.motion.json');console.log(m.output.durationInFrames)"
```

`TOTAL` в `motion-vNN/src/tokens.js` должен совпасть с этим числом: `durationInFrames` =
`ceil(длительность саундтрека × 30)`. Сумма сцен `PLAN` в `index.jsx` обязана закончиться
ровно на `TOTAL` (пакет сам проверяет это при рендере).

`ASPECT` в `tokens.js` = `output.aspect` ТЗ. Шаблон вертикальный (сцены скомпонованы под 1080×1920):
для 16:9 поставь `'horizontal'` и перекомпонуй сцены, иначе `fit: cover` обрежет вертикальный
клип примерно до трети высоты. Рендер с `--brief` проверяет это за тебя.

## 3. Рендер пакета

```bash
node projects/<id>/motion-vNN/stills.cjs 0 90 300 600      # контрольные кадры, каждый < TOTAL
node projects/<id>/motion-vNN/render.cjs --brief projects/<id>/brief/vNN-draft.motion.json   # полный рендер без звука
```

`render.cjs` ждёт слот общей очереди, рендерит композицию `Promo` с `withAudio=false` и
`--muted`, проверяет 1080×1920 (у горизонтали 1920×1080), 30 FPS, отсутствие звуковой дорожки и число кадров = `TOTAL`.
Результат – `motion-vNN/renders/promo-NN.mp4`. Скопируй его в ассеты и посчитай хэш:

```bash
cp projects/<id>/motion-vNN/renders/promo-01.mp4 projects/<id>/assets/promo-pack-v01.mp4
shasum -a 256 projects/<id>/assets/promo-pack-v01.mp4    # Linux: sha256sum
```

Слой motion-kit (`automontage layer new`) здесь не используется: он для видео спикера и
отказывает аудио-проектам.

## 4. Draft brief с media-сценой

Сохрани `projects/<id>/brief/proposed.motion.json` на основе scaffold: тот же `source`,
`audioRole: "music"`, `output` и одна сцена на весь ролик. Блок `music` запрещён.

```json
{
  "scene": "media",
  "start": 0,
  "end": 23,
  "media": {
    "kind": "video",
    "src": "assets/promo-pack-v01.mp4",
    "sha256": "<sha256>",
    "fit": "cover",
    "audioMode": "mute",
    "frame": "full"
  }
}
```

`"frame": "full"` обязателен: клип идёт на весь кадр 1080×1920 (горизонталь 16:9 – 1920×1080) без рамки и зума сцены, как его
отрендерил пакет. Без поля (`"card"`) движок положит пакет в карточку сцены. У `full` нет места
для `overlayText` и `caption`: все надписи уже внутри пакета. `end` = `durationInFrames / 30`. Удобно резать саундтрек на длину, кратную 0,1 с (число кадров
кратно 3), тогда `end` – точная десятичная граница кадра. Публикация:

```bash
node - projects/<id> brief/proposed.motion.json <<'NODE'
const fs = require('node:fs');
const { createOrOpenProject, resolveProjectPath, publishBriefRevision } = require('./scripts/project/workspace');
const { validateMotionBrief } = require('./scripts/motion/brief');
const workspace = createOrOpenProject({ projectDir: process.argv[2] });
const proposed = resolveProjectPath(workspace.dir, process.argv[3], { mustExist: true, type: 'file' });
const brief = JSON.parse(fs.readFileSync(proposed, 'utf8'));
const result = validateMotionBrief(brief);
if (!result.ok) throw new Error(result.errors.join('\n'));
if (brief.status !== 'draft') throw new Error('Publish a draft, never a fabricated approval');
console.log(publishBriefRevision(workspace, { kind: 'motion-reel', brief }));
NODE
```

На Windows – тот же JavaScript через временный локальный `.cjs` из корня движка.

## 5. Preview и QA

```bash
automontage preview --project-dir projects/<id> --brief brief/vNN-draft.motion.json
node scripts/qa-preview.js --project-dir projects/<id>
```

Без браузера (SSH, headless) добавь `--no-open`: preview сохраняется, окно не открывается; без
флага preview тоже сохраняется и только предупреждает, что открыть окно не удалось.
`qa-preview` печатает `soundtrack mean <x> dB` – это `mean_volume` источника, а не LUFS;
громкость в LUFS меряй `ebur128` по [qa-checklist.md](qa-checklist.md). Звук preview – 48 кГц.

Перед публикацией preview проходит автоматический барьер motion-preview (D-049): чёрные провалы,
громкость −14 ± 1 LUFS и true peak ≤ −1,5 dBTP (на полном preview), одна дорожка 48 кГц, размер
и FPS. При ❌ preview не публикуется, прошлый остаётся; причина – в `qa/motion-preview-full.json`.
Остальное – ручной QA по [qa-checklist.md](qa-checklist.md). Покажи preview пользователю и напомни про `automontage pult`.

## 6. Утверждение и final

Полный preview в 1080p собирается в качестве финала без вшитого `ЧЕРНОВИК` (надпись рисует плеер
пульта). Утверждение такого preview сразу копирует его в `final/<slug>.mp4` (DECISIONS.md D-051):
и в пульте, и через `approve-brief.js` (строка `final: …`); повторная проверка финала идёт в фоне.
Тогда команду final ниже не запускай.

Если пользователь нажал «Утверждаю» в пульте, а в `automontage inbox` строка «Утверждено»
(фрагмент, 4K, preview прежней версии движка), `approveBrief` уже выполнен и `brief/vNN-approved.motion.json` создан – сразу final:

```bash
automontage motion --project-dir projects/<id> --brief brief/vNN-approved.motion.json --version-label reviewed
```

Только при явном «утверждаю» пользователя в чате к показанной версии и подтверждении, что он
посмотрел весь preview, сначала утверди сам brief, затем та же команда final (если утверждение
не напечатало `final: …`):

```bash
node scripts/project/approve-brief.js projects/<id> brief/vNN-draft.motion.json --confirm-preview-viewed
automontage motion --project-dir projects/<id> --brief brief/vNN-approved.motion.json --version-label reviewed
```

Final проходит loudnorm движка (I = −14 LUFS, TP = −1,5 dBTP). Затем полный QA final по
[qa-checklist.md](qa-checklist.md). Любая правка – новый пакет или brief, новый preview и новое
утверждение.
