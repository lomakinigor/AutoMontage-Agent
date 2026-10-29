const test = require('node:test');
const assert = require('node:assert/strict');

// Эквивалентность GPU и CPU рендера слоя (#93, опт-ин, только Apple Silicon): первые 50 кадров шаблона слоя
// рендерятся настоящим Remotion дважды – с --gl=angle и без него, оба с тем же env и кэшем видео 2 ГиБ, как в
// layer render. Оба файла обязаны иметь ровно 50 кадров, а покадровый SSIM – не ниже 0,99: ускорение не должно
// менять картинку. npm test его не трогает; на сервере (Linux) и без флага – пропуск.
const FRAMES = 50;
const MIN_SSIM = 0.99;
const skip = process.env.AUTOMONTAGE_TEST_MOTION_RENDER !== '1'
  ? 'Настоящий Remotion: AUTOMONTAGE_TEST_MOTION_RENDER=1 node --test tests/layer-gpu-equivalence.test.js'
  : (process.platform !== 'darwin' || process.arch !== 'arm64') && 'GPU-рендер слоя проверяется только на Apple Silicon (darwin/arm64)';

test('layer render with --gl=angle matches the CPU render frame by frame (SSIM >= 0.99)', { skip, timeout: 600_000 }, (t) => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { remotionLayerRenderCommand } = require('../scripts/build-commands');
  const { ROOT, resolveRemotionCommand } = require('../scripts/env');
  const { LAYER_OFFTHREAD_CACHE_BYTES } = require('../scripts/gpu');
  const { LIMITED_RANGE_ENV } = require('../scripts/remotion-ffmpeg-override');
  const { captureTool, runTool } = require('../scripts/process');
  const { makeLayerProject } = require('./helpers/layer-project');
  const newLayer = require('../scripts/layer/new');

  const { root, projectDir, sfxDir } = makeLayerProject(t, { seconds: 10, size: '1080x1920' });
  // Восстанавливаем прежнее значение (или отсутствие переменной), как в layer-render-still.test.js.
  const previousSfxDir = process.env.AUTOMONTAGE_SFX_DIR;
  process.env.AUTOMONTAGE_SFX_DIR = sfxDir;
  t.after(() => {
    if (previousSfxDir === undefined) delete process.env.AUTOMONTAGE_SFX_DIR;
    else process.env.AUTOMONTAGE_SFX_DIR = previousSfxDir;
  });
  // newLayer.run асинхронный, но t-колбэк синхронный: дожидаемся ниже через async-обёртку.
  return (async () => {
    assert.equal(await newLayer.run({ 'project-dir': projectDir }), 0);
    const layerDir = path.join(projectDir, 'motion-v01');
    const layer = JSON.parse(fs.readFileSync(path.join(layerDir, 'layer.json'), 'utf8'));
    const remotion = resolveRemotionCommand(ROOT);
    const env = { ...process.env, [LIMITED_RANGE_ENV]: '1' };

    const render = (gl, name) => {
      const output = path.join(root, `${name}.mp4`);
      const { command, args } = remotionLayerRenderCommand(remotion, {
        entry: path.join(layerDir, 'src', 'index.jsx'), composition: layer.composition, output,
        publicDir: path.join(layerDir, 'public'), gl, offthreadCacheBytes: LAYER_OFFTHREAD_CACHE_BYTES,
      });
      if (gl) assert.ok(args.includes('--gl=angle'), 'GPU-команда без --gl=angle');
      else assert.ok(!args.some((arg) => arg.startsWith('--gl')), 'CPU-команда не должна нести --gl');
      // Только первые 50 кадров; cwd – корень репозитория: там лежит remotion.config.js.
      runTool(command, [...args, `--frames=0-${FRAMES - 1}`], { cwd: ROOT, stage: `layer ${name} render`, env });
      return output;
    };
    const gpu = render('angle', 'gpu');
    const cpu = render(null, 'cpu');

    const packets = (file) => Number(captureTool('ffprobe', ['-v', 'error', '-count_packets', '-select_streams', 'v:0',
      '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', file], { cwd: ROOT, stage: 'ffprobe', maxBuffer: 64 * 1024 }).trim());
    assert.equal(packets(gpu), FRAMES, 'GPU-рендер: не 50 кадров');
    assert.equal(packets(cpu), FRAMES, 'CPU-рендер: не 50 кадров');

    // Покадровый SSIM: строка stats_file вида «n:1 Y:… U:… V:… All:0.998 (27.1)».
    const statsFile = path.join(root, 'ssim.log');
    runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', gpu, '-i', cpu,
      '-lavfi', `[0:v]format=yuv420p[a];[1:v]format=yuv420p[b];[a][b]ssim=stats_file=${statsFile}`, '-f', 'null', '-'],
    { cwd: ROOT, stage: 'ffmpeg ssim' });
    const values = fs.readFileSync(statsFile, 'utf8').split('\n').filter(Boolean)
      .map((line) => Number(/All:([0-9.]+)/u.exec(line)?.[1]));
    assert.equal(values.length, FRAMES, 'SSIM посчитан не по 50 кадрам');
    assert.ok(values.every(Number.isFinite), 'SSIM: нечисловое значение в статистике');
    const min = Math.min(...values);
    assert.ok(min >= MIN_SSIM, `минимальный покадровый SSIM ${min} < ${MIN_SSIM} (кадр ${values.indexOf(min)})`);
  })();
});
