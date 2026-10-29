#!/usr/bin/env node
const fs = require('node:fs');
const { isCleanPreview, previewScale, previewSize } = require('./working-quality');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');

const { remotionRenderCommand } = require('./build-commands');
const {
  ROOT,
  configureMediaToolPath,
  resolveRemotionCommand,
} = require('./env');
const { REMOTION_AUDIO_ADVANCE_MS } = require('./finish-audio');
const { loadExtTheme } = require('./load-ext-theme');
const { validateStoredBrief } = require('./project/brief-contract');
const { prepareMotionPreview } = require('./motion/workflow');
const { prepareLessonPreview } = require('./lesson/preview');
const { probeVideo } = require('./media-probe');
const { runNodeTool, runTool } = require('./process');
const { runPreviewGates } = require('./qa/preview-gates');
const { formatMotionReport, runMotionPreviewGates } = require('./qa/motion-preview-gates');
const { formatReport } = require('./qa/report');
const {
  planPreview,
  publishCurrentPreview,
} = require('./project/preview-workspace');
const {
  readProjectManifest,
  resolveProjectPath,
} = require('./project/workspace');
const { withPreviewMediaBundle } = require('./render-media-bundle');
const { kitFastPathCommand, planKitFastPath } = require('./layer/fast-preview');
const { acquireHeavySlotSync, heavyQueueConfig, HEAVY_QUEUE_BUSY } = require('./heavy-queue');

function parsePreviewOptions(argv) {
  const options = {
    projectDir: null,
    briefPath: null,
    fromSec: undefined,
    toSec: undefined,
    open: true,
  };
  const valueOptions = new Map([
    ['--project-dir', 'projectDir'],
    ['--brief', 'briefPath'],
    ['--from-sec', 'fromSec'],
    ['--to-sec', 'toSec'],
  ]);
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--no-open') {
      if (seen.has(argument)) throw new Error('duplicate preview option');
      seen.add(argument);
      options.open = false;
      continue;
    }
    const key = valueOptions.get(argument);
    if (!key || seen.has(argument)) throw new Error('unknown or duplicate preview option');
    seen.add(argument);
    const value = argv[index + 1];
    if (typeof value !== 'string' || !value || value.startsWith('--')) {
      throw new Error(`${argument} requires a value`);
    }
    index += 1;
    options[key] = key === 'fromSec' || key === 'toSec' ? Number(value) : value;
  }
  if (!options.projectDir || !options.briefPath) {
    throw new Error('preview requires --project-dir and --brief');
  }
  options.projectDir = path.resolve(options.projectDir);
  if ((options.fromSec === undefined) !== (options.toSec === undefined)) {
    throw new Error('preview range requires both --from-sec and --to-sec');
  }
  return options;
}

function openMediaFile(filename, { spawnSyncImpl = spawnSync } = {}) {
  let command;
  let args;
  if (process.platform === 'darwin') {
    command = 'open';
    args = [filename];
  } else if (process.platform === 'win32') {
    command = 'rundll32.exe';
    args = ['url.dll,FileProtocolHandler', filename];
  } else {
    command = 'xdg-open';
    args = [filename];
  }
  const result = spawnSyncImpl(command, args, { shell: false, stdio: 'ignore' });
  if (result.error || result.status !== 0) {
    throw new Error('preview is ready but the system browser could not be opened');
  }
}

