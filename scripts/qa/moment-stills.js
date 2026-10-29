// Кадры ключевых моментов для критика прямо из композиции, без рендера видео: один бандл Remotion и
// один браузер на вызов (приём из scripts/qa/text-boxes.js), на каждый момент – renderStill в jpeg
// 720 px по длинной стороне. Затем та же плитка, что у листа моментов preview (tileMomentFrames в
// scripts/layer/sheet.js): лист с рамкой safe-зоны, телефонный лист и индекс qa/moments-stills-*.json.
//
// Цель – то, что потом станет preview: слой motion-vNN (композиция слоя, public слоя, план src/plan.js)
// или motion-reel (MotionReel и props черновика ТЗ, медиа – через тот же lease черновика, что у
// automontage preview). Урок (lesson без слоя) – не цель: критик только для моушн-роликов.
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ROOT } = require('../env');
const { assertCompositionId } = require('../build-commands');
const { acquireHeavySlotSync, heavyQueueConfig } = require('../heavy-queue');
const { hashFile } = require('../pult/files');
const { resolveProjectPath } = require('../project/workspace');
const { LAYER_NAME, assertLayerSource, layerSrcSha256, relative, writeJson } = require('../layer/common');
const { emptyFrameGate } = require('./empty-frame-gate');

const CRITIC_LONG_SIDE = 720;
const JPEG_QUALITY = 85;
const REFUSED = 'CRITIC_STILLS_REFUSED';

// Отказ «кадры этой цели рисовать нельзя» – CLI отвечает на него кодом 2, а не сбоем.
function refuse(message) {
  const error = new Error(message);
  error.code = REFUSED;
  return error;
}

// Последний слой проекта – наибольший номер motion-vNN среди папок (номера не переиспользуются).
function latestLayerName(projectDir) {
  let best = null;
  for (const entry of fs.readdirSync(projectDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !LAYER_NAME.test(entry.name)) continue;
    if (!best || Number(entry.name.slice('motion-v'.length)) > Number(best.slice('motion-v'.length))) best = entry.name;
  }
  return best;
}

function readJsonFile(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label}: неверный JSON (${error.message})`);
    throw error;
  }
}

// layer check пишет out/manifest.json до гейтов, поэтому манифест есть и у слоя со СТОПом. Кадры
// критика рисуются только по пройденной проверке: отчёт qa/layer-<слой>-check.json этого слоя без
// провала и без ошибки (предупреждения допустимы), и судил он ровно этот манифест (sha256 байтов).
function assertLayerCheckPassed(projectDir, layerName, manifestSha256, check) {
  const { exitCodeFor, projectQaDir } = require('./report');
  const qaDir = projectQaDir(projectDir);
  const file = qaDir && path.join(qaDir, `layer-${layerName}-check.json`);
  if (!file || !fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
    throw refuse(`нет отчёта layer check слоя ${layerName} (qa/layer-${layerName}-check.json) – ${check}`);
  }
  let report;
  try {
    report = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    report = null;
  }
  if (report === null || typeof report !== 'object' || report.kind !== 'layer-check' || report.layer !== layerName
    || typeof report.summary?.status !== 'string') {
    throw refuse(`отчёт qa/layer-${layerName}-check.json не читается – ${check}`);
  }
  const checked = Array.isArray(report.inputs) ? report.inputs.find((input) => input?.role === 'manifest') : null;
  if (checked?.sha256 !== manifestSha256) {
    throw refuse(`отчёт layer check слоя ${layerName} относится к другому манифесту – ${check}`);
  }
  if (exitCodeFor(report) !== 0) {
    throw refuse(`layer check слоя ${layerName} не пройден (${report.summary.status === 'fail' ? 'СТОП' : 'оценить нельзя'}): `
      + `исправьте план по qa/layer-${layerName}-check.txt и снова ${check}`);
  }
}

function layerTarget(projectDir, manifest, layerName) {
  const { readCheckedManifest } = require('../layer/render');
  const layerDir = resolveProjectPath(projectDir, layerName, { label: 'layer', mustExist: true, type: 'directory' });
  const check = `сначала \`automontage layer check\` (automontage layer check --project-dir "${projectDir}" --layer ${layerName})`;
  if (!fs.statSync(path.join(layerDir, 'layer.json'), { throwIfNoEntry: false })?.isFile()) {
    throw refuse(`слой ${layerName} собран не до конца (нет layer.json) – создайте слой заново: automontage layer new --project-dir "${projectDir}"`);
  }
  if (!fs.statSync(path.join(layerDir, 'out', 'manifest.json'), { throwIfNoEntry: false })?.isFile()) {
    throw refuse(`у слоя ${layerName} нет out/manifest.json – ${check}, кадры критика рисуются по проверенному плану`);
  }
  const layer = readJsonFile(path.join(layerDir, 'layer.json'), 'layer.json');
  if (layer === null || typeof layer !== 'object' || Array.isArray(layer)) throw new Error('layer.json должен быть объектом');
  assertCompositionId(layer.composition, 'layer.json: composition');
  const sourcePath = resolveProjectPath(projectDir, manifest.source.localPath, { label: 'manifest.source.localPath', mustExist: true, type: 'file' });
  assertLayerSource({ projectDir, manifest, sourcePath, layerName }, layer);
  const { fps, width, height, durationInFrames } = layer;
  if (![fps, width, height, durationInFrames].every((v) => Number.isFinite(v) && v > 0)) {
    throw new Error('layer.json: fps, width, height и durationInFrames должны быть числами больше 0');
  }
  const { manifest: layerManifest, input: manifestInput } = readCheckedManifest(projectDir, layerDir);
  const srcSha256 = layerSrcSha256(layerDir);
  // Манифест от другого src/ (правка plan.js, words.js или компонентов после layer check, или старый
  // манифест без отпечатка) – моменты и проверенный план разошлись бы с тем, что нарисует композиция.
  if (layerManifest?.srcSha256 !== srcSha256) {
    throw refuse(`out/manifest.json слоя ${layerName} устарел: src/ менялась после проверки – ${check}`);
  }
  assertLayerCheckPassed(projectDir, layerName, manifestInput.sha256, check);
  return {
    kind: 'layer', projectDir, layerName, entry: path.join(layerDir, 'src', 'index.jsx'), compositionId: layer.composition,
    inputProps: {}, publicDir: path.join(layerDir, 'public'), width, height, fps, durationInFrames, durationSec: durationInFrames / fps,
    planPath: path.join(layerDir, 'src', 'plan.js'), sourceSha256: layer.source.sha256, srcSha256, manifest: layerManifest,
  };
}

