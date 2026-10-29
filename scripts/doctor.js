#!/usr/bin/env node
// doctor.js: проверка окружения перед первым монтажом.
// Говорит новичку заранее, чего не хватает, вместо падения в середине пайплайна.
//
//   node scripts/doctor.js        (или: automontage doctor)
//
// Проверяет: Node, Python 3, ffmpeg/ffprobe, faster-whisper вместе с PyAV, шрифты, node_modules, режим GPU рендера слоя,
// Chromium (нужен только для пересборки картинок-плашек, поэтому WARN, не FAIL).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  ROOT,
  configureMediaToolPath,
  ffmpegEncoderAvailable,
  python,
} = require('./env');
const { describeLayerGpu } = require('./gpu');
const { WHISPER_PROBE_PY, evaluateWhisperProbe } = require('./whisper-check');

let fails = 0, warns = 0;
const ok   = (m) => console.log(`  \x1b[32mOK\x1b[0m   ${m}`);
const fail = (m) => { console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); fails++; };
const warn = (m) => { console.log(`  \x1b[33mWARN\x1b[0m ${m}`); warns++; };

// пробуем запустить команду и вернуть первую строку вывода (или null)
function tryRun(cmd, args) {
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf8' });
    if (r.status !== 0 && !r.stdout && !r.stderr) return null;
    return `${r.stdout || ''}${r.stderr || ''}`.split('\n')[0].trim();
  } catch (_) { return null; }
}

console.log('\nAutoMontage-Agent :: проверка окружения\n');

try {
  const configured = configureMediaToolPath();
  if (configured) ok(`ffmpeg/ffprobe выбраны из AUTOMONTAGE_FFMPEG_DIR: ${configured}`);
} catch (error) {
  fail(error.message);
}

// 1. Node
const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
if (nodeMajor >= 20) ok(`Node.js ${process.version}`);
else if (nodeMajor >= 18) warn(`Node.js ${process.version} (рекомендуется >=20 для связки Remotion 4 + React 19)`);
else fail(`Node.js ${process.version} слишком старый, нужен >=20`);

// 2. Python 3
try {
  const py = python();
  const v = tryRun(py, ['--version']) || py;
  ok(`Python 3 (${v}), интерпретатор: ${py}`);
} catch (e) {
  fail('Python 3 не найден. Установи Python 3 и добавь в PATH (нужен для транскрипции и перекадрирования)');
}

// 3. ffmpeg + ffprobe
const ff = tryRun('ffmpeg', ['-version']);
if (ff) {
  ok(ff);
  const encoders = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' });
  const output = `${encoders.stdout || ''}${encoders.stderr || ''}`;
  const requiredReviewEncoders = ['libwebp', 'libx264', 'libvpx', 'libopus', 'aac'];
  const missingReviewEncoders = encoders.status === 0
    ? requiredReviewEncoders.filter((encoder) => !ffmpegEncoderAvailable(output, encoder))
    : requiredReviewEncoders;
  if (missingReviewEncoders.length === 0) {
    ok('ffmpeg содержит WebP/H.264/VP8/Opus/AAC для импорта фото и видео в Review');
  } else {
    const unavailable = [];
    if (missingReviewEncoders.includes('libwebp')) unavailable.push('фото');
    if (missingReviewEncoders.some((encoder) => encoder !== 'libwebp')) unavailable.push('видео');
    warn(`В этой сборке ffmpeg не хватает: ${missingReviewEncoders.join(', ')}. `
      + `Импорт ${unavailable.join(' и ')} через Review работать не будет. `
      + 'macOS/Homebrew: `brew install ffmpeg-full`, затем '
      + '`AUTOMONTAGE_FFMPEG_DIR="$(brew --prefix ffmpeg-full)/bin" automontage review ...`');
  }
} else fail('ffmpeg не найден. Установи ffmpeg (обязателен: извлечение аудио, финальная сборка)');
const fp = tryRun('ffprobe', ['-version']);
if (fp) ok(fp); else fail('ffprobe не найден (обычно ставится вместе с ffmpeg)');

// 4. faster-whisper + PyAV (только если Python есть): настоящая проба декодирования
try {
  const py = python();
  const probe = evaluateWhisperProbe(spawnSync(py, ['-c', WHISPER_PROBE_PY], { encoding: 'utf8' }));
  if (probe.level === 'ok') ok(probe.message); else warn(probe.message);
} catch (_) { /* python уже отмечен как FAIL выше */ }

// 5. node_modules (Remotion)
if (fs.existsSync(path.join(ROOT, 'node_modules', 'remotion'))) ok('node_modules установлены (Remotion на месте)');
else fail('node_modules нет. Запусти `npm install` в папке движка');

// 6. Режим GPU для layer render (D-052): по платформе и AUTOMONTAGE_GPU, без пробы браузера
// (`remotion gpu` в Remotion 4.0.536 падает на chrome://gpu, net::ERR_FAILED)
{
  const gpu = describeLayerGpu();
  if (gpu.level === 'ok') ok(gpu.message); else warn(gpu.message);
}

// 7. Шрифты (инлайн base64, рендер работает из коробки)
if (fs.existsSync(path.join(ROOT, 'src', 'fonts-data.js'))) ok('шрифты встроены (src/fonts-data.js), качать вручную не нужно');
else warn('src/fonts-data.js отсутствует: рендер может использовать системные шрифты');

// 8. Chromium (нужен только для пересборки картинок-плашек через Playwright)
const hasChromium = tryRun('chromium', ['--version']) || tryRun('chromium-browser', ['--version'])
  || tryRun('google-chrome', ['--version']);
if (hasChromium) ok(`Chromium (${hasChromium}), для пересборки картинок-плашек`);
else warn('Chromium не найден. Нужен только если пересобираешь картинки-плашки (shot-*.js). Для базового монтажа не требуется');

// итог
console.log('');
if (fails) { console.log(`\x1b[31m${fails} критичн. проблем(ы)\x1b[0m${warns ? `, ${warns} предупрежд.` : ''}. Монтаж не запустится, пока не устранишь FAIL.\n`); process.exit(1); }
if (warns) { console.log(`\x1b[33mВсё основное на месте, ${warns} предупрежд.\x1b[0m Базовый монтаж заработает.\n`); process.exit(0); }
console.log('\x1b[32mВсё готово. Можно монтировать.\x1b[0m\n');
