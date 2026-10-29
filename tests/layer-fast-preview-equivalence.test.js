// Эквивалентность быстрого пути preview слоя kit (#110, D-051) и настоящего рендера Remotion ReelScenes на
// коротком фикстурном слое: кадры (SSIM по маске, как preview-final-equivalence) и звук (громкость, форма
// огибающей слоя и голоса, синхрон). Тяжёлый тест – настоящий Remotion: в npm test пропускается, запускается
// отдельно (TESTING.md, шаг CI с настоящими preview):
//   node --test --test-concurrency=1 tests/layer-fast-preview-equivalence.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { remotionRenderCommand } = require('../scripts/build-commands');
const { resolveRemotionCommand } = require('../scripts/env');
const { REMOTION_AUDIO_ADVANCE_MS } = require('../scripts/finish-audio');
const { verifyPreviewFinalEquivalence } = require('../scripts/benchmark-preview');
const { kitFastPathCommand } = require('../scripts/layer/fast-preview');

const ROOT = path.resolve(__dirname, '..');
const W = 640;
const H = 360;
const FPS = 25;
const SECONDS = 3;
const FRAMES = SECONDS * FPS;
const RATE = 48000;
const WINDOW_SEC = 0.02;

function run(command, args) {
  return execFileSync(command, args, { cwd: ROOT, timeout: 600000, maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

// Полоса частот одной дорожки финиша как моно float: голос фикстуры – 220 Гц, звук слоя – 880 Гц.
function band(file, frequency) {
  const raw = run('ffmpeg', ['-v', 'error', '-i', file, '-af', `bandpass=f=${frequency}:width_type=q:w=8,pan=mono|c0=0.5*c0+0.5*c1`,
    '-f', 'f32le', '-ac', '1', '-ar', String(RATE), '-']);
  return new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 4));
}

// RMS окнами по 20 мс в дБ.
function envelope(samples) {
  const size = Math.round(RATE * WINDOW_SEC);
  const out = [];
  for (let start = 0; start + size <= samples.length; start += size) {
    let sum = 0;
    for (let i = start; i < start + size; i += 1) sum += samples[i] * samples[i];
    out.push(10 * Math.log10(sum / size + 1e-12));
  }
  return out;
}

function loudness(file) {
  const { spawnSync } = require('node:child_process');
  const result = spawnSync('ffmpeg', ['-hide_banner', '-i', file, '-vn', '-af', 'loudnorm=print_format=summary', '-f', 'null', '-'], { cwd: ROOT, encoding: 'utf8' });
  const match = /Input Integrated:\s*(-?[0-9.]+)\s*LUFS/u.exec(result.stderr);
  assert.ok(match, 'ffmpeg не вернул громкость');
  return Number(match[1]);
}

// Сдвиг (в окнах) с наибольшей корреляцией двух огибающих – синхрон звука.
function bestLag(a, b, maxLag = 6) {
  let best = { lag: 0, score: -Infinity };
  for (let lag = -maxLag; lag <= maxLag; lag += 1) {
    let score = 0;
    for (let i = maxLag; i < Math.min(a.length, b.length) - maxLag; i += 1) score += a[i] * b[i + lag];
    if (score > best.score) best = { lag, score };
  }
  return best.lag;
}

const heavy = process.env.npm_lifecycle_event === 'test';

test('kit layer fast path matches the Remotion ReelScenes render: frames, loudness and audio shape', {
  timeout: 600000,
  skip: heavy ? 'Настоящий Remotion: node --test tests/layer-fast-preview-equivalence.test.js' : false,
}, (t) => {
  const dir = path.join(ROOT, 'tmp', 'layer-fast-preview-equivalence', `${Date.now()}-${process.pid}`);
  fs.mkdirSync(dir, { recursive: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const remotion = resolveRemotionCommand(ROOT);
  run(remotion.command, [...remotion.argsPrefix, 'browser', 'ensure']);

  // Исходник: голос – прерывистый тон 220 Гц. Слой: свой рисунок и ровный тон 880 Гц – огибающая сцены видна.
  const publicDir = path.join(dir, 'public');
  fs.mkdirSync(publicDir);
  const source = path.join(publicDir, 'source.mp4');
  const layer = path.join(publicDir, 'layer.mp4');
  run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=${W}x${H}:r=${FPS}:d=${SECONDS}`,
    '-f', 'lavfi', '-i', `aevalsrc='0.5*sin(2*PI*220*t)*gt(sin(2*PI*1.5*t),0)':s=${RATE}:d=${SECONDS}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source]);
  run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=s=${W}x${H}:r=${FPS}:d=${SECONDS + 0.04}`,
    '-f', 'lavfi', '-i', `aevalsrc='0.6*sin(2*PI*880*t)':s=${RATE}:c=stereo:d=${SECONDS + 0.04}`,
    '-c:v', 'libx264', '-crf', '16', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '320k', '-shortest', layer]);

  // Обычный путь: ReelScenes с одной сценой broll overlay none на весь ролик, как делает layer brief.
  const props = {
    theme: 'lesson-neutral', faceSrc: 'source.mp4', audioSrc: 'source.mp4', videoTitle: 'СЛОЙ',
    facePos: { x: 0.5, y: 0.41 }, faceZoom: 1, width: W, height: H, fps: FPS, durationInFrames: FRAMES,
    scenes: [{
      scene: 'broll', start: 0, end: SECONDS, videoTitle: ' ', headCream: 'А', headOrange: 'Б', showSpeakerPip: false,
      brollMedia: { kind: 'video', src: 'layer.mp4', sha256: 'f'.repeat(64), trimStartSec: 0, fit: 'cover', audioMode: 'mix', overlay: 'none' },
    }],
  };
  const propsPath = path.join(dir, 'props.json');
  fs.writeFileSync(propsPath, JSON.stringify(props));
  const remotionRaw = path.join(dir, 'remotion-raw.mp4');
  const command = remotionRenderCommand(remotion, {
    entry: 'src/index.js', composition: 'ReelScenes', output: remotionRaw, props: propsPath, publicDir, scale: 1, overwrite: true,
  });
  run(command.command, command.args);
  const remotionFinished = path.join(dir, 'remotion.mp4');
  run(process.execPath, [path.join(ROOT, 'scripts', 'finish.js'), remotionRaw, remotionFinished, '--hdrfix', 'auto',
    '--audio-advance-ms', String(REMOTION_AUDIO_ADVANCE_MS)]);

  // Быстрый путь: видео слоя копией, звук – той же смесью, затем тот же finish без сдвига звука Remotion.
  const fastRaw = path.join(dir, 'fast-raw.mp4');
  // Слой на кадр длиннее ролика (допуск layer brief): быстрый путь перекодирует ровно FRAMES кадров.
  const { planKitFastPath } = require('../scripts/layer/fast-preview');
  const plan = planKitFastPath({
    projectDir: publicDir, brief: { scenes: [{ ...props.scenes[0], brollMedia: { ...props.scenes[0].brollMedia, src: 'layer.mp4' } }] },
    props, range: { kind: 'full' }, clean: true, sourceSha256: 'b'.repeat(64),
  }, { registryProblem: () => null, hashImpl: () => props.scenes[0].brollMedia.sha256 });
  assert.equal(plan.reason, undefined, plan.reason);
  assert.equal(plan.layerFrames, FRAMES + 1);
  const fast = kitFastPathCommand({ layerPath: layer, sourcePath: source, output: fastRaw, frames: FRAMES, fps: FPS, audioMode: 'mix', layerFrames: plan.layerFrames });
  run(fast.command, fast.args);
  const fastFinished = path.join(dir, 'fast.mp4');
  run(process.execPath, [path.join(ROOT, 'scripts', 'finish.js'), fastRaw, fastFinished, '--hdrfix', 'auto', '--audio-advance-ms', '0']);

  // Кадры: те же контрольные точки и порог, что у сверки preview и финала.
  const frames = verifyPreviewFinalEquivalence({
    previewPath: fastFinished, finalPath: remotionFinished, width: W, height: H,
    controlFramesSec: [0, 0.52, 1.48, 2.2, 2.92, 2.96], threshold: 0.97,
  });
  assert.ok(frames.minimumScore >= 0.97, `SSIM ${frames.minimumScore}`);
  console.log(`SSIM min ${frames.minimumScore}`);

  // Длительность и число кадров совпадают.
  const count = (file) => Number.parseInt(run('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0',
    '-show_entries', 'stream=nb_read_frames', '-of', 'default=nk=1:nw=1', file]).toString().trim(), 10);
  assert.equal(count(fastFinished), FRAMES);
  assert.equal(count(remotionFinished), FRAMES);

  // Громкость после finish: обе около −14 LUFS и между собой в пределах 0,5 LU.
  const lufsFast = loudness(fastFinished);
  const lufsRemotion = loudness(remotionFinished);
  console.log(`LUFS fast ${lufsFast} remotion ${lufsRemotion}`);
  assert.ok(Math.abs(lufsFast - lufsRemotion) <= 0.5, `${lufsFast} против ${lufsRemotion} LUFS`);

  // Форма звука по полосам: голос (220 Гц) и слой (880 Гц) совпадают окнами по 20 мс, синхрон – без сдвига.
  for (const frequency of [220, 880]) {
    const a = envelope(band(fastFinished, frequency));
    const b = envelope(band(remotionFinished, frequency));
    const length = Math.min(a.length, b.length);
    // Длина звука каждого пути – в пределах 0,1 с от видео: хвост AAC после -shortest в finish.js
    // зависит от версии ffmpeg (на ffmpeg 9 путь Remotion теряет ~0,1 с из-за сдвига звука Remotion).
    const videoWindows = Math.round(SECONDS / WINDOW_SEC);
    for (const [name, windows] of [['быстрый путь', a.length], ['Remotion', b.length]]) {
      assert.ok(windows >= videoWindows - 5 && windows <= videoWindows, `${name}: длина звука ${windows} окон при видео ${videoWindows}`);
    }
    // Синхрон меряется по прерывистому голосу: у ровного тона слоя корреляция не определяет сдвиг.
    const lag = frequency === 220 ? bestLag(a.map((v) => 10 ** (v / 20)), b.map((v) => 10 ** (v / 20))) : 0;
    assert.ok(Math.abs(lag) <= 1, `полоса ${frequency} Гц сдвинута на ${lag} окон по 20 мс`);
    const loud = [];
    for (let i = 0; i < length; i += 1) if (a[i] > -45 && b[i] > -45) loud.push(Math.abs(a[i] - b[i]));
    loud.sort((x, y) => x - y);
    const median = loud[Math.floor(loud.length / 2)];
    console.log(`band ${frequency}: lag ${lag}, median ${median?.toFixed(2)} dB, windows ${loud.length}/${length}`);
    assert.ok(loud.length > length * 0.3, `полоса ${frequency} Гц почти пустая`);
    assert.ok(median <= 1.5, `полоса ${frequency} Гц: медианная разница ${median.toFixed(2)} дБ`);
  }
  // Огибающая сцены: в первом окне звук слоя тише, чем через 0,2 с, в обоих путях.
  for (const file of [fastFinished, remotionFinished]) {
    const sfx = envelope(band(file, 880));
    assert.ok(sfx[0] < sfx[10] - 6, `${path.basename(file)}: нет нарастания звука слоя в начале сцены`);
  }
});