function motionReelTarget(projectDir, manifest) {
  if (!manifest.currentBrief) throw refuse('у motion-reel ещё нет ТЗ – сначала automontage motion, кадры критика рисуются по черновику ТЗ');
  const planPath = resolveProjectPath(projectDir, manifest.currentBrief, { label: 'currentBrief', mustExist: true, type: 'file' });
  const brief = readJsonFile(planPath, manifest.currentBrief);
  if (brief?.kind !== 'motion-reel') throw refuse('критик только для моушн-роликов: текущее ТЗ проекта не motion-reel');
  if (brief.status !== 'draft') throw refuse('ТЗ уже утверждено – кадры критика рисуются по черновику до утверждения');
  const { prepareMotionPreview } = require('../motion/workflow');
  const { withPreviewMediaBundleAsync } = require('../render-media-bundle');
  const sourcePath = resolveProjectPath(projectDir, manifest.source.localPath, { label: 'manifest.source.localPath', mustExist: true, type: 'file' });
  const workspace = { dir: projectDir, manifest, sourcePath };
  const prepared = prepareMotionPreview({ workspace, brief });
  const sourceSha256 = hashFile(sourcePath);
  // Байты медиа сцен по порядку сцен: пересобранный под тем же путём пакет (ai-promo) меняет отпечаток.
  const mediaSha256 = (Array.isArray(brief.scenes) ? brief.scenes : [])
    .filter((scene) => scene?.scene === 'media' && typeof scene.media?.src === 'string')
    .map((scene) => hashFile(resolveProjectPath(projectDir, scene.media.src, { label: 'media.src', mustExist: true, type: 'file' })));
  const { props } = prepared;
  // Медиа сцен (staticFile) и голос живут в lease черновика – тот же, что у automontage preview.
  const withMedia = (operation) => withPreviewMediaBundleAsync({
    root: ROOT, workspace, props, previewBrief: brief, sourcePath, sourceAlias: prepared.previewMedia.sourceAlias,
    expectedSourceSha256: sourceSha256, namespace: `${manifest.slug || 'motion'}-critic`, temporaryId: crypto.randomUUID(),
  }, (lease) => operation({ inputProps: lease.props, publicDir: lease.publicDirectory }));
  return {
    kind: 'motion-reel', projectDir, entry: path.join(ROOT, 'src', 'index.js'), compositionId: prepared.composition,
    inputProps: props, publicDir: null, width: props.width, height: props.height, fps: props.fps,
    durationInFrames: props.durationInFrames, durationSec: props.durationInFrames / props.fps,
    planPath, briefSha256: hashFile(planPath), sourceSha256, mediaSha256, brief, withMedia,
  };
}

