// automontage layer sheet – контакт-лист текущего preview (миниатюры с рамкой safe-зоны), узкие
// полоски кадров вокруг правок пульта и гейт G12 «пустые кадры» (доля краевых пикселей –
// scripts/qa/empty-frame-gate.js). Команда только показывает и предупреждает – стоп она не ставит
// (не в GATE_COMMANDS scripts/layer/cli.js), qa-отчёт не пишет.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { COMMENT_ID, readComments } = require('../pult/comments');
const { probeMediaPath } = require('../media-probe');
const { runTool } = require('../process');
const { resolveProjectPath } = require('../project/workspace');
const { buildReport, formatReport, projectQaDir } = require('../qa/report');
const { EDGE_THRESHOLD, EDGE_WIDTH, emptyFrameGate } = require('../qa/empty-frame-gate');
const { safeRect } = require('../qa/safe-rect');
const { LAYER_NAME, projectFrom, readJson, relative, writeJson } = require('./common');

const FLAGS = { 'project-dir': 'value', mode: 'value', source: 'value', layer: 'value' };
const MODES = ['even', 'moments'];
// Источник кадров листа моментов: stills – прямо из композиции (по умолчанию, без рендера видео),
// preview – из готового preview (прежнее поведение).
const SOURCES = ['stills', 'preview'];

// Кадр для критика: длинная сторона 720 px; телефонная копия листа – кадр шириной 360 px у вертикали
// и 640 px у горизонтали (16:9 при 360 px давал бы строку мельче, чем на реальном экране).
const CRITIC_LONG_SIDE = 720;
const PHONE_WIDTH = 360;
const PHONE_WIDTH_HORIZONTAL = 640;
const phoneWidth = (width, height) => (height > width ? PHONE_WIDTH : PHONE_WIDTH_HORIZONTAL);
// Квадратный кадр (width == height) попал бы в 'horizontal' и 640 px; валидатор ТЗ квадрат отклоняет, ветка недостижима.
// Формат кадра для индекса: критик узнаёт из него, вертикаль перед ним или горизонталь.
const frameFormat = (width, height) => ({ aspect: height > width ? 'vertical' : 'horizontal', width, height });
const SHEET_COLUMNS = 4;
const QUIET = ['-hide_banner', '-loglevel', 'error', '-y'];

// Середины 16 равных отрезков ролика: sheetTimes(16) в тесте – это sheetTimes(duration = 16).
const sheetTimes = (duration, n = 16) => Array.from({ length: n }, (_, i) => Number((((i + 0.5) * duration) / n).toFixed(3)));

// ffmpeg понимает -ss только как обычную десятичную запись: String(1e-7) печатает экспоненциальную
// форму («1e-7»), которую он отказывается разбирать. Math.max(0, …) – защита от -0 и микроскопических
// отрицательных остатков после вычитания. toFixed(3) сам по себе округляет к БЛИЖАЙШЕЙ миллисекунде,
// то есть примерно в половине случаев – вверх: lastFrameSec вроде 3,9666667 с он превратил бы в
// «3.967», уже позже настоящего последнего кадра – тот же самый отказ декодера, который мы чиним
// этим же зажимом. Поэтому сначала округляем вниз (Math.floor) до миллисекунды и только потом
// печатаем: секунды на выходе никогда не позже запрошенных.
const formatSeconds = (t) => (Math.floor(Math.max(0, t) * 1000) / 1000).toFixed(3);

// Ширина миниатюры: у портретного кадра – сама ширина 270 px; у альбомного длинная сторона (тоже
// ширина) должна остаться читаемой, около 480 px – иначе 16:9 давал бы миниатюры вдвое ниже нужного.
const thumbWidth = (width, height) => (height > width ? 270 : 480);

// Ширина миниатюры, коэффициент масштаба к ней и прямоугольник safe-зоны в её координатах – то, что
// нужно и для рисования рамки на миниатюрах, и тестам, чтобы посчитать тот же ожидаемый прямоугольник.
function thumbBox(width, height) {
  const w = thumbWidth(width, height);
  const k = w / width;
  const safe = safeRect(width, height);
  return { thumbW: w, k, box: { x: Math.round(safe.left * k), y: Math.round(safe.top * k), w: Math.round((safe.right - safe.left) * k), h: Math.round((safe.bottom - safe.top) * k) } };
}

