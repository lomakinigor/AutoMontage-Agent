// Автоматический барьер motion-preview (#43, D-049). Меряет собранный, но ещё не опубликованный файл
// preview motion-reel (с речью и без неё, --music-only): чёрные провалы, громкость по EBU R128,
// дорожку звука, геометрию кадра и битрейт видео (только предупреждение). Любой fail – preview не публикуется, прошлый остаётся. Флага обхода нет.
// Парсеры вывода ffmpeg – чистые функции, их проверяют unit-тесты на настоящем выводе ffmpeg.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { captureToolResult, hostPath } = require('../process');
const { hidePaths, projectQaDir } = require('./report');

// Контракт финиша (scripts/finish-audio.js LOUDNORM_FILTER): −14 LUFS, true peak −1,5 dBTP.
const LOUDNESS_TARGET = -14;
const LOUDNESS_TOLERANCE = 1;
const TRUE_PEAK_MAX = -1.5;
const SAMPLE_RATE = 48000;
// Чёрный кадр: пиксель тёмный при pix_th=0.10, а кадр чёрный, только если тёмные ≥ 99,9 % (pic_th=0.999).
// По умолчанию blackdetect берёт 98 %, и тёмная сцена с небольшой кнопкой или подписью (меньше 2 % кадра)
// считалась провалом – так ложно блокировались настоящие тёмные промо. Пустой кадр между сценами
// (Remotion рисует там чистый чёрный) ловится по-прежнему.
const BLACKDETECT_FILTER = 'blackdetect=d=0.1:pix_th=0.10:pic_th=0.999';
// framelog=verbose убирает построчный журнал каждые 100 мс из stderr уровня info: остаётся только Summary.
const EBUR128_FILTER = 'ebur128=peak=true:framelog=verbose';
// Затемнение в конце ролика – задуманная концовка: хвост засчитывается, если чёрный отрезок кончается
// не дальше двух кадров от конца видео.
const TAIL_FRAMES = 2;
// Появление из темноты в начале – тоже задуманный приём: отрезок с первого кадра длиной до 1 с.
// Концовка ограничена так же (до 1,5 с): иначе полностью чёрный ролик или ролик, чёрный с середины
// до конца, проходил бы как «затемнение в конце».
const HEAD_MAX_SEC = 1;
const TAIL_MAX_SEC = 1.5;
const CAPTURE_MAX_BUFFER = 16 * 1024 * 1024;
const AUDIO_RECIPE = 'skills/ai-promo/references/audio-recipe.md';
// Порог битрейта видео: 20 Мбит/с для 1080x1920 при 30 fps, масштаб по площади кадра и fps:
// limit = 20e6 × (width × height) / (1080 × 1920) × fps / 30. Чистая motion-графика при CRF 18 – около
// 1 Мбит/с; выше порога почти всегда полнокадровый шум (анимированное зерно, мерцание), который h264
// не сжимает. Только warn: ролик рабочий, но тяжёлый.
const BITRATE_REF_BPS = 20e6;
const BITRATE_REF_PIXELS = 1080 * 1920;
const BITRATE_REF_FPS = 30;

const round = (value, digits = 2) => (Number.isFinite(value) ? Number(value.toFixed(digits)) : value);
const sec = (value) => `${round(value, 2)}`.replace('.', ',');