function resolveBriefPath(workspace, requested) {
  let stored = requested;
  if (path.isAbsolute(requested)) {
    const relative = path.relative(workspace.dir, requested);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`)
      || path.isAbsolute(relative)) {
      throw new Error('preview brief must stay inside the project workspace');
    }
    stored = relative.split(path.sep).join('/');
  }
  const resolved = resolveProjectPath(workspace.dir, stored, {
    label: 'preview brief path', mustExist: true, type: 'file',
  });
  const relative = path.relative(workspace.dir, resolved).split(path.sep).join('/');
  if (workspace.manifest.currentBrief !== relative) {
    throw new Error('preview requires the current persisted draft brief');
  }
  return resolved;
}

function cleanupPreviewStages(paths, fileSystem) {
  for (const target of paths) {
    try {
      const stat = fileSystem.lstatSync(target);
      if (!stat.isSymbolicLink() && stat.isFile()) fileSystem.unlinkSync(target);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
  }
}

// Props чистого preview – те же, что у рендера финала: без ключа draftPreview (надпись «ЧЕРНОВИК» тогда
// показывают плееры пульта и Review поверх видео, пока brief не утверждён).
function cleanPreviewProps(props) {
  const { draftPreview, ...clean } = props;
  return clean;
}

function runPreview(options, dependencies = {}) {
  const fileSystem = dependencies.fileSystem || fs;
  const readProjectManifestImpl = dependencies.readProjectManifestImpl || readProjectManifest;
  const prepareLessonPreviewImpl = dependencies.prepareLessonPreviewImpl || prepareLessonPreview;
  const withPreviewMediaBundleImpl = dependencies.withPreviewMediaBundleImpl
    || withPreviewMediaBundle;
  const resolveRemotionCommandImpl = dependencies.resolveRemotionCommandImpl
    || resolveRemotionCommand;
  const runToolImpl = dependencies.runToolImpl || runTool;
  const runNodeToolImpl = dependencies.runNodeToolImpl || runNodeTool;
  const probeVideoImpl = dependencies.probeVideoImpl || probeVideo;
  const publishCurrentPreviewImpl = dependencies.publishCurrentPreviewImpl
    || publishCurrentPreview;
  const openMediaFileImpl = dependencies.openMediaFileImpl || openMediaFile;
  const runPreviewGatesImpl = dependencies.runPreviewGatesImpl || runPreviewGates;
  const runMotionPreviewGatesImpl = dependencies.runMotionPreviewGatesImpl || runMotionPreviewGates;
  const planKitFastPathImpl = dependencies.planKitFastPathImpl || planKitFastPath;
  const log = dependencies.log || console.log;
  const now = dependencies.now || (() => new Date());
  const temporaryId = dependencies.temporaryId || randomUUID;

  const projectDir = path.resolve(options.projectDir);
  const manifest = readProjectManifestImpl(projectDir);
  const manifestHash = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
  if (process.env.AUTOMONTAGE_PREVIEW_MANIFEST_HASH && process.env.AUTOMONTAGE_PREVIEW_MANIFEST_HASH !== manifestHash) throw new Error('preview base changed');
  const workspace = { dir: projectDir, manifest };
  const briefPath = resolveBriefPath(workspace, options.briefPath);
  const briefBytes = fileSystem.readFileSync(briefPath);
  const brief = JSON.parse(briefBytes.toString('utf8'));
  const briefSha256 = createHash('sha256').update(briefBytes).digest('hex');
  const sourceVideo = resolveProjectPath(projectDir, manifest.source.localPath, {
    label: 'manifest.source.localPath', fileSystem, mustExist: true, type: 'file',
  });
  if (process.env.AUTOMONTAGE_PREVIEW_BRIEF_HASH && process.env.AUTOMONTAGE_PREVIEW_BRIEF_HASH !== createHash('sha256').update(JSON.stringify(brief)).digest('hex')) throw new Error('preview base changed');
  const sourceSha256 = require('./project/preview-workspace').hashFile(fileSystem, sourceVideo);
  const kind = validateStoredBrief({ manifest, briefPath: manifest.currentBrief, brief });
  workspace.sourcePath = sourceVideo;
  if (kind === 'motion-reel') {
    const audio = require('./motion/source').probeAudioPath(sourceVideo, {
      ...(dependencies.probeOpenedAudioImpl ? { probeOpenedAudioImpl: dependencies.probeOpenedAudioImpl } : {}),
    });
    if (Math.abs(brief.output.durationInFrames / brief.output.fps - audio.durationSec) > 1 / brief.output.fps + 0.001) {
      throw new Error('motion narration duration does not match the draft output');
    }
  }
  const externalTheme = kind === 'motion-reel' ? null : loadExtTheme(brief.theme);
  const prepareOptions = { brief, theme: externalTheme || brief.theme, sourceVideo };
  if (options.fromSec !== undefined || options.toSec !== undefined) {
    prepareOptions.fromSec = options.fromSec;
    prepareOptions.toSec = options.toSec;
  }
  const prepared = kind === 'motion-reel'
    ? prepareMotionPreview({ workspace, ...prepareOptions })
    : prepareLessonPreviewImpl(prepareOptions);
  const scale = previewScale(prepared.props);
  const clean = isCleanPreview({ range: prepared.range, size: prepared.props });
  if (clean) prepared.props = cleanPreviewProps(prepared.props);
  const planned = planPreview(workspace, {
    briefPath,
    briefSha256,
    sourceSha256,
    manifestHash,
    range: prepared.range,
    temporaryId,
    fileSystem,
  });
  const stages = [planned.propsPath, planned.rawPath, planned.finishedPath, planned.mixedPath];
  let stagedOutput = planned.finishedPath;
  let gateResult = null;
  const slot = (dependencies.acquireSlotSync || acquireHeavySlotSync)({
    label: `preview ${path.basename(projectDir)}`, config: heavyQueueConfig(), log,
  });
  try {
    // Звук после Remotion/быстрого пути: finish.js, музыка и барьер – одинаково для обоих путей.
    const finishAndGate = ({ audioAdvanceMs, musicPath }) => {
      runNodeToolImpl(path.join(ROOT, 'scripts', 'finish.js'), [
        planned.rawPath,
        planned.finishedPath,
        '--hdrfix', 'auto',
        '--audio-advance-ms', String(audioAdvanceMs),
      ], { cwd: ROOT, stage: 'preview finish' });
      if (prepared.music) {
        runNodeToolImpl(path.join(ROOT, 'scripts', 'mix-music.js'), [
          planned.finishedPath,
          musicPath,
          planned.mixedPath,
          ...prepared.music.mixArgs,
        ], { cwd: ROOT, stage: 'preview music mix' });
        stagedOutput = planned.mixedPath;
      }
      // Барьер: по настоящим дорожкам этого preview (голос после finish.js, музыка того же пути). motion-reel
      // сюда не входит – его brief не lesson и не собирается через layer brief; у него свой барьер ниже.
      if (kind !== 'motion-reel') {
        gateResult = runPreviewGatesImpl({
          projectDir, brief, manifest, hasMusic: Boolean(prepared.music), range: prepared.range, sourceSha256,
          sourcePath: sourceVideo, briefPath, briefSha256,
          finishedPath: planned.finishedPath,
          musicPath: prepared.music ? musicPath : null,
          mixArgs: prepared.music ? prepared.music.mixArgs : null,
        }, { now });
      }
    };
    // Быстрый путь слоя kit (#110, D-051): одна полноразмерная сцена проверенного слоя – кадры из слоя без
    // Remotion, звук той же смесью, что у ReelScenes. Иначе – обычный рендер.
    const fast = kind === 'motion-reel' ? null : planKitFastPathImpl({
      projectDir, brief, props: prepared.props, range: prepared.range, clean, sourceSha256,
    });
    if (fast && !fast.reason) {
      log('быстрый путь слоя kit: кадры берутся из проверенного слоя, без рендера Remotion');
      const command = kitFastPathCommand({
        layerPath: fast.layerPath, sourcePath: sourceVideo, output: planned.rawPath,
        frames: fast.frames, fps: fast.fps, audioMode: fast.audioMode, layerFrames: fast.layerFrames,
      });
      runToolImpl(command.command, command.args, { cwd: ROOT, stage: 'preview kit layer' });
      // Звук собран без задержки Remotion: сдвигать его в finish.js не нужно.
      finishAndGate({ audioAdvanceMs: 0, musicPath: prepared.music?.sourcePath });
    } else {
      if (fast?.kit) log(`быстрый путь слоя kit недоступен (${fast.reason}) – рендер Remotion`);
      withPreviewMediaBundleImpl({
        root: ROOT,
        workspace,
        props: prepared.props,
        previewBrief: prepared.previewMedia.brief,
        sourcePath: prepared.previewMedia.sourcePath,
        sourceAlias: prepared.previewMedia.sourceAlias,
        ...(kind === 'motion-reel' ? { expectedSourceSha256: sourceSha256 } : {}),
        namespace: `${manifest.slug}-preview`,
        temporaryId: temporaryId(),
        fileSystem,
      }, (lease) => {
        if (kind === 'motion-reel') {
          if (lease.sourceSha256 !== sourceSha256) throw new Error('preview narration snapshot hash mismatch');
          // Publication records the digest of the bytes actually copied for Remotion.
          planned.sourceSha256 = lease.sourceSha256;
        }
        fileSystem.writeFileSync(planned.propsPath, `${JSON.stringify(lease.props, null, 2)}\n`);
        const command = remotionRenderCommand(resolveRemotionCommandImpl(ROOT), {
          entry: 'src/index.js',
          composition: prepared.composition,
          output: planned.rawPath,
          props: planned.propsPath,
          publicDir: lease.publicDirectory,
          scale,
          crf: clean ? null : 28,
          frameRange: prepared.range.kind === 'excerpt' ? prepared.range : null,
          concurrency: '50%',
          overwrite: true,
        });
        runToolImpl(command.command, command.args, { cwd: ROOT, stage: 'preview Remotion' });
        finishAndGate({
          audioAdvanceMs: REMOTION_AUDIO_ADVANCE_MS,
          musicPath: prepared.music ? (lease.musicPath || prepared.music.sourcePath) : null,
        });
      });
    }

    // Сначала вердикт, потом решение. Стоп – до полного декодирования: прошлый preview остаётся, промежуточные
    // файлы убирает finally. Слой kit без записанного отчёта не публикуется; прочим роликам сбой записи не мешает.
    if (gateResult) log(formatReport(gateResult.report));
    if (gateResult?.writeError) {
      if (gateResult.enforced) throw new Error(`preview не опубликован: отчёт проверок не записан (${gateResult.writeError})`);
      log(`⚠️ отчёт проверок не записан: ${gateResult.writeError}`);
    }
    if (gateResult?.block) {
      throw new Error(`preview не опубликован: проверки не пройдены (${gateResult.paths?.textPath || 'qa/'})`);
    }

    // Барьер motion-reel (#43, D-049): чёрные провалы, громкость −14 LUFS / −1,5 dBTP (только полный ролик),
    // одна дорожка 48 кГц, размер и FPS кадра – по собранному файлу до публикации. Обхода нет: при fail
    // прошлый preview остаётся, отчёт – в qa/motion-preview-<label>.json.
    if (kind === 'motion-reel') {
      const { width, height } = previewSize(prepared.props);
      const motionGates = runMotionPreviewGatesImpl({
        projectDir, videoPath: stagedOutput, range: prepared.range,
        expected: { width, height, fps: prepared.props.fps, totalSec: brief.output.durationInFrames / brief.output.fps },
      }, { now, cwd: ROOT });
      log(formatMotionReport(motionGates));
      const where = motionGates.reportPath ? path.relative(projectDir, motionGates.reportPath).split(path.sep).join('/') : 'qa/';
      if (motionGates.writeError) {
        throw new Error(`preview не опубликован: отчёт проверок motion не записан (${motionGates.writeError})`);
      }
      if (motionGates.block) {
        throw new Error(`preview не опубликован: проверки motion не пройдены (${where})`);
      }
    }

    runToolImpl('ffmpeg', [
      '-v', 'error', '-i', stagedOutput, '-f', 'null', '-',
    ], { cwd: ROOT, stage: 'preview decode' });
    const probe = probeVideoImpl(stagedOutput, { cwd: ROOT, stage: 'preview ffprobe' });
    const { width: expectedWidth, height: expectedHeight } = previewSize(prepared.props);
    const expectedDuration = prepared.range.toSec - prepared.range.fromSec;
    if (probe.width !== expectedWidth || probe.height !== expectedHeight
      || Math.abs(probe.fps - prepared.props.fps) > 1e-6
      || Math.abs(probe.duration - expectedDuration) > Math.max(0.08, 1 / prepared.props.fps)) {
      throw new Error('preview output metadata does not match the requested composition range');
    }
    const generatedAt = now().toISOString();
    const published = publishCurrentPreviewImpl(workspace, planned, stagedOutput, {
      width: probe.width,
      height: probe.height,
      fps: probe.fps,
      generatedAt,
      quality: clean ? 'final' : 'draft',
    }, { fileSystem, temporaryId });
    if (options.open !== false) {
      // The preview is already saved and registered: a browser failure is a warning, not a cancel.
      try { openMediaFileImpl(published.currentPath); } catch (error) { return { ...published, openError: error.message }; }
    }
    return published;
  } finally {
    try { cleanupPreviewStages(stages, fileSystem); } finally { slot.release(); }
  }
}

function previewOpenWarning(currentPath) {
  return `⚠️ preview сохранён, но системный браузер не открылся: ${currentPath}. Открой файл вручную; `
    + 'в среде без браузера запускай preview с --no-open';
}

function main(argv = process.argv.slice(2)) {
  try {
    configureMediaToolPath();
    const result = runPreview(parsePreviewOptions(argv));
    const label = result.metadata.kind === 'full'
      ? 'ПОЛНЫЙ РОЛИК'
      : `ФРАГМЕНТ ${result.metadata.fromSec.toFixed(2)}–${result.metadata.toSec.toFixed(2)} сек`;
    console.log(`✅ СМОНТИРОВАННЫЙ ПРЕДПРОСМОТР: ${result.currentPath}`);
    console.log(`   ${label}`);
    if (result.openError) console.warn(previewOpenWarning(result.currentPath));
  } catch (error) {
    console.error(error.code === HEAVY_QUEUE_BUSY
      ? `❌ preview не опубликован: ${error.message}`
      : `❌ preview отменён: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  cleanPreviewProps,
  main,
  openMediaFile,
  previewOpenWarning,
  parsePreviewOptions,
  runPreview,
};