// PGM (P5) из stdout ffmpeg: текстовый заголовок «P5\n<width> <height>\n<maxval>\n», затем ровно
// width*height байт серого. Формат сам несёт свои размеры – не нужно гадать, во что именно scale=…:-2
// округлил высоту.
function parsePgm(buffer) {
  let pos = 0;
  const isSpace = (byte) => byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
  const token = () => {
    while (pos < buffer.length && buffer[pos] === 0x23) { while (pos < buffer.length && buffer[pos] !== 0x0a) pos += 1; pos += 1; }
    while (pos < buffer.length && isSpace(buffer[pos])) pos += 1;
    const start = pos;
    while (pos < buffer.length && !isSpace(buffer[pos])) pos += 1;
    return buffer.subarray(start, pos).toString('ascii');
  };
  if (token() !== 'P5') return null;
  const width = Number(token());
  const height = Number(token());
  token(); // maxval – не нужен для ч/б без нормировки (0–255 стандартно для 8-битного gray)
  pos += 1; // единственный пробел после maxval по спецификации PGM, дальше – сразу бинарные байты
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return null;
  const pixels = buffer.subarray(pos, pos + width * height);
  return pixels.length === width * height ? { width, height, pixels } : null;
}

// Доля пикселей уменьшенного (EDGE_WIDTH px по ширине) ч/б кадра, у которых сосед справа или снизу
// отличается по яркости больше чем на EDGE_THRESHOLD уровней. Ровный фон, плавная виньетка или
// градиент, сглаженный шум после сильного уменьшения – везде эта доля около нуля, это и есть «пусто»
// для G12; читаемый текст или тестовая сетка дают заметную долю даже мелким шрифтом. null – кадр не
// удалось декодировать (не значит «пусто» само по себе, но и не «всё хорошо» – решает emptyFrameGate).
// timeSec === null – файл-картинка (кадр критика): без -ss. FFmpeg 8+ на одиночном JPEG с -ss 0 не
// отдаёт ни одного кадра, и G12 ложно считал все кадры пустыми.
function frameStats(videoPath, timeSec) {
  const seek = timeSec === null ? [] : ['-ss', formatSeconds(timeSec)];
  const result = spawnSync('ffmpeg', [...QUIET, ...seek, '-i', videoPath, '-frames:v', '1',
    '-vf', `scale=${EDGE_WIDTH}:-2,format=gray`, '-f', 'image2pipe', '-vcodec', 'pgm', '-'],
    { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024, shell: false });
  if (result.error || result.status !== 0 || !result.stdout || !result.stdout.length) return null;
  const image = parsePgm(result.stdout);
  if (!image || image.width < 2 || image.height < 2) return null;
  const { width, height, pixels } = image;
  let edges = 0;
  let sum = 0;
  const total = (width - 1) * (height - 1);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    const nextRow = row + width;
    for (let x = 0; x < width; x += 1) {
      const p = pixels[row + x];
      sum += p;
      if (x < width - 1 && y < height - 1
        && (Math.abs(pixels[row + x + 1] - p) > EDGE_THRESHOLD || Math.abs(pixels[nextRow + x] - p) > EDGE_THRESHOLD)) edges += 1;
    }
  }
  return { edgeShare: total > 0 ? edges / total : 0, meanLuma: sum / (width * height) };
}

function frameEdgeShare(videoPath, timeSec) {
  const stats = frameStats(videoPath, timeSec);
  return stats ? stats.edgeShare : null;
}

// Кадр с рамкой safe-зоны. Вызывающий код обязан заранее свести timeSec к [0, lastFrameSec]
// (см. buildSheet) – если ffmpeg всё равно не отдал ни одного кадра, это уже не «запросили время
// за пределами ролика», а настоящий отказ декодера (повреждённый фрагмент, неподдерживаемый кодек).
function thumb(videoPath, timeSec, out, box, thumbW, stage) {
  const drawbox = `drawbox=x=${box.x}:y=${box.y}:w=${box.w}:h=${box.h}:color=magenta@0.9:t=2`;
  runTool('ffmpeg', [...QUIET, '-ss', formatSeconds(timeSec), '-i', videoPath, '-frames:v', '1', '-vf', `scale=${thumbW}:-2,${drawbox}`, out], { stage });
  if (!fs.statSync(out, { throwIfNoEntry: false })?.size) {
    throw new Error(`${stage}: не удалось получить кадр на ${timeSec.toFixed(2)} с – файл повреждён или кодек не читается`);
  }
}