// Цель кадров: motion-reel (паспорт projectKind) или слой motion-vNN (--layer или последний). Проект
// без слоя и не motion-reel – урок: отказ «критик только для моушн-роликов». Слой без манифеста или
// без пройденного layer check – отказ «сначала `automontage layer check`». --layer у motion-reel –
// отказ. Все отказы – error.code REFUSED.
function resolveStillsTarget(projectDir, manifest, { layer = null } = {}) {
  if (manifest.projectKind === 'motion-reel') {
    if (layer !== null && layer !== undefined) {
      throw refuse('--layer – только для слоя motion-vNN: у motion-reel слоя нет, кадры рисуются по черновику ТЗ');
    }
    return motionReelTarget(projectDir, manifest);
  }
  if (layer !== null && layer !== undefined && !LAYER_NAME.test(String(layer))) throw new Error('--layer должен быть вида motion-v01');
  const layerName = layer || latestLayerName(projectDir);
  if (!layerName) {
    throw refuse('критик только для моушн-роликов: в проекте нет слоя motion-vNN и это не motion-reel. '
      + `Для своей съёмки или аватара сначала создайте слой: automontage layer new --project-dir "${projectDir}"`);
  }
  if (!fs.existsSync(path.join(projectDir, layerName))) throw refuse(`папка слоя ${layerName} не найдена`);
  return layerTarget(projectDir, manifest, layerName);
}

// sha256 от склейки по порядку: байты плана слоя (или ТЗ motion-reel), JSON входных props, sha256
// исходника спикера (или голоса), затем у слоя – srcSha256 всей папки src/ (компоненты, words.js),
// у motion-reel – sha256 медиа сцен по порядку. Отчёт критика привязывается к нему: правка – новые кадры.
function inputsSha256(target, readFile = fs.readFileSync) {
  const hash = crypto.createHash('sha256')
    .update(readFile(target.planPath))
    .update(Buffer.from(JSON.stringify(target.inputProps ?? {}), 'utf8'))
    .update(Buffer.from(String(target.sourceSha256), 'utf8'));
  if (target.kind === 'layer') {
    if (typeof target.srcSha256 !== 'string') throw new Error('inputsSha256: у слоя нет srcSha256');
    hash.update(Buffer.from(target.srcSha256, 'utf8'));
  } else if (target.kind === 'motion-reel') {
    for (const sha of target.mediaSha256 ?? []) hash.update(Buffer.from(String(sha), 'utf8'));
  }
  return hash.digest('hex');
}

// Устарели ли кадры индекса qa/moments-stills-*.json: null – актуальны, иначе причина. Дёшево, без
// Remotion: у слоя – это последний слой проекта и тот же inputsSha256 по его файлам (src/plan.js,
// sha256 исходника из layer.json, отпечаток всей src/); у motion-reel пересчёт
// props тяжёлый, поэтому сверяется sha256 файла текущего ТЗ с briefSha256 индекса (медиа сцен
// записаны в ТЗ со своим sha256, так что их смена тоже меняет ТЗ).
function stillsIndexStale(projectDir, manifest, index) {
  try {
    if (index?.kind === 'layer') {
      if (!LAYER_NAME.test(String(index.layer))) return 'в индексе нет имени слоя';
      // Preview соберут из последнего слоя: кадры более раннего слоя критику уже не про то.
      const latest = latestLayerName(projectDir);
      if (latest !== index.layer) return `кадры слоя ${index.layer}, а последний слой проекта ${latest ?? 'не найден'}`;
      const layerDir = resolveProjectPath(projectDir, index.layer, { label: 'layer', mustExist: true, type: 'directory' });
      const layer = readJsonFile(path.join(layerDir, 'layer.json'), 'layer.json');
      const current = inputsSha256({
        kind: 'layer', planPath: path.join(layerDir, 'src', 'plan.js'), inputProps: {},
        sourceSha256: layer?.source?.sha256, srcSha256: layerSrcSha256(layerDir),
      });
      return current === index.inputsSha256 ? null : `src/ или layer.json слоя ${index.layer} менялись после кадров`;
    }
    if (index?.kind === 'motion-reel') {
      if (!manifest.currentBrief) return 'у проекта нет текущего ТЗ';
      const briefPath = resolveProjectPath(projectDir, manifest.currentBrief, { label: 'currentBrief', mustExist: true, type: 'file' });
      return hashFile(briefPath) === index.briefSha256 ? null : 'ТЗ менялось после кадров';
    }
    return 'индекс старого формата (без kind)';
  } catch (error) {
    return `входы кадров не прочитаны: ${error.message}`;
  }
}

