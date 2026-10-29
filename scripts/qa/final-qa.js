#!/usr/bin/env node
// Финальный QA готового MP4: повторная локальная расшифровка финала (faster-whisper) и сравнение
// с активной расшифровкой проекта (гейты F1–F5 из final-transcript-gates.js), обложка – кадр 0
// (G13) и рамки надписей на кадрах финальной композиции (G14, G15). Все гейты дают только pass,
// warn или skipped: финал публикуется в любом случае. Ошибка раннера попадает в лог и в поле
// error отчёта, сборку она не роняет.
//
// build.js синхронный, поэтому зовёт этот файл отдельным процессом через runFinalQaSync
// (флаг --from-build: код выхода всегда 0). Пользовательская команда:
//   automontage qa-final <папка ролика> [--final <mp4>] [--model <имя>] [--music]
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const { finalTranscriptGates, VOICED_GAP_MIN_SEC } = require('./final-transcript-gates');
const { buildReport, exitCodeFor, formatReport, hidePaths, writeReport } = require('./report');
const { collectWords } = require('../tighten');

const ROOT = path.join(__dirname, '..', '..');
const SCRIPT = __filename;
const DEFAULT_MODEL = 'large-v3-turbo';
const MUSIC_SKIP_REASON = 'музыка мешает замеру';
const USAGE = 'укажите папку ролика: automontage qa-final <папка ролика> [--final <mp4>] [--model <имя>] [--music]';