function parseNumber(text) {
  if (text === undefined || text === null) return null;
  const value = String(text).trim().toLowerCase();
  if (value === '-inf' || value === '-infinity') return -Infinity;
  if (value === 'inf' || value === '+inf') return Infinity;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

// stderr ffmpeg с blackdetect → [{start, end, duration}] в секундах.
function parseBlackdetect(stderr) {
  const segments = [];
  const pattern = /black_start:\s*(-?[\d.]+)\s+black_end:\s*(-?[\d.]+)\s+black_duration:\s*(-?[\d.]+)/gu;
  for (const match of String(stderr || '').matchAll(pattern)) {
    const [start, end, duration] = match.slice(1).map(Number);
    if ([start, end, duration].every(Number.isFinite)) segments.push({ start, end, duration });
  }
  return segments;
}

// stderr ffmpeg с ebur128=peak=true → {integratedLufs, truePeakDbtp}; null, если Summary нет.
// Берётся последний блок Summary: в нём итог всего файла.
function parseEbur128(stderr) {
  const text = String(stderr || '');
  const at = text.lastIndexOf('Summary:');
  if (at < 0) return null;
  const summary = text.slice(at);
  const integrated = /Integrated loudness:\s*\n\s*I:\s*(\S+)\s*LUFS/u.exec(summary);
  const peak = /True peak:\s*\n\s*Peak:\s*(\S+)\s*dBFS/u.exec(summary);
  if (!integrated) return null;
  return {
    integratedLufs: parseNumber(integrated[1]),
    truePeakDbtp: peak ? parseNumber(peak[1]) : null,
  };
}

function frameRate(value) {
  const [num, den] = String(value || '').split('/').map(Number);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;
  return num / den;
}

function bitRateOf(video, format) {
  const stream = video ? parseNumber(video.bit_rate) : null;
  if (Number.isFinite(stream) && stream > 0) return { videoBitRate: stream, bitRateSource: 'stream' };
  const container = video ? parseNumber(format?.bit_rate) : null;
  if (Number.isFinite(container) && container > 0) return { videoBitRate: container, bitRateSource: 'format' };
  return { videoBitRate: null, bitRateSource: null };
}

// JSON ffprobe → {width, height, fps, durationSec, audio: [{sampleRate}], videoBitRate, bitRateSource}.
function parseProbe(stdout) {
  let probe;
  try {
    probe = JSON.parse(String(stdout || ''));
  } catch {
    throw new Error('ffprobe вернул недопустимый JSON для preview');
  }
  const streams = Array.isArray(probe?.streams) ? probe.streams : [];
  const video = streams.find((stream) => stream.codec_type === 'video');
  const audio = streams.filter((stream) => stream.codec_type === 'audio');
  const formatDuration = parseNumber(probe?.format?.duration);
  return {
    width: video ? Number(video.width) : null,
    height: video ? Number(video.height) : null,
    fps: video ? frameRate(video.avg_frame_rate) ?? frameRate(video.r_frame_rate) : null,
    durationSec: parseNumber(video?.duration) ?? formatDuration,
    audio: audio.map((stream) => ({ sampleRate: Number(stream.sample_rate) })),
    hasVideo: Boolean(video),
    // Битрейт видео: из потока, иначе из контейнера (тогда со звуком – завышен на долю звука).
    ...bitRateOf(video, probe?.format),
  };
}

function probeArgs(videoPath) {
  return ['-v', 'error', '-show_entries',
    'stream=codec_type,width,height,avg_frame_rate,r_frame_rate,sample_rate,duration,bit_rate:format=duration,bit_rate',
    '-of', 'json', hostPath(videoPath)];
}

// Один проход декодирования: картинка через blackdetect, звук – через ebur128 (только если его меряем).
function analyzeArgs(videoPath, { loudness }) {
  const args = ['-hide_banner', '-nostats', '-v', 'info', '-i', hostPath(videoPath),
    '-map', '0:v:0', '-vf', BLACKDETECT_FILTER];
  if (loudness) args.push('-map', '0:a:0', '-af', EBUR128_FILTER);
  args.push('-f', 'null', '-');
  return args;
}

function check(id, status, { measured = null, limit = null, message = '' } = {}) {
  return { id, status, measured, limit, message };
}

// Чистый вердикт по замеру. measurement: {probe, blackSegments, loudness, fullRange}; expected: {width, height, fps}.
// edges – {head, tail}: совпадают ли начало и конец файла с началом и концом ролика. У фрагмента его
// края – не края ролика, и чёрный кадр там – провал, а не появление или концовка.
function evaluateMotionPreview({ probe, blackSegments, loudness, fullRange, edges = { head: true, tail: true } }, expected) {
  const checks = [];
  const fps = expected.fps;
  const geometryOk = probe.width === expected.width && probe.height === expected.height;
  checks.push(check('frame-size', geometryOk ? 'pass' : 'fail', {
    measured: `${probe.width}x${probe.height}`, limit: `${expected.width}x${expected.height}`,
    message: geometryOk ? 'размер кадра совпадает с brief' : probe.hasVideo === false
      ? 'в файле нет видеодорожки – пересоберите preview' : `кадр ${probe.width}x${probe.height} вместо `
      + `${expected.width}x${expected.height} – пересоберите preview, проверьте output brief`,
  }));
  const fpsOk = Number.isFinite(probe.fps) && Math.abs(probe.fps - fps) <= 1e-3;
  checks.push(check('fps', fpsOk ? 'pass' : 'fail', {
    measured: round(probe.fps, 3), limit: fps,
    message: fpsOk ? 'FPS совпадает с brief' : `FPS ${round(probe.fps, 3)} вместо ${fps} – пересоберите preview`,
  }));
  const audioCount = probe.audio.length;
  checks.push(check('audio-streams', audioCount === 1 ? 'pass' : 'fail', {
    measured: audioCount, limit: 1,
    message: audioCount === 1 ? 'одна звуковая дорожка' : `звуковых дорожек ${audioCount}, нужна ровно одна – `
      + 'проверьте саундтрек и шаг mix-music',
  }));
  const rate = probe.audio[0]?.sampleRate ?? null;
  const rateOk = audioCount >= 1 && rate === SAMPLE_RATE;
  checks.push(check('sample-rate', rateOk ? 'pass' : 'fail', {
    measured: rate, limit: SAMPLE_RATE,
    message: rateOk ? 'звук 48 кГц' : `звук ${rate ?? 'нет'} Гц вместо 48000 – финиш и микс должны выводить 48 кГц `
      + '(finish.js -ar 48000, mix-music.js)',
  }));

  if (!Array.isArray(blackSegments)) {
    checks.push(check('black-frames', 'fail', {
      limit: 'нет чёрных кадров длиннее 0,1 с', message: 'видеодорожки нет – чёрные кадры не проверить',
    }));
    blackSegments = [];
  }
  const blackChecked = checks.some((item) => item.id === 'black-frames');
  const duration = probe.durationSec;
  const tailFrom = Number.isFinite(duration) ? duration - TAIL_FRAMES / fps : Infinity;
  const isTail = (segment) => edges.tail && segment.end >= tailFrom - 1e-6
    && segment.end - segment.start <= TAIL_MAX_SEC + 1e-6;
  const isHead = (segment) => edges.head && segment.start <= 1e-6 && segment.end <= HEAD_MAX_SEC + 1e-6;
  // Один отрезок не бывает сразу появлением и концовкой: такой ролик чёрный целиком.
  const allowed = (segment) => isTail(segment) !== isHead(segment);
  const gaps = blackSegments.filter((segment) => !allowed(segment));
  const head = blackSegments.some((segment) => allowed(segment) && isHead(segment));
  const tail = blackSegments.some((segment) => allowed(segment) && isTail(segment));
  if (!blackChecked) checks.push(check('black-frames', gaps.length ? 'fail' : 'pass', {
    measured: gaps.map((g) => ({ fromSec: round(g.start, 3), toSec: round(g.end, 3) })),
    limit: 'нет чёрных кадров длиннее 0,1 с (кроме появления из темноты до 1 с в начале и затемнения в конце)',
    message: gaps.length
      ? `чёрный кадр ${gaps.map((g) => `${sec(g.start)}–${sec(g.end)} с`).join(', ')} – сцены не перекрываются: `
        + 'продлите предыдущую сцену или начните следующую раньше, чтобы между ними не было пустоты'
      : ['чёрных провалов нет', head ? 'появление из темноты в начале задумано' : '',
        tail ? 'затемнение в конце – задуманная концовка' : ''].filter(Boolean).join('; '),
  }));

  if (!fullRange) {
    const reason = 'preview фрагмента: громкость меряется только на полном ролике';
    checks.push(check('loudness-integrated', 'skipped', { limit: `${LOUDNESS_TARGET} ±${LOUDNESS_TOLERANCE} LUFS`, message: reason }));
    checks.push(check('true-peak', 'skipped', { limit: `≤ ${TRUE_PEAK_MAX} dBTP`, message: reason }));
  } else if (audioCount < 1 || !loudness) {
    const reason = audioCount < 1 ? 'звука нет – громкость не измерить' : 'ffmpeg не вернул итог ebur128 – громкость не измерена';
    checks.push(check('loudness-integrated', 'fail', { limit: `${LOUDNESS_TARGET} ±${LOUDNESS_TOLERANCE} LUFS`, message: reason }));
    checks.push(check('true-peak', 'fail', { limit: `≤ ${TRUE_PEAK_MAX} dBTP`, message: reason }));
  } else {
    const lufs = loudness.integratedLufs;
    const lufsOk = Number.isFinite(lufs) && Math.abs(lufs - LOUDNESS_TARGET) <= LOUDNESS_TOLERANCE + 1e-9;
    checks.push(check('loudness-integrated', lufsOk ? 'pass' : 'fail', {
      measured: Number.isFinite(lufs) ? round(lufs, 1) : String(lufs), limit: `${LOUDNESS_TARGET} ±${LOUDNESS_TOLERANCE} LUFS`,
      message: lufsOk ? 'громкость в норме' : `громкость ${Number.isFinite(lufs) ? sec(lufs) : lufs} LUFS вместо `
        + `${LOUDNESS_TARGET} ±${LOUDNESS_TOLERANCE} – заново нормализуйте саундтрек (loudnorm) по ${AUDIO_RECIPE} `
        + 'и пересоберите preview',
    }));
    const peak = loudness.truePeakDbtp;
    const peakOk = Number.isFinite(peak) ? peak <= TRUE_PEAK_MAX + 1e-9 : peak === -Infinity;
    checks.push(check('true-peak', peakOk ? 'pass' : 'fail', {
      measured: Number.isFinite(peak) ? round(peak, 1) : String(peak), limit: `≤ ${TRUE_PEAK_MAX} dBTP`,
      message: peakOk ? 'пик в норме' : `true peak ${Number.isFinite(peak) ? sec(peak) : peak} dBTP выше ${sec(TRUE_PEAK_MAX)} – `
        + `заново нормализуйте саундтрек (loudnorm TP=-1.5) по ${AUDIO_RECIPE} и пересоберите preview`,
    }));
  }
  checks.push(bitrateCheck(probe, expected));
  return { checks, block: checks.some((item) => item.status === 'fail') };
}

// Битрейт видео: warn выше порога (формула – у BITRATE_REF_BPS), никогда не fail.
function bitrateCheck(probe, expected) {
  const width = probe.width || expected.width;
  const height = probe.height || expected.height;
  const fps = Number.isFinite(probe.fps) && probe.fps > 0 ? probe.fps : expected.fps;
  const limitBps = BITRATE_REF_BPS * ((width * height) / BITRATE_REF_PIXELS) * (fps / BITRATE_REF_FPS);
  const mbit = (bps) => round(bps / 1e6, 1);
  const limit = `≤ ${sec(mbit(limitBps))} Мбит/с (20 Мбит/с для 1080x1920 30 fps, по площади кадра и fps)`;
  const rate = probe.videoBitRate;
  if (!Number.isFinite(rate) || !Number.isFinite(limitBps)) {
    return check('video-bitrate', 'skipped', { limit, message: 'ffprobe не вернул bit_rate видео – размер файла не оценить' });
  }
  const from = probe.bitRateSource === 'format' ? ' (по контейнеру, со звуком)' : '';
  if (rate <= limitBps) {
    return check('video-bitrate', 'pass', { measured: mbit(rate), limit, message: `битрейт видео ${sec(mbit(rate))} Мбит/с${from} – в норме` });
  }
  return check('video-bitrate', 'warn', {
    measured: mbit(rate), limit,
    message: `битрейт видео ${sec(mbit(rate))} Мбит/с${from} выше ${sec(mbit(limitBps))} – файл будет тяжёлым. Вероятная `
      + 'причина – полнокадровый шум, который h264 не сжимает: анимированное зерно, шум или мерцание фона. '
      + 'Уберите зерно на светлом фоне или сделайте его неподвижным',
  });
}

// Замер файла: ffprobe, затем один проход ffmpeg. deps.captureImpl – подмена captureToolResult в тестах.
function measureMotionPreview({ videoPath, fullRange, edges }, deps = {}) {
  const capture = deps.captureImpl || captureToolResult;
  const options = (stage) => ({ cwd: deps.cwd, stage, maxBuffer: CAPTURE_MAX_BUFFER });
  const probe = parseProbe(capture('ffprobe', probeArgs(videoPath), options('motion preview QA ffprobe')).stdout);
  const loudness = fullRange && probe.audio.length >= 1;
  // Без видеодорожки -map 0:v:0 уронил бы ffmpeg без отчёта: вердикт строится по одному ffprobe.
  if (!probe.hasVideo) return { probe, blackSegments: null, loudness: null, fullRange, edges };
  const result = capture('ffmpeg', analyzeArgs(videoPath, { loudness }), options('motion preview QA ffmpeg'));
  return {
    probe,
    blackSegments: parseBlackdetect(result.stderr),
    loudness: loudness ? parseEbur128(result.stderr) : null,
    fullRange,
    edges,
  };
}

function reportLabel(range) {
  if (range?.kind === 'full') return 'full';
  // Фрагмент – по миллисекундам начала и конца: excerpt-12000-18500.
  const ms = (value) => (Number.isFinite(Number(value)) ? String(Math.round(Number(value) * 1000)) : 'x');
  return `excerpt-${ms(range?.fromSec)}-${ms(range?.toSec)}`;
}

function formatMotionReport(result) {
  const icons = { pass: '✅', fail: '❌', skipped: '⏭️', warn: '⚠️' };
  const warned = result.checks.some((item) => item.status === 'warn');
  const verdict = result.block ? 'СТОП – preview не опубликован' : warned ? 'опубликован, есть предупреждения' : 'всё хорошо';
  const lines = [`Проверки motion-preview: ${verdict}`];
  for (const item of result.checks) {
    const scalar = item.measured !== null && typeof item.measured !== 'object' ? ` (${item.measured})` : '';
    lines.push(`${icons[item.status]} ${item.id}${scalar}: ${item.message}`);
  }
  return lines.join('\n');
}

// JSON-отчёт в qa/motion-preview-<label>.json: атомарно (temp + rename), без абсолютных путей.
function writeMotionReport(projectDir, report, fileSystem = fs) {
  const dir = projectQaDir(projectDir, { create: true, fileSystem });
  const file = path.join(dir, `motion-preview-${report.label}.json`);
  const temporary = `${file}.tmp-${randomUUID()}`;
  try {
    fileSystem.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
    fileSystem.renameSync(temporary, file);
  } catch (error) {
    fileSystem.rmSync(temporary, { force: true });
    throw error;
  }
  return file;
}

// Полный барьер: замер → вердикт → отчёт. Возвращает {checks, block, report, reportPath, writeError}.
// expected – {width, height, fps} preview (previewSize и fps props); range – диапазон preview.
function runMotionPreviewGates({ projectDir, videoPath, expected, range }, deps = {}) {
  const fullRange = range?.kind === 'full';
  const frame = 1 / (expected.fps || 30);
  const edges = {
    head: fullRange || Number(range?.fromSec) <= 1e-6,
    tail: fullRange || (Number.isFinite(expected.totalSec) && Math.abs(Number(range?.toSec) - expected.totalSec) <= frame),
  };
  const measurement = (deps.measureImpl || measureMotionPreview)({ videoPath, fullRange, edges }, deps);
  const verdict = evaluateMotionPreview(measurement, expected);
  const report = {
    version: 1,
    kind: 'motion-preview',
    label: reportLabel(range),
    createdAt: (deps.now || (() => new Date()))().toISOString(),
    range: { kind: range?.kind ?? null, fromSec: range?.fromSec ?? null, toSec: range?.toSec ?? null },
    checks: verdict.checks,
    block: verdict.block,
  };
  const result = { ...verdict, report, reportPath: null, writeError: null };
  if (deps.write !== false) {
    try {
      result.reportPath = writeMotionReport(projectDir, report, deps.fileSystem);
    } catch (error) {
      result.writeError = hidePaths(error?.code ? `не удалось записать в qa/ (${error.code})` : String(error?.message ?? error), projectDir);
    }
  }
  return result;
}

module.exports = {
  BITRATE_REF_BPS,
  BLACKDETECT_FILTER,
  EBUR128_FILTER,
  LOUDNESS_TARGET,
  LOUDNESS_TOLERANCE,
  SAMPLE_RATE,
  TRUE_PEAK_MAX,
  analyzeArgs,
  evaluateMotionPreview,
  formatMotionReport,
  measureMotionPreview,
  parseBlackdetect,
  parseEbur128,
  parseProbe,
  probeArgs,
  runMotionPreviewGates,
};