// deps: bundle/openBrowser/selectComposition/renderStill – Remotion (по умолчанию как у text-boxes),
// acquireSlot – занятие слота очереди (контракт acquireHeavySlotSync), tile – плитка листов,
// edgeShare(file) – доля краёв кадра для G12, tmpdir – где создать временную папку бандла. Тесты
// подменяют их без Chrome и ffmpeg. sha – уже посчитанный inputsSha256(target) (из него вызывающий
// составил имя), чтобы имя и индекс не разошлись; без него считается здесь.
async function renderMomentStills({ target, moments, outDir, name, sha = inputsSha256(target), log = console.warn }, deps = {}) {
  const sheet = require('../layer/sheet');
  const remotion = ['bundle', 'openBrowser', 'selectComposition', 'renderStill'].every((key) => deps[key])
    ? deps : { ...require('./text-boxes').defaultDeps(), ...deps };
  const acquireSlot = deps.acquireSlot || acquireHeavySlotSync;
  const tile = deps.tile || sheet.tileMomentFrames;
  const edgeShare = deps.edgeShare || ((file) => sheet.frameEdgeShare(file, null));
  const tmpdir = deps.tmpdir || os.tmpdir;
  fs.mkdirSync(outDir, { recursive: true });
  const work = path.join(outDir, `${name}.frames-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  const slot = acquireSlot({ label: `critic stills ${path.basename(target.projectDir)}`, config: heavyQueueConfig(), log });
  let bundleDir = null;
  try {
    fs.mkdirSync(path.join(work, 'frames'), { recursive: true });
    bundleDir = fs.mkdtempSync(path.join(tmpdir(), 'automontage-critic-stills-'));
    const files = [];
    const draw = async ({ inputProps, publicDir }) => {
      let browser = null;
      try {
        const serveUrl = await remotion.bundle({
          entryPoint: target.entry, publicDir: publicDir || null, rootDir: ROOT, outDir: path.join(bundleDir, 'bundle'),
          symlinkPublicDir: process.platform !== 'win32',
        });
        try {
          browser = await remotion.openBrowser();
        } catch (error) {
          throw new Error(`Chrome для кадров критика не запустился: ${error?.message ?? String(error)}`, { cause: error });
        }
        const composition = await remotion.selectComposition({ serveUrl, id: target.compositionId, inputProps, puppeteerInstance: browser });
        const scale = CRITIC_LONG_SIDE / Math.max(composition.width, composition.height);
        const last = Math.max(0, composition.durationInFrames - 1);
        for (const [i, moment] of moments.entries()) {
          const frame = Math.min(last, Math.max(0, Math.round(moment.timeSec * composition.fps)));
          const file = path.join(work, 'frames', `${String(i + 1).padStart(2, '0')}-${Number(moment.timeSec.toFixed(3))}.jpg`);
          await remotion.renderStill({
            serveUrl, composition, frame, inputProps, puppeteerInstance: browser, output: file,
            imageFormat: 'jpeg', jpegQuality: JPEG_QUALITY, scale, overwrite: true, onBrowserLog: () => {},
          });
          if (!fs.statSync(file, { throwIfNoEntry: false })?.size) throw new Error(`кадр ${frame} не нарисован`);
          files.push({ file, moment });
        }
      } finally {
        if (browser) await browser.close({ silent: true });
      }
    };
    if (target.withMedia) await target.withMedia(draw);
    else await draw({ inputProps: target.inputProps, publicDir: target.publicDir });

    const { sheetPath, phonePath } = tile(files.map(({ file }) => ({ file })), { outDir, name, width: target.width, height: target.height });
    const samples = files.map(({ file, moment }) => {
      const share = edgeShare(file);
      return share === null ? null : { timeSec: moment.timeSec, edgeShare: share };
    });
    // Готовые кадры заменяют прежние того же имени только целиком и только после успеха.
    const framesDir = path.join(outDir, name);
    fs.rmSync(framesDir, { recursive: true, force: true });
    fs.renameSync(path.join(work, 'frames'), framesDir);
    const entries = files.map(({ file, moment }) => ({
      file: relative(target.projectDir, path.join(framesDir, path.basename(file))),
      timeSec: moment.timeSec, kind: moment.kind, ref: moment.ref, label: moment.label,
    }));
    const indexPath = path.join(outDir, `${name}.json`);
    const identity = target.kind === 'layer' ? { kind: 'layer', layer: target.layerName }
      : { kind: target.kind, briefSha256: target.briefSha256 };
    writeJson(indexPath, { version: 1, source: 'stills', format: sheet.frameFormat(target.width, target.height), inputsSha256: sha, ...identity, moments: entries });
    log(`кадров для критика: ${entries.length}`);
    return { framesDir, sheetPath, phonePath, indexPath, inputsSha256: sha, gate: emptyFrameGate(samples) };
  } finally {
    // Слот – первым: сбой уборки не должен держать очередь тяжёлых задач.
    slot.release();
    try {
      fs.rmSync(work, { recursive: true, force: true });
    } finally {
      if (bundleDir) fs.rmSync(bundleDir, { recursive: true, force: true });
    }
  }
}

module.exports = { CRITIC_LONG_SIDE, JPEG_QUALITY, REFUSED, inputsSha256, renderMomentStills, resolveStillsTarget, stillsIndexStale };
