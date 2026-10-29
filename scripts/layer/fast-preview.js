// Быстрый путь preview для слоя kit (#110, DECISIONS.md D-051). layer brief делает одну полноразмерную
// broll-сцену на весь хронометраж с overlay "none": Remotion при этом покадрово перегоняет через Chrome уже
// готовое видео слоя – это основная стоимость preview и финала. Здесь кадры берутся из самого слоя (видео
// копируется без перекодирования), а звук собирается так же, как его смешивает ReelScenes: голос исходника по
// глобальному таймкоду + звук слоя −18 дБ с огибающей сцены 0,12 с (src/scenes/BrollMedia.jsx), audio mix|mute.
// Дальше – тот же finish.js и mix-music.js, те же барьеры preview. Эквивалентность с рендером Remotion
// закреплена тестом tests/layer-fast-preview-equivalence.test.js (кадры по SSIM, громкость и форма звука).
//
// Путь включается только когда результат заведомо тот же: чистый полный preview (масштаб 1), одна сцена broll
// от 0 до конца, видео слоя из реестра qa/layer-imports.json с целым отчётом layer render (G6/G7 пройдены) для
// текущего исходника, overlay "none", fit cover, без сдвига начала, размер и FPS слоя равны выводу, слой не
// короче ролика, байты слоя равны sha256 из brief. Любое другое условие – обычный рендер Remotion.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

// Те же числа, что в src/scenes/BrollMedia.jsx (MIX_GAIN, fadeFramesForFps).
const MIX_GAIN_DB = -18;
const SCENE_FADE_SEC = 0.12;
const AUDIO_RATE = 48000;

const fadeFrames = (fps) => Math.max(1, Math.round(SCENE_FADE_SEC * fps));

function hashFile(filename) {
  const hash = createHash('sha256');
  const descriptor = fs.openSync(filename, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let read;
    while ((read = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, read));
  } finally { fs.closeSync(descriptor); }
  return hash.digest('hex');
}

// Число кадров видеопотока слоя – по пакетам, без декодирования (у H.264 один пакет – один кадр).
function countVideoFrames(filename) {
  const { captureTool } = require('../process');
  const out = captureTool('ffprobe', ['-v', 'error', '-count_packets', '-select_streams', 'v:0',
    '-show_entries', 'stream=nb_read_packets', '-of', 'default=nk=1:nw=1', filename], { stage: 'kit layer frames', maxBuffer: 64 * 1024 });
  const frames = Number.parseInt(String(out).trim(), 10);
  if (!Number.isSafeInteger(frames) || frames <= 0) throw new Error('kit layer frames: ffprobe не вернул число кадров');
  return frames;
}

// Проблема записи реестра для видео слоя, или null: тот же приговор, что у барьера L preview.
function defaultRegistryProblem(projectDir, media, sourceSha256) {
  const { readRegistry } = require('./registry');
  const { entryProblem } = require('../qa/preview-gates');
  const entry = readRegistry(projectDir).imports.find((item) => item?.canonicalSha256 === media.sha256);
  if (!entry) return 'видео не импортировано как слой kit';
  return entryProblem(projectDir, entry, sourceSha256);
}

