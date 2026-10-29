#!/usr/bin/env node
// Полный рендер пакета без звука: node projects/<id>/motion-vNN/render.cjs (из корня движка).
// Ждёт слот общей очереди тяжёлых задач, рендерит композицию Promo с withAudio=false и --muted
// в renders/promo-NN.mp4 (NN – следующий свободный номер), затем проверяет размер, FPS,
// отсутствие звука и число кадров = TOTAL из src/tokens.js. `--aspect vertical|horizontal` сверяет
// выбранный формат с ASPECT в tokens.js до рендера; `--brief <путь к ТЗ>` сверяет ASPECT с
// output.aspect этого ТЗ (нет поля – vertical). Без флагов берётся формат tokens.js.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PACK = __dirname;
const ROOT = path.resolve(PACK, '..', '..', '..');
// Модули движка подключаются в main(): в шаблоне ROOT указывает мимо движка, а проверка формата
// (checkPackAspect) должна работать и там.

// tokens.js – ES-модуль без импортов: переводим его в CommonJS тем же esbuild, что у движка.
function readTokens() {
  const { transformSync } = require(require.resolve('esbuild', { paths: [ROOT] }));
  const source = fs.readFileSync(path.join(PACK, 'src', 'tokens.js'), 'utf8');
  const { code } = transformSync(source, { loader: 'js', format: 'cjs' });
  const module = { exports: {} };
  new Function('module', 'exports', code)(module, module.exports);
  return module.exports;
}

function nextOutput(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (let n = 1; n < 100; n += 1) {
    const file = path.join(dir, `promo-${String(n).padStart(2, '0')}.mp4`);
    if (!fs.existsSync(file)) return file;
  }
  throw new Error('renders/: заняты номера 01–99, перенесите старые рендеры');
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} завершился с кодом ${result.status}`);
}

function probe(file) {
  const result = spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-show_entries',
    'stream=codec_type,width,height,r_frame_rate,nb_read_frames', '-of', 'json', file], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`ffprobe: ${result.stderr}`);
  return JSON.parse(result.stdout).streams || [];
}

function optionValue(argv, name) {
  const at = argv.indexOf(name);
  if (at === -1) return null;
  const value = argv[at + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name}: нужно значение`);
  return value;
}

// Сверяет формат пакета (ASPECT в tokens.js) с --aspect и с output.aspect ТЗ (--brief).
function checkPackAspect(tokens, argv) {
  if (tokens.ASPECT !== 'vertical' && tokens.ASPECT !== 'horizontal') {
    throw new Error(`tokens.js: ASPECT = '${tokens.ASPECT}', допустимо 'vertical' или 'horizontal'`);
  }
  const aspect = optionValue(argv, '--aspect');
  if (aspect !== null) {
    if (aspect !== 'vertical' && aspect !== 'horizontal') throw new Error('--aspect: допустимо vertical или horizontal');
    if (aspect !== tokens.ASPECT) {
      throw new Error(`--aspect ${aspect}, а в src/tokens.js ASPECT = '${tokens.ASPECT}': поправь tokens.js под формат scaffold brief`);
    }
  }
  const briefPath = optionValue(argv, '--brief');
  if (briefPath !== null) {
    let brief;
    try { brief = JSON.parse(fs.readFileSync(briefPath, 'utf8')); } catch (error) {
      throw new Error(`--brief ${briefPath}: не удалось прочитать ТЗ (${error.message})`);
    }
    const briefAspect = (brief.output && brief.output.aspect) || 'vertical';
    if (briefAspect !== tokens.ASPECT) {
      throw new Error(`в ТЗ output.aspect = '${briefAspect}', а в src/tokens.js ASPECT = '${tokens.ASPECT}': поправь ASPECT и перекомпонуй сцены под формат ТЗ`);
    }
  }
}

async function main() {
  const { resolveRemotionCommand } = require(path.join(ROOT, 'scripts', 'env'));
  const { acquireHeavySlot } = require(path.join(ROOT, 'scripts', 'heavy-queue'));
  const { LIMITED_RANGE_ENV } = require(path.join(ROOT, 'scripts', 'remotion-ffmpeg-override'));
  const tokens = readTokens();
  checkPackAspect(tokens, process.argv.slice(2));
  const [expectWidth, expectHeight] = tokens.ASPECT === 'horizontal' ? [1920, 1080] : [1080, 1920];
  if (tokens.WIDTH !== expectWidth || tokens.HEIGHT !== expectHeight) {
    throw new Error(`tokens.js: размер ${tokens.WIDTH}×${tokens.HEIGHT} не совпадает с ASPECT = '${tokens.ASPECT}' (${expectWidth}×${expectHeight})`);
  }
  const output = nextOutput(path.join(PACK, 'renders'));
  const remotion = resolveRemotionCommand(ROOT);
  const slot = await acquireHeavySlot({ label: `ai-promo render ${path.basename(path.dirname(PACK))}/${path.basename(PACK)}` });
  try {
    run(remotion.command, [...remotion.argsPrefix, 'render', path.join(PACK, 'src', 'index.jsx'), 'Promo', output,
      '--public-dir', path.join(PACK, 'public'), '--props', JSON.stringify({ withAudio: false }), '--muted',
      '--codec=h264', '--log=error', '--concurrency=50%', '--overwrite'],
    { env: { ...process.env, [LIMITED_RANGE_ENV]: '1' } });
  } finally {
    slot.release();
  }
  const streams = probe(output);
  const video = streams.find((s) => s.codec_type === 'video');
  const problems = [];
  if (!video) problems.push('нет видеопотока');
  else {
    if (video.width !== tokens.WIDTH || video.height !== tokens.HEIGHT) problems.push(`размер ${video.width}×${video.height}, нужен ${tokens.WIDTH}×${tokens.HEIGHT}`);
    if (video.r_frame_rate !== `${tokens.FPS}/1`) problems.push(`FPS ${video.r_frame_rate}, нужен ${tokens.FPS}/1`);
    if (Number(video.nb_read_frames) !== tokens.TOTAL) problems.push(`кадров ${video.nb_read_frames}, нужно TOTAL = ${tokens.TOTAL}`);
  }
  if (streams.some((s) => s.codec_type === 'audio')) problems.push('в пакете есть звук: рендер должен быть с withAudio=false и --muted');
  const shown = path.relative(ROOT, output);
  if (problems.length) {
    console.error(`❌ ${shown}: ${problems.join('; ')}`);
    process.exitCode = 1;
    return;
  }
  console.log(`✅ ${shown}: ${tokens.WIDTH}×${tokens.HEIGHT}, ${tokens.FPS} FPS, ${tokens.TOTAL} кадров, без звука`);
  console.log('Дальше: скопируйте рендер в assets/ проекта, посчитайте SHA-256 и подключите media-сценой (engine-path.md)');
}

if (require.main === module) {
  main().catch((error) => { console.error(`❌ рендер пакета: ${error.message}`); process.exitCode = 1; });
}
module.exports = { checkPackAspect };