const message = (error) => (error && error.message ? error.message : String(error));
const pad = (n) => String(n).padStart(2, '0');
// Время в имени отчёта – UTC, как у preview-<время>-NN в preview-gates.js.
const stamp = (date) => `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-`
  + `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;

// Тяжёлые модули грузим лениво: тесты подменяют их через deps и не тянут ffmpeg/Python-обвязку.
const defaults = {
  transcribe: (options) => require('../project/takes').transcribeTakeFile(options),
  readLevels: (file) => require('../project/take-pauses').readTakeLevels(file, { stage: 'final QA levels' }),
  readManifest: (dir) => require('../project/workspace').readProjectManifest(dir),
};

function countWords(segments) {
  return (Array.isArray(segments) ? segments : [])
    .reduce((sum, segment) => sum + (Array.isArray(segment?.words) ? segment.words.length : 0), 0);
}

// Слова активной расшифровки проекта (manifest.transcript.words). Её таймлайн – таймлайн активной
// source-ревизии (master пересчитывает слова под свою нарезку), а lesson и Dynamic рендерят именно
// её с глобальным таймкодом. Нет файла, он пуст или не читается – null: сравнивать не с чем.
function readExpectedWords(projectDir, manifest) {
  const stored = manifest?.transcript?.words;
  if (!projectDir || typeof stored !== 'string' || !stored) return null;
  try {
    const { resolveProjectPath } = require('../project/workspace');
    const file = resolveProjectPath(projectDir, stored, { label: 'manifest.transcript.words', mustExist: false, type: 'file' });
    if (!fs.existsSync(file)) return null;
    const segments = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!countWords(segments)) return null;
    return collectWords(segments);
  } catch (_) {
    return null;
  }
}

// Промежутки между соседними словами длиннее minSec, где звук не тихий: вздох, чмокание, обрывок.
function findVoicedGaps(words, analysis, minSec = VOICED_GAP_MIN_SEC) {
  const { isSilentSpan } = require('../project/take-pauses');
  const gaps = [];
  const list = Array.isArray(words) ? words : [];
  for (let i = 1; i < list.length; i += 1) {
    const fromSec = list[i - 1].e;
    const toSec = list[i].s;
    if (toSec - fromSec > minSec + 1e-9 && !isSilentSpan(analysis, fromSec, toSec)) gaps.push({ fromSec, toSec });
  }
  return gaps;
}

async function transcriptCheck(ctx) {
  const { projectDir, finalPath, manifest, hasMusic, model, deps = {} } = ctx;
  const transcribe = deps.transcribeImpl || defaults.transcribe;
  const readLevels = deps.readLevelsImpl || defaults.readLevels;
  const segments = await transcribe({ videoPath: finalPath, model });
  const actual = countWords(segments) ? collectWords(segments) : [];
  let expected = readExpectedWords(projectDir, manifest);

  const skipReasons = {};
  let voicedGaps = null;
  try {
    const { analyzeLevels } = require('../project/take-pauses');
    const analysis = analyzeLevels(await readLevels(finalPath));
    // Финал бывает короче исходника (--frames, длительность brief): слова расшифровки за его
    // концом в финал не входят и пропавшими не считаются.
    const durationSec = analysis.levels.length * analysis.frameSec;
    if (expected && durationSec > 0) expected = expected.filter((w) => w.s < durationSec);
    if (hasMusic) skipReasons.voiced = MUSIC_SKIP_REASON;
    else voicedGaps = findVoicedGaps(actual, analysis);
  } catch (error) {
    skipReasons.voiced = hasMusic ? MUSIC_SKIP_REASON
      : `не удалось прочитать звук: ${hidePaths(message(error), projectDir || path.dirname(finalPath))}`;
  }
  return finalTranscriptGates({ expected, actual, voicedGaps, skipReasons });
}

// Проверки финала; план ТОП-3 / 3 добавляет сюда свои. Проверка: {id, run(ctx) -> Promise<Gate[]>},
// ctx = {projectDir, finalPath, manifest, hasMusic, model, render, deps}; render – данные рендера
// финала из build.js ({entry, compositionId, propsPath, publicDir, fps, width, height}) или null.
// G13: кадр 0 финала. Ошибка замера (нет ffmpeg, битый файл) – warn «не удалось прочитать», не исключение.
async function coverCheck(ctx) {
  const { coverFrameGate } = require('./cover-frame-gate');
  const measure = (ctx.deps && ctx.deps.frameStatsImpl) || require('../layer/sheet').frameStats;
  let stats = null;
  try {
    stats = await measure(ctx.finalPath, 0);
  } catch (_) {
    stats = null;
  }
  return [coverFrameGate(stats)];
}

// G14/G15: реальные рамки надписей на кадрах финальной композиции (text-boxes.js). Нужны данные
// рендера из build.js (ctx.render); пользовательская команда qa-final их не знает – тогда skipped.
// Creative Motion-слой в финале урока встроен готовым видео через broll/media-сцену, его DOM в финале
// не существует, а манифест motion-слоя живёт в своей временной шкале. Поэтому кадры – равномерные
// (pickTextFrames без манифеста). Любая ошибка (Chrome, бандл) – G14/G15 skipped с текстом ошибки.
const NO_RENDER_HINT = 'нет данных рендера – проверка кадров выполняется только при сборке';

async function textLayoutCheck(ctx) {
  const { textLayoutGates } = require('./text-layout-gates');
  const render = ctx.render;
  // skipTextReason – почему данных рендера нет (фоновая проверка продвинутого финала, D-051).
  if (!render) return textLayoutGates({ samples: null, error: ctx.skipTextReason || NO_RENDER_HINT });
  const deps = ctx.deps || {};
  try {
    const { collectTextBoxes, pickTextFrames } = require('./text-boxes');
    const collect = deps.collectTextBoxesImpl || collectTextBoxes;
    const samples = await collect({
      entry: render.entry, compositionId: render.compositionId, propsPath: render.propsPath, publicDir: render.publicDir,
      frames: (composition) => pickTextFrames({ manifest: null, durationInFrames: composition.durationInFrames, fps: composition.fps }),
    }, deps.textBoxesDeps || null);
    return textLayoutGates({ samples, width: render.width, height: render.height });
  } catch (error) {
    const hidden = hidePaths(message(error), ctx.projectDir || path.dirname(ctx.finalPath));
    return textLayoutGates({ samples: null, error: `не удалось замерить кадры: ${hidden}` });
  }
}

const FINAL_CHECKS = [
  { id: 'transcript', run: transcriptCheck }, { id: 'cover', run: coverCheck }, { id: 'text-layout', run: textLayoutCheck },
];

function relativeInput(baseDir, file) {
  return path.relative(baseDir, file).split(path.sep).join('/');
}

async function runFinalQa({
  projectDir = null, finalPath, hasMusic = false, model = DEFAULT_MODEL, render = null, skipTextReason = null, write = true, now = new Date(), checks = FINAL_CHECKS,
} = {}, deps = {}) {
  if (typeof finalPath !== 'string' || !finalPath) throw new Error('не указан путь к финалу');
  const dir = projectDir ? path.resolve(projectDir) : null;
  const final = path.resolve(finalPath);
  // Без проекта отчёт кладём в qa/ рядом с финалом; из build.js это внутренний файл сборки в out/,
  // а не копия в --outdir.
  const reportRoot = dir || path.dirname(final);
  const errors = [];
  const hide = (text) => hidePaths(text, reportRoot);

  let manifest = null;
  if (dir) {
    try {
      manifest = await (deps.readManifestImpl || defaults.readManifest)(dir);
    } catch (error) {
      errors.push(`project.json: ${hide(message(error))}`);
    }
  }

  const gates = [];
  if (!fs.existsSync(final)) {
    errors.push(`финал не найден: ${path.basename(final)}`);
  } else {
    const ctx = { projectDir: dir, finalPath: final, manifest, hasMusic: Boolean(hasMusic), model, render, skipTextReason, deps };
    for (const check of checks) {
      try {
        gates.push(...await check.run(ctx));
      } catch (error) {
        errors.push(`${check.id}: ${hide(message(error))}`);
      }
    }
  }

  const inputs = [{ role: 'final', path: relativeInput(reportRoot, final) }];
  if (dir && typeof manifest?.transcript?.words === 'string') inputs.push({ role: 'transcript', path: manifest.transcript.words });
  const report = buildReport({ kind: 'final', profile: null, gates, inputs, now, error: errors.length ? errors.join('; ') : null });
  if (!write) return { report, paths: null };
  const written = writeReport(reportRoot, `final-${stamp(now)}`, report, deps.fileSystem);
  return { report, paths: { json: written.jsonPath, txt: written.textPath } };
}

// Никогда не бросает: финал уже собран, QA только подсказывает.
async function maybeRunFinalQa({
  enabled, projectDir, finalPath, hasMusic = false, model = DEFAULT_MODEL, render = null, log = console.log,
} = {}, deps = {}) {
  if (!enabled) return;
  try {
    const { report, paths } = await runFinalQa({ projectDir, finalPath, hasMusic, model, render }, deps);
    log(formatReport(report));
    if (paths) log(`отчёт финала: ${paths.txt}`);
    if (report.error) log(`final QA не выполнен: ${report.error}`);
  } catch (error) {
    log(`final QA не выполнен: ${message(error)}`);
  }
}

function finalQaChildArgs({ projectDir = null, finalPath, hasMusic = false, model = DEFAULT_MODEL, render = null } = {}) {
  const args = [SCRIPT, '--from-build'];
  if (projectDir) args.push(projectDir);
  args.push('--final', finalPath, '--model', model || DEFAULT_MODEL);
  if (hasMusic) args.push('--music');
  if (render) args.push('--render-json', JSON.stringify(parseRender(render)));
  return args;
}

// Предел времени дочернего QA: Whisper и кадры идут примерно со скоростью ролика, поэтому
// 3 × длительность финала, но не меньше 10 минут. Длительность неизвестна – 30 минут.
const FINAL_QA_MIN_TIMEOUT_MS = 10 * 60 * 1000;
const FINAL_QA_DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

function finalQaTimeoutMs(durationSec) {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return FINAL_QA_DEFAULT_TIMEOUT_MS;
  return Math.max(FINAL_QA_MIN_TIMEOUT_MS, Math.round(3 * durationSec * 1000));
}

const timedOut = (error) => Boolean(error && (error.code === 'ETIMEDOUT' || /ETIMEDOUT/u.test(message(error))));

// Вызов из синхронного build.js: отдельный node-процесс с пределом времени. Любой сбой запуска,
// ненулевой код или таймаут – строка в логе, сборка продолжается. Возвращает true, если процесс
// отработал. options.durationSec – длительность финала в секундах (для предела времени).
function runFinalQaSync(options = {}, { runNodeToolImpl = require('../process').runNodeTool } = {}) {
  const log = options.log || console.log;
  if (!options.enabled) return false;
  log('финал собран, идёт проверка (final QA); пропустить – --no-final-qa');
  const timeout = finalQaTimeoutMs(options.durationSec);
  // Битые данные рендера не должны отменять весь финальный QA: без них G14/G15 будут skipped.
  let render = null;
  if (options.render) {
    try {
      render = parseRender(options.render);
    } catch (error) {
      log(`final QA: надписи на кадрах не проверить – ${message(error)}`);
    }
  }
  try {
    const [script, ...args] = finalQaChildArgs({ ...options, render });
    // reapOnFailure: при таймауте или аварии добить отдельные группы процессов (Chrome Remotion),
    // записанные в тикетах тяжёлого слота, – иначе слот не освободится (macOS: нет setpriv).
    runNodeToolImpl(script, args, { cwd: ROOT, stage: 'final QA', timeout, reapOnFailure: true });
    return true;
  } catch (error) {
    if (timedOut(error)) log(`final QA не выполнен: проверка не уложилась в ${Math.round(timeout / 60000)} мин и остановлена`);
    else log(`final QA не выполнен: ${message(error)}`);
    return false;
  }
}

// Данные рендера финала для G14/G15: та же композиция, props и public, что у самого рендера.
function parseRender(value) {
  let render = value;
  if (typeof value === 'string') {
    try {
      render = JSON.parse(value);
    } catch (_) {
      throw new Error('--render-json: не JSON');
    }
  }
  if (!render || typeof render !== 'object' || Array.isArray(render)) throw new Error('--render-json: нужен объект');
  for (const key of ['entry', 'compositionId', 'propsPath']) {
    if (typeof render[key] !== 'string' || !render[key]) throw new Error(`--render-json: ${key} должен быть непустой строкой`);
  }
  if (render.publicDir != null && (typeof render.publicDir !== 'string' || !render.publicDir)) {
    throw new Error('--render-json: publicDir должен быть строкой или null');
  }
  for (const key of ['fps', 'width', 'height']) {
    if (!Number.isFinite(render[key]) || render[key] <= 0) throw new Error(`--render-json: ${key} должен быть положительным числом`);
  }
  return {
    entry: render.entry, compositionId: render.compositionId, propsPath: render.propsPath,
    publicDir: render.publicDir || null, fps: render.fps, width: render.width, height: render.height,
  };
}

const VALUE_OPTIONS = new Set(['final', 'model', 'render-json']);
const FLAG_OPTIONS = new Set(['music', 'from-build']);

function parseArgs(argv) {
  const options = { projectDir: null, final: null, model: DEFAULT_MODEL, music: false, fromBuild: false, render: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const name = arg.slice(2);
      if (VALUE_OPTIONS.has(name)) {
        const value = argv[i + 1];
        if (value == null || value.startsWith('--')) throw new Error(`${arg} требует значение`);
        if (name === 'render-json') options.render = parseRender(value);
        else options[name] = value;
        i += 1;
      } else if (FLAG_OPTIONS.has(name)) {
        options[name === 'from-build' ? 'fromBuild' : name] = true;
      } else {
        throw new Error(`неизвестный флаг ${arg}`);
      }
    } else if (!options.projectDir) {
      options.projectDir = arg;
    } else {
      throw new Error(`лишний аргумент «${arg}»`);
    }
  }
  return options;
}

// Финал проекта по умолчанию – manifest.final (final/<slug>.mp4).
function defaultFinalPath(projectDir) {
  const { readProjectManifest, resolveProjectPath } = require('../project/workspace');
  const manifest = readProjectManifest(projectDir);
  return resolveProjectPath(projectDir, manifest.final, { label: 'manifest.final', mustExist: false, type: 'file' });
}

async function main(argv = process.argv.slice(2), { log = console.log, error = console.error } = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (parseError) {
    if (argv.includes('--from-build')) {
      log(`final QA не выполнен: ${parseError.message}`);
      return 0;
    }
    error(`❌ ${parseError.message}\n${USAGE}`);
    return 2;
  }
  const projectDir = options.projectDir ? path.resolve(options.projectDir) : null;
  if (options.fromBuild) {
    // Из build.js: без проекта допустим один --final; код выхода всегда 0.
    if (!options.final && !projectDir) {
      log('final QA не выполнен: не указан финал');
      return 0;
    }
    await maybeRunFinalQa({
      enabled: true, projectDir, finalPath: options.final, hasMusic: options.music, model: options.model, render: options.render, log,
    });
    return 0;
  }
  if (!projectDir) {
    error(`❌ ${USAGE}`);
    return 2;
  }
  try {
    const finalPath = options.final ? path.resolve(options.final) : defaultFinalPath(projectDir);
    const { report, paths } = await runFinalQa({ projectDir, finalPath, hasMusic: options.music, model: options.model });
    log(formatReport(report));
    log(`отчёт: ${paths.txt}`);
    return exitCodeFor(report);
  } catch (runError) {
    error(`❌ final QA не выполнен: ${hidePaths(message(runError), projectDir)}`);
    return 2;
  }
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; });
}

module.exports = {
  DEFAULT_MODEL, FINAL_CHECKS, MUSIC_SKIP_REASON, NO_RENDER_HINT,
  finalQaChildArgs, finalQaTimeoutMs, findVoicedGaps, main, maybeRunFinalQa, parseArgs, parseRender, readExpectedWords, runFinalQa, coverCheck, runFinalQaSync,
  textLayoutCheck, transcriptCheck,
};