// План быстрого пути: { layerPath, audioMode, frames, fps, durationSec } или { reason } – почему нельзя.
function planKitFastPath({ projectDir, brief, props, range, clean, sourceSha256 }, deps = {}) {
  const refuse = (reason) => ({ reason });
  if (!clean || range?.kind !== 'full') return refuse('не чистый полный preview');
  const scenes = Array.isArray(brief?.scenes) ? brief.scenes : [];
  if (scenes.length !== 1 || scenes[0]?.scene !== 'broll') return refuse('не одна сцена broll');
  const scene = scenes[0];
  const media = scene.brollMedia;
  const { fps, width, height, durationInFrames } = props;
  if (scene.start !== 0 || Math.round(scene.end * fps) < durationInFrames) return refuse('сцена не на весь ролик');
  if (media?.kind !== 'video' || media.overlay !== 'none' || (media.fit ?? 'cover') !== 'cover'
    || Number(media.trimStartSec ?? 0) !== 0 || !['mix', 'mute'].includes(media.audioMode)
    || typeof media.sha256 !== 'string' || typeof media.src !== 'string') {
    return refuse('сцена не чистый полноразмерный слой');
  }
  // Дальше brief уже выглядит как слой kit: причину отказа preview напишет в лог.
  const refuseKit = (reason) => ({ reason, kit: true });
  const problem = (deps.registryProblem || defaultRegistryProblem)(projectDir, media, sourceSha256);
  if (problem) return problem === 'видео не импортировано как слой kit' ? refuse(problem) : refuseKit(`слой не прошёл проверку реестра: ${problem}`);
  const { resolveProjectPath } = require('../project/workspace');
  let layerPath;
  try {
    layerPath = resolveProjectPath(projectDir, media.src, { mustExist: true, type: 'file' });
  } catch (_) {
    return refuseKit('файла слоя нет в проекте');
  }
  const probe = (deps.probeImpl || require('../media-probe').probeVideo)(layerPath, { stage: 'kit layer probe' });
  if (probe.width !== width || probe.height !== height || Math.abs(probe.fps - fps) > 1e-6) {
    return refuseKit('размер или FPS слоя не совпадают с выводом');
  }
  if (Math.round(probe.duration * fps) < durationInFrames) return refuseKit('слой короче ролика');
  const layerFrames = (deps.countFramesImpl || countVideoFrames)(layerPath);
  if (layerFrames < durationInFrames) return refuseKit('слой короче ролика');
  if ((deps.hashImpl || hashFile)(layerPath) !== media.sha256) return refuseKit('байты слоя не совпадают с brief');
  return { layerPath, layerFrames, audioMode: media.audioMode, frames: durationInFrames, fps, durationSec: durationInFrames / fps };
}

const seconds = (value) => Number(value.toFixed(6)).toString();

// ffmpeg: видео слоя копией, если в нём ровно frames кадров. Слой длиннее (допуск layer brief – кадр)
// перекодируется до frames кадров: копия по пакетам в порядке декодирования могла бы потерять или подменить
// последние кадры с B-кадрами. CRF 18 – как у рендера Remotion по умолчанию. Звук – голос исходника и звук
// слоя с огибающей сцены.
// Огибающая повторяет brollEnvelope покадрово: min(кадр/fade, (N−1−кадр)/fade), зажатая в [0, 1].
function kitFastPathCommand({ layerPath, sourcePath, output, frames, fps, audioMode, layerFrames = frames }) {
  const durationSec = frames / fps;
  const end = seconds(durationSec);
  const voice = `[1:a]aresample=${AUDIO_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=end=${end},asetpts=PTS-STARTPTS`;
  let filter;
  if (audioMode === 'mix') {
    const fade = fadeFrames(fps);
    const frame = `floor(t*${fps}+0.000001)`;
    const envelope = `max(0,min(1,min(${frame}/${fade},(${frames - 1}-${frame})/${fade})))`;
    const gain = 10 ** (MIX_GAIN_DB / 20);
    filter = `${voice}[voice];`
      + `[0:a]aresample=${AUDIO_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=end=${end},asetpts=PTS-STARTPTS,`
      + `volume='${gain.toFixed(8)}*${envelope}':eval=frame[sfx];`
      + '[voice][sfx]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]';
  } else {
    filter = `${voice}[a]`;
  }
  return {
    command: 'ffmpeg',
    args: [
      '-v', 'error', '-y',
      '-i', layerPath,
      '-i', sourcePath,
      '-filter_complex', filter,
      '-map', '0:v:0',
      ...(layerFrames === frames ? ['-c:v', 'copy'] : ['-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast', '-pix_fmt', 'yuv420p']),
      '-frames:v', String(frames),
      '-map', '[a]', '-c:a', 'aac', '-b:a', '320k', '-ar', String(AUDIO_RATE),
      '-movflags', '+faststart',
      output,
    ],
  };
}

module.exports = { MIX_GAIN_DB, SCENE_FADE_SEC, fadeFrames, kitFastPathCommand, planKitFastPath };