// Контакт-лист 4×4 с рамкой safe-зоны, полоски кадров вокруг секунд правок пульта и G12 «пустые
// кадры». comments – [{id, timeSec}] уже в системе координат videoPath (секунды от начала файла).
// id идёт прямо в имя файла: чужой или подменённый comments.json не должен вывести запись за
// пределы qa/, поэтому принимаем только канонический вид c-<до 40 букв/цифр/дефисов> (COMMENT_ID
// из scripts/pult/comments – в нём нет ни `/`, ни `..`); остальные пропускаем с предупреждением,
// а не роняем всю команду из-за одной записи.
function buildSheet({ videoPath, width, height, duration, fps, outDir, name, comments = [], log = console.warn }) {
  const { thumbW, box } = thumbBox(width, height);
  // Последний реально существующий кадр видео-дорожки: -ss ровно на длительности или за ней ffmpeg
  // молча не отдаёт ничего, даже если сам процесс завершился кодом 0. К этому приводят десятые доли
  // секунды рассинхрона звука и видео, низкий fps, однокадровый ролик – секунды всегда зажаты сюда.
  const lastFrameSec = Math.max(0, duration - 1 / fps);
  const clampSeek = (t) => Math.min(Math.max(0, t), lastFrameSec);
  // Суффикс pid+random: два параллельных запуска `layer sheet` по одному и тому же preview (то же
  // имя sha256) не должны делить одну рабочую папку.
  const work = path.join(outDir, `${name}.frames-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(work, { recursive: true });
  try {
    const times = sheetTimes(duration).map(clampSeek);
    times.forEach((t, i) => thumb(videoPath, t, path.join(work, `f${String(i + 1).padStart(2, '0')}.png`), box, thumbW, 'sheet frame'));
    const sheetPath = path.join(outDir, `${name}.jpg`);
    runTool('ffmpeg', [...QUIET, '-i', path.join(work, 'f%02d.png'), '-vf', 'tile=4x4', '-frames:v', '1', sheetPath], { stage: 'sheet tile' });

    const commentPaths = [];
    for (const comment of comments) {
      if (typeof comment.id !== 'string' || !COMMENT_ID.test(comment.id)) {
        log(`⚠️ правка с недопустимым id пропущена, кадры не собраны: ${JSON.stringify(comment.id)}`);
        continue;
      }
      const strip = path.join(work, comment.id);
      fs.mkdirSync(strip, { recursive: true });
      [-1, -0.5, 0, 0.5, 1].forEach((d, i) => thumb(videoPath, clampSeek(comment.timeSec + d), path.join(strip, `f${i + 1}.png`), box, thumbW, 'sheet comment'));
      // Имя привязано к самому preview (name = sheet-<sha256>), а не только к id правки: две разные
      // версии preview не путают полоски друг друга в одной папке qa/.
      const out = path.join(outDir, `${name}-comment-${comment.id}.jpg`);
      runTool('ffmpeg', [...QUIET, '-i', path.join(strip, 'f%d.png'), '-vf', 'tile=5x1', '-frames:v', '1', out], { stage: 'sheet comment' });
      commentPaths.push(out);
    }

    const samples = times.map((t) => {
      const edgeShare = frameEdgeShare(videoPath, t);
      return edgeShare === null ? null : { timeSec: t, edgeShare };
    });
    return { sheetPath, commentPaths, gate: emptyFrameGate(samples) };
  } finally {
    // Рабочая папка с промежуточными PNG убирается и при успехе, и при любом отказе ffmpeg внутри try.
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// Плитка листа моментов из готовых кадров критика – общая для обоих источников (кадры из preview
// и кадры из композиции, scripts/qa/moment-stills.js). frames – [{file}] по порядку, кадры одной
// величины с пропорциями width×height (любого масштаба). На каждый кадр один ffmpeg даёт миниатюру с
// рамкой safe-зоны и телефонную копию шириной 360 px (640 px у горизонтали); затем листы по SHEET_COLUMNS колонок.
function tileMomentFrames(frames, { outDir, name, width, height }) {
  const { thumbW, box } = thumbBox(width, height);
  const work = path.join(outDir, `${name}.tiles-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(path.join(work, 'sheet'), { recursive: true });
  fs.mkdirSync(path.join(work, 'phone'), { recursive: true });
  try {
    const drawbox = `drawbox=x=${box.x}:y=${box.y}:w=${box.w}:h=${box.h}:color=magenta@0.9:t=2`;
    frames.forEach(({ file }, i) => {
      const n = String(i + 1).padStart(2, '0');
      const sheetFrame = path.join(work, 'sheet', `f${n}.png`);
      const phoneFrame = path.join(work, 'phone', `f${n}.png`);
      const graph = `[0:v]split=2[a][b];[a]scale=${thumbW}:-2,${drawbox}[o1];[b]scale=${phoneWidth(width, height)}:-2[o2]`;
      runTool('ffmpeg', [...QUIET, '-i', file, '-filter_complex', graph,
        '-map', '[o1]', '-frames:v', '1', sheetFrame, '-map', '[o2]', '-frames:v', '1', phoneFrame], { stage: 'moment tile frame' });
      if (![sheetFrame, phoneFrame].every((f) => fs.statSync(f, { throwIfNoEntry: false })?.size)) {
        throw new Error(`moment tile frame: не удалось уменьшить кадр ${path.basename(file)}`);
      }
    });
    const rows = Math.max(1, Math.ceil(frames.length / SHEET_COLUMNS));
    const sheetPath = path.join(outDir, `${name}.jpg`);
    const phonePath = path.join(outDir, `${name}-phone.jpg`);
    runTool('ffmpeg', [...QUIET, '-i', path.join(work, 'sheet', 'f%02d.png'), '-vf', `tile=${SHEET_COLUMNS}x${rows}`, '-frames:v', '1', sheetPath], { stage: 'moment sheet tile' });
    runTool('ffmpeg', [...QUIET, '-i', path.join(work, 'phone', 'f%02d.png'), '-vf', `tile=${SHEET_COLUMNS}x${rows}`, '-frames:v', '1', phonePath], { stage: 'moment phone tile' });
    return { sheetPath, phonePath };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// Лист ключевых моментов из готового preview: по одному ffmpeg на момент – кадр для критика (720 px
// по длинной стороне, без рамки), затем общая плитка tileMomentFrames. Секунды зажаты в
// [0, lastFrameSec], как в buildSheet. projectDir нужен только для относительных путей индекса;
// previewSha256 привязывает индекс к конкретному preview.
function buildMomentSheet({ videoPath, width, height, duration, fps, moments, outDir, name, projectDir = path.dirname(outDir), previewSha256 = null, log = console.warn }) {
  const lastFrameSec = Math.max(0, duration - 1 / fps);
  const clampSeek = (t) => Math.min(Math.max(0, t), lastFrameSec);
  const framesDir = path.join(outDir, name);
  fs.rmSync(framesDir, { recursive: true, force: true });
  fs.mkdirSync(framesDir, { recursive: true });
  const criticScale = height > width ? `scale=-2:${CRITIC_LONG_SIDE}` : `scale=${CRITIC_LONG_SIDE}:-2`;
  const entries = [];
  const frames = moments.map((moment, i) => {
    const n = String(i + 1).padStart(2, '0');
    const file = path.join(framesDir, `${n}-${Number(moment.timeSec.toFixed(3))}.jpg`);
    runTool('ffmpeg', [...QUIET, '-ss', formatSeconds(clampSeek(moment.timeSec)), '-i', videoPath, '-vf', criticScale, '-frames:v', '1', file], { stage: 'moment frame' });
    if (!fs.statSync(file, { throwIfNoEntry: false })?.size) {
      throw new Error(`moment frame: не удалось получить кадр на ${moment.timeSec.toFixed(2)} с – файл повреждён или кодек не читается`);
    }
    entries.push({ file: relative(projectDir, file), timeSec: moment.timeSec, kind: moment.kind, ref: moment.ref, label: moment.label });
    return { file };
  });
  const { sheetPath, phonePath } = tileMomentFrames(frames, { outDir, name, width, height });
  const indexPath = path.join(outDir, `${name}.json`);
  writeJson(indexPath, { version: 1, source: 'preview', format: frameFormat(width, height), previewSha256, moments: entries });
  const samples = moments.map((moment) => {
    const t = clampSeek(moment.timeSec);
    const edgeShare = frameEdgeShare(videoPath, t);
    return edgeShare === null ? null : { timeSec: t, edgeShare };
  });
  log(`кадров для критика: ${entries.length}`);
  return { sheetPath, phonePath, framesDir, indexPath, gate: emptyFrameGate(samples) };
}

// Манифест слоя motion-kit, на котором собран preview: сцена ТЗ ссылается на ассет слоя (brollMedia.src),
// реестр qa/layer-imports.json знает, из какого слоя он импортирован. Нет слоя или манифест не читается –
// null, и моменты берутся из сцен ТЗ. Время манифеста отсчитывается от начала слоя, поэтому
// возвращается и сдвиг offsetSec = scene.start сцены со слоем (`layer brief` пишет start: 0).
function layerManifestFor(projectDir, brief, warn) {
  if (!brief || !Array.isArray(brief.scenes)) return null;
  const { findByReference } = require('./registry');
  const { readCheckedManifest } = require('./render');
  for (const scene of brief.scenes) {
    const src = scene && scene.brollMedia && scene.brollMedia.src;
    if (typeof src !== 'string') continue;
    try {
      const entry = findByReference(projectDir, src);
      if (!entry || !LAYER_NAME.test(String(entry.layer))) continue;
      const { manifest } = readCheckedManifest(projectDir, resolveProjectPath(projectDir, entry.layer, { label: 'layer', mustExist: true, type: 'directory' }));
      return { manifest, offsetSec: Number.isFinite(scene.start) ? scene.start : 0 };
    } catch (error) {
      warn(`⚠️ манифест слоя для ${src} не прочитан, моменты берутся из сцен ТЗ: ${error.message}`);
      return null;
    }
  }
  return null;
}

// Каждый круг критика пишет новый набор кадров: после успешной записи остаются два последних набора
// этого вида (scripts/qa/moment-sets.js). Сбой чистки – только предупреждение, команда не падает.
function pruneOldSets(qaDir, kind, current, warn) {
  try {
    require('../qa/moment-sets').pruneMomentSets(qaDir, { kind, keep: 2, current, warn });
  } catch (error) {
    warn(`⚠️ старые наборы кадров не удалены: ${error.message}`);
  }
}

async function runMoments({ projectDir, current, videoPath, probe, log, warn }) {
  // key-moments сам берёт sheetTimes из этого файла: ленивый require разрывает круг.
  const { keyMoments } = require('../qa/key-moments');
  let brief = null;
  if (current.briefPath) {
    try {
      brief = readJson(resolveProjectPath(projectDir, current.briefPath, { label: 'currentPreview.briefPath', mustExist: true, type: 'file' }), current.briefPath);
    } catch (error) {
      warn(`⚠️ ТЗ preview не прочитано, моменты будут равномерными: ${error.message}`);
    }
  }
  const layer = layerManifestFor(projectDir, brief, warn);
  const moments = keyMoments({
    manifest: layer && layer.manifest, manifestOffsetSec: layer ? layer.offsetSec : 0, brief,
    fromSec: Number(current.fromSec) || 0, durationSec: probe.durationSec,
  });
  const outDir = projectQaDir(projectDir, { create: true });
  const name = `moments-${current.sha256.slice(0, 8)}`;
  const result = buildMomentSheet({
    videoPath, width: probe.width, height: probe.height, duration: probe.durationSec, fps: probe.fps, moments,
    outDir, name, projectDir, previewSha256: current.sha256, log: warn,
  });
  pruneOldSets(outDir, 'preview', name, warn);
  log(`Лист моментов: ${result.sheetPath}`);
  log(`Лист для телефона: ${result.phonePath}`);
  log(`Кадры для критика: ${result.framesDir}`);
  log(`Индекс моментов: ${result.indexPath}`);
  log(formatReport(buildReport({ kind: 'sheet', profile: null, gates: [result.gate], inputs: [] })));
  return 0;
}

// Кадры критика из композиции (scripts/qa/moment-stills.js): цель – слой или motion-reel, моменты –
// из манифеста слоя или сцен ТЗ, имя – по sha256 входов кадров. Отказ цели (урок, слой без layer
// check) – код 2 с подсказкой.
async function runStills({ projectDir, manifest, options, deps, log, warn }) {
  const { REFUSED, inputsSha256, renderMomentStills, resolveStillsTarget } = require('../qa/moment-stills');
  const { keyMoments } = require('../qa/key-moments');
  let target;
  try {
    target = resolveStillsTarget(projectDir, manifest, { layer: options.layer ?? null });
  } catch (error) {
    if (error?.code !== REFUSED) throw error;
    warn(`❌ ${error.message}`);
    return 2;
  }
  const moments = target.kind === 'layer'
    ? keyMoments({ manifest: target.manifest, durationSec: target.durationSec })
    : keyMoments({ brief: target.brief, durationSec: target.durationSec });
  const sha = inputsSha256(target);
  const outDir = projectQaDir(projectDir, { create: true });
  const name = `moments-stills-${sha.slice(0, 8)}`;
  const result = await (deps.renderStillsImpl || renderMomentStills)({
    target, moments, outDir, name, sha, log: warn,
  });
  pruneOldSets(outDir, 'stills', name, warn);
  log(`Лист моментов: ${result.sheetPath}`);
  log(`Лист для телефона: ${result.phonePath}`);
  log(`Кадры для критика: ${result.framesDir}`);
  log(`Индекс моментов: ${result.indexPath}`);
  log(formatReport(buildReport({ kind: 'sheet', profile: null, gates: [result.gate], inputs: [] })));
  return 0;
}

async function run(options, deps = {}) {
  const log = deps.log || console.log;
  // Один канал предупреждений на всю команду (stderr): отказы, ⚠️ ffmpeg и прогресс кадров.
  const warn = deps.warn || console.warn;
  const mode = options.mode === undefined ? 'even' : options.mode;
  if (!MODES.includes(mode)) {
    warn(`❌ неизвестный --mode «${mode}»: допустимо even (равномерный контакт-лист, по умолчанию) или moments (ключевые моменты)`);
    return 2;
  }
  if (mode !== 'moments' && (options.source !== undefined || options.layer !== undefined)) {
    warn('❌ --source и --layer – только для --mode moments');
    return 2;
  }
  const source = options.source === undefined ? 'stills' : options.source;
  if (mode === 'moments' && !SOURCES.includes(source)) {
    warn(`❌ неизвестный --source «${source}»: допустимо stills (кадры из композиции, по умолчанию) или preview (кадры готового preview)`);
    return 2;
  }
  if (mode === 'moments' && source === 'preview' && options.layer !== undefined) {
    warn('❌ --layer – только для --source stills');
    return 2;
  }
  const { projectDir, manifest } = projectFrom(options);
  if (mode === 'moments' && source === 'stills') return runStills({ projectDir, manifest, options, deps, log, warn });
  const current = manifest.currentPreview;
  if (!current) throw new Error('в проекте нет текущего preview – сначала соберите preview');
  const videoPath = resolveProjectPath(projectDir, current.filePath, { label: 'currentPreview.filePath', mustExist: true, type: 'file' });
  // Длительность и геометрия – по самой видео-дорожке (probeMediaPath), а не по контейнеру: если
  // звук preview длиннее видео на десятые доли секунды, длительность контейнера завысила бы конец
  // ролика, и последний семпл или полоска правки просили бы кадр, которого в видео уже нет.
  const probe = probeMediaPath(videoPath, { stage: 'layer sheet probe' });
  if (mode === 'moments') return runMoments({ projectDir, current, videoPath, probe, log, warn });
  // Правки пульта пишут timeSec как currentTime плеера, то есть уже в секундах ОТ НАЧАЛА того самого
  // файла, что играл браузер (scripts/pult/status.js: video.path === preview.filePath) – сдвигать на
  // currentPreview.fromSec не нужно и неверно для preview-фрагмента. Комментарий к другому видео,
  // к более старой версии того же файла на диске (sha256 не совпадает) или со временем за пределами
  // длины КОНТЕЙНЕРА (или отрицательным) – не про этот ролик, отбрасываем совсем. Комментарий между
  // концом видео-дорожки и концом контейнера (тот же рассинхрон звука и видео, из-за которого играет
  // фраза «правка на самом конце») – не мимо, buildSheet сам сведёт его секунды к lastFrameSec.
  const upperBoundSec = probe.containerDurationSec ?? probe.durationSec;
  const comments = readComments(projectDir)
    .filter((comment) => comment.status === 'new' && comment.video.path === current.filePath
      && (comment.video.sha256 === null || comment.video.sha256 === current.sha256)
      && comment.timeSec >= 0 && comment.timeSec <= upperBoundSec)
    .map((comment) => ({ id: comment.id, timeSec: comment.timeSec }));
  const result = buildSheet({
    videoPath, width: probe.width, height: probe.height, duration: probe.durationSec, fps: probe.fps,
    outDir: projectQaDir(projectDir, { create: true }), name: `sheet-${current.sha256.slice(0, 8)}`, comments, log: warn,
  });
  log(`Контакт-лист: ${result.sheetPath}`);
  result.commentPaths.forEach((p) => log(`Кадры правки: ${p}`));
  log(formatReport(buildReport({ kind: 'sheet', profile: null, gates: [result.gate], inputs: [] })));
  return 0;
}

module.exports = { FLAGS, buildMomentSheet, buildSheet, frameEdgeShare, frameFormat, frameStats, phoneWidth, run, sheetTimes, thumbBox, tileMomentFrames };
