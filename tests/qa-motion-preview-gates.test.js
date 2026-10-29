// Барьер motion-preview (#43): парсеры вывода ffmpeg, вердикт и запись отчёта.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  analyzeArgs,
  evaluateMotionPreview,
  formatMotionReport,
  measureMotionPreview,
  parseBlackdetect,
  parseEbur128,
  parseProbe,
  probeArgs,
  runMotionPreviewGates,
  BLACKDETECT_FILTER,
} = require('../scripts/qa/motion-preview-gates');

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

// Настоящий stderr ffmpeg 6.1: blackdetect + ebur128=peak=true:framelog=verbose, файл 3 с, 30 fps.
const STDERR = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'preview.mp4':
  Duration: 00:00:03.00, start: 0.000000, bitrate: 160 kb/s
Stream mapping:
  Stream #0:0 -> #0:0 (h264 (native) -> wrapped_avframe (native))
  Stream #0:1 -> #0:1 (aac (native) -> pcm_s16le (native))
[blackdetect @ 0x625ff88d7940] black_start:1 black_end:1.53333 black_duration:0.533333
[out#0/null @ 0x625ff883bb40] video:42kB audio:282kB subtitle:0kB other streams:0kB global headers:0kB muxing overhead: unknown
frame=   90 fps=0.0 q=-0.0 Lsize=N/A time=00:00:03.00 bitrate=N/A speed=33.9x
[blackdetect @ 0x625ff88d7940] black_start:2.6 black_end:2.96667 black_duration:0.366667
[Parsed_ebur128_0 @ 0x625ff88c58c0] Summary:

  Integrated loudness:
    I:         -21.8 LUFS
    Threshold: -31.8 LUFS

  Loudness range:
    LRA:        20.0 LU
    Threshold: -41.8 LUFS
    LRA low:   -41.8 LUFS
    LRA high:  -21.8 LUFS

  True peak:
    Peak:      -16.1 dBFS
`;

const probeJson = ({ width = 320, height = 568, fps = '30/1', rates = [48000], duration = '3.000000', bitRate = '150000', formatBitRate } = {}) => JSON.stringify({
  programs: [],
  streams: [
    { codec_type: 'video', width, height, r_frame_rate: fps, avg_frame_rate: fps, duration, ...(bitRate ? { bit_rate: bitRate } : {}) },
    ...rates.map((rate) => ({ codec_type: 'audio', sample_rate: String(rate), r_frame_rate: '0/0', avg_frame_rate: '0/0', duration })),
  ],
  format: { duration, ...(formatBitRate ? { bit_rate: formatBitRate } : {}) },
});
const EXPECTED = { width: 320, height: 568, fps: 30 };
const byId = (result, id) => result.checks.find((item) => item.id === id);

test('blackdetect parser reads every segment from real ffmpeg stderr', () => {
  assert.deepEqual(parseBlackdetect(STDERR), [
    { start: 1, end: 1.53333, duration: 0.533333 },
    { start: 2.6, end: 2.96667, duration: 0.366667 },
  ]);
  assert.deepEqual(parseBlackdetect('frame=   90 fps=0.0'), []);
});

test('ebur128 parser reads integrated loudness and true peak from the final Summary', () => {
  assert.deepEqual(parseEbur128(STDERR), { integratedLufs: -21.8, truePeakDbtp: -16.1 });
  const silent = STDERR.replace('I:         -21.8 LUFS', 'I:         -70.0 LUFS').replace('Peak:      -16.1 dBFS', 'Peak:       -inf dBFS');
  assert.deepEqual(parseEbur128(silent), { integratedLufs: -70, truePeakDbtp: -Infinity });
  assert.equal(parseEbur128('[blackdetect] black_start:0 black_end:1 black_duration:1'), null);
});

test('probe parser reads geometry, fps and every audio stream', () => {
  assert.deepEqual(parseProbe(probeJson({ rates: [44100, 48000], fps: '30000/1001' })), {
    width: 320, height: 568, fps: 30000 / 1001, durationSec: 3, audio: [{ sampleRate: 44100 }, { sampleRate: 48000 }], hasVideo: true,
    videoBitRate: 150000, bitRateSource: 'stream',
  });
  assert.throws(() => parseProbe('not json'), /JSON/);
});

const passing = (overrides = {}) => ({
  probe: parseProbe(probeJson()), blackSegments: [], loudness: { integratedLufs: -14.2, truePeakDbtp: -1.6 }, fullRange: true, ...overrides,
});

test('a clean full preview passes every check', () => {
  const result = evaluateMotionPreview(passing(), EXPECTED);
  assert.equal(result.block, false);
  assert.deepEqual(result.checks.map((item) => [item.id, item.status]), [
    ['frame-size', 'pass'], ['fps', 'pass'], ['audio-streams', 'pass'], ['sample-rate', 'pass'],
    ['black-frames', 'pass'], ['loudness-integrated', 'pass'], ['true-peak', 'pass'], ['video-bitrate', 'pass'],
  ]);
});

test('a black gap between scenes blocks; a black tail at the very end is an intended fade-out', () => {
  const result = evaluateMotionPreview(passing({ blackSegments: parseBlackdetect(STDERR) }), EXPECTED);
  const black = byId(result, 'black-frames');
  assert.equal(result.block, true);
  assert.equal(black.status, 'fail');
  assert.deepEqual(black.measured, [{ fromSec: 1, toSec: 1.533 }]);
  assert.match(black.message, /1–1,53 с/);
  assert.match(black.message, /сцен/);
  const tailOnly = evaluateMotionPreview(passing({ blackSegments: [{ start: 2.6, end: 2.96667, duration: 0.366667 }] }), EXPECTED);
  assert.equal(byId(tailOnly, 'black-frames').status, 'pass');
  // Конец отрезка дальше двух кадров от конца видео – это уже провал, а не концовка.
  const early = evaluateMotionPreview(passing({ blackSegments: [{ start: 2.5, end: 2.9, duration: 0.4 }] }), EXPECTED);
  assert.equal(byId(early, 'black-frames').status, 'fail');
});

test('loudness outside −14 ±1 LUFS or true peak above −1.5 dBTP blocks with an audio-recipe hint', () => {
  for (const [loudness, id] of [[{ integratedLufs: -16.2, truePeakDbtp: -2 }, 'loudness-integrated'],
    [{ integratedLufs: -12.9, truePeakDbtp: -2 }, 'loudness-integrated'],
    [{ integratedLufs: -14, truePeakDbtp: -1.2 }, 'true-peak']]) {
    const result = evaluateMotionPreview(passing({ loudness }), EXPECTED);
    assert.equal(result.block, true, JSON.stringify(loudness));
    assert.equal(byId(result, id).status, 'fail');
    assert.match(byId(result, id).message, /audio-recipe\.md/);
  }
  for (const integratedLufs of [-15, -13]) {
    assert.equal(evaluateMotionPreview(passing({ loudness: { integratedLufs, truePeakDbtp: -1.5 } }), EXPECTED).block, false);
  }
  const missing = evaluateMotionPreview(passing({ loudness: null }), EXPECTED);
  assert.equal(byId(missing, 'loudness-integrated').status, 'fail');
});

test('44100 Hz, a second audio stream, a wrong size or fps block', () => {
  const rate = evaluateMotionPreview(passing({ probe: parseProbe(probeJson({ rates: [44100] })) }), EXPECTED);
  assert.equal(byId(rate, 'sample-rate').status, 'fail');
  assert.match(byId(rate, 'sample-rate').message, /44100/);
  const streams = evaluateMotionPreview(passing({ probe: parseProbe(probeJson({ rates: [48000, 48000] })) }), EXPECTED);
  assert.equal(byId(streams, 'audio-streams').status, 'fail');
  const none = evaluateMotionPreview(passing({ probe: parseProbe(probeJson({ rates: [] })) }), EXPECTED);
  assert.deepEqual(['audio-streams', 'sample-rate', 'loudness-integrated'].map((id) => byId(none, id).status), ['fail', 'fail', 'fail']);
  assert.equal(byId(evaluateMotionPreview(passing({ probe: parseProbe(probeJson({ width: 640 })) }), EXPECTED), 'frame-size').status, 'fail');
  assert.equal(byId(evaluateMotionPreview(passing({ probe: parseProbe(probeJson({ fps: '25/1' })) }), EXPECTED), 'fps').status, 'fail');
});

test('a partial preview skips loudness with a reason but still checks black frames and the stream', () => {
  const result = evaluateMotionPreview(passing({ fullRange: false, loudness: null, blackSegments: [{ start: 0.5, end: 1, duration: 0.5 }] }), EXPECTED);
  assert.equal(byId(result, 'loudness-integrated').status, 'skipped');
  assert.equal(byId(result, 'true-peak').status, 'skipped');
  assert.match(byId(result, 'loudness-integrated').message, /фрагмент/);
  assert.equal(byId(result, 'black-frames').status, 'fail');
  assert.equal(result.block, true);
});

test('measurement runs ffprobe then one ffmpeg pass; ebur128 only for a full range', () => {
  for (const fullRange of [true, false]) {
    const calls = [];
    const captureImpl = (command, args, options) => {
      calls.push({ command, args, options });
      return command === 'ffprobe' ? { stdout: probeJson(), stderr: '' } : { stdout: '', stderr: STDERR };
    };
    const measured = measureMotionPreview({ videoPath: 'stage/preview.mp4', fullRange }, { captureImpl });
    assert.deepEqual(calls.map((call) => call.command), ['ffprobe', 'ffmpeg']);
    assert.ok(calls.every((call) => call.options.maxBuffer > 0));
    const ffmpeg = calls[1].args;
    assert.ok(ffmpeg.includes('blackdetect=d=0.1:pix_th=0.10:pic_th=0.999'));
    assert.equal(ffmpeg.some((arg) => arg.startsWith('ebur128=peak=true')), fullRange);
    assert.equal(ffmpeg.at(-3), '-f');
    assert.deepEqual(measured.loudness, fullRange ? { integratedLufs: -21.8, truePeakDbtp: -16.1 } : null);
    assert.equal(measured.blackSegments.length, 2);
  }
});

test('the gate writes qa/motion-preview-<label>.json without absolute paths', (t) => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-gates-'));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  const measureImpl = () => passing();
  const now = () => new Date('2026-10-17T10:00:00Z');
  const full = runMotionPreviewGates({ projectDir, videoPath: path.join(projectDir, 'stage.mp4'), expected: EXPECTED, range: { kind: 'full', fromSec: 0, toSec: 3 } }, { measureImpl, now });
  assert.equal(full.block, false);
  assert.equal(full.reportPath, path.join(projectDir, 'qa', 'motion-preview-full.json'));
  const stored = JSON.parse(fs.readFileSync(full.reportPath, 'utf8'));
  assert.equal(stored.kind, 'motion-preview');
  assert.equal(stored.createdAt, '2026-10-17T10:00:00.000Z');
  assert.equal(stored.checks.length, 8);
  assert.equal(fs.readFileSync(full.reportPath, 'utf8').includes(projectDir), false);
  const part = runMotionPreviewGates({ projectDir, videoPath: 'x.mp4', expected: EXPECTED, range: { kind: 'excerpt', fromSec: 1.5, toSec: 2.25 } }, { measureImpl, now });
  assert.equal(path.basename(part.reportPath), 'motion-preview-excerpt-1500-2250.json');
  assert.deepEqual(fs.readdirSync(path.join(projectDir, 'qa')).sort(), ['motion-preview-excerpt-1500-2250.json', 'motion-preview-full.json']);
});

test('a qa symlink is a write error, not a silent pass', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-gates-link-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectDir = path.join(root, 'project'); fs.mkdirSync(projectDir); fs.mkdirSync(path.join(root, 'elsewhere'));
  fs.symlinkSync(path.join(root, 'elsewhere'), path.join(projectDir, 'qa'));
  const result = runMotionPreviewGates({ projectDir, videoPath: 'x.mp4', expected: EXPECTED, range: { kind: 'full', fromSec: 0, toSec: 3 } }, { measureImpl: () => passing() });
  assert.equal(result.reportPath, null);
  assert.match(result.writeError, /qa/);
  assert.deepEqual(fs.readdirSync(path.join(root, 'elsewhere')), []);
});

// Настоящий ffmpeg: синтетический ролик с чёрной дырой посередине и затемнением в конце, звук 44,1 кГц.
test('real ffmpeg: black gap and 44.1 kHz are caught, black tail is not', { skip: !hasFfmpeg }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-gates-real-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const video = path.join(dir, 'preview.mp4');
  const made = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=white:s=160x284:r=30:d=3',
    '-f', 'lavfi', '-i', 'sine=f=440:r=44100:d=3',
    '-vf', "drawbox=enable='between(t,1,1.5)':c=black:t=fill,drawbox=enable='gte(t,2.6)':c=black:t=fill",
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video]);
  assert.equal(made.status, 0, String(made.stderr));
  assert.ok(analyzeArgs(video, { loudness: true }).includes('-nostats'));
  const result = runMotionPreviewGates({ projectDir: dir, videoPath: video, expected: { width: 160, height: 284, fps: 30 },
    range: { kind: 'full', fromSec: 0, toSec: 3 } }, { write: false });
  assert.equal(result.block, true);
  assert.deepEqual(byId(result, 'black-frames').measured.map((gap) => gap.fromSec), [1]);
  assert.equal(byId(result, 'sample-rate').measured, 44100);
  assert.equal(byId(result, 'sample-rate').status, 'fail');
  assert.equal(typeof byId(result, 'loudness-integrated').measured, 'number');
  assert.equal(byId(result, 'loudness-integrated').status, 'fail');
});

// Первый боевой прогон: оба настоящих рекламных ролика блокировались ложно. На 16–17 с – тёмная сцена
// с кнопкой «Утверждаю» (меньше 2 % кадра светлые), а при pic_th по умолчанию (0,98) такой кадр «чёрный».
// В начале – задуманное появление искр из темноты.
test('regression: dark design is not a black gap; only a fully black frame is', () => {
  assert.match(BLACKDETECT_FILTER, /pix_th=0\.10/);
  assert.match(BLACKDETECT_FILTER, /pic_th=0\.999\b/);
});

test('an opening fade-in from black up to 1 s passes; a longer black opening blocks', () => {
  const fadeIn = evaluateMotionPreview(passing({ blackSegments: [{ start: 0, end: 0.5, duration: 0.5 }] }), EXPECTED);
  assert.equal(byId(fadeIn, 'black-frames').status, 'pass');
  assert.match(byId(fadeIn, 'black-frames').message, /начал/);
  const longOpening = evaluateMotionPreview(passing({ blackSegments: [{ start: 0, end: 1.4, duration: 1.4 }] }), EXPECTED);
  assert.equal(byId(longOpening, 'black-frames').status, 'fail');
  const notAtStart = evaluateMotionPreview(passing({ blackSegments: [{ start: 0.2, end: 0.6, duration: 0.4 }] }), EXPECTED);
  assert.equal(byId(notAtStart, 'black-frames').status, 'fail');
});

test('real ffmpeg: a dark frame with a small bright element is not black; a black frame between scenes is', { skip: !hasFfmpeg }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-gates-dark-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const video = path.join(dir, 'preview.mp4');
  // Тёмно-серый фон (#0A0A0C, как у тёмных сцен) с кнопкой ~1,5 % кадра; на 2–2,3 с – полностью чёрный кадр.
  const made = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x0A0A0C:s=160x284:r=30:d=3',
    '-vf', "drawbox=x=50:y=130:w=60:h=11:c=0xE0B060:t=fill,drawbox=enable='between(t,2,2.3)':c=black:t=fill",
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video]);
  assert.equal(made.status, 0, String(made.stderr));
  const run = spawnSync('ffmpeg', analyzeArgs(video, { loudness: false }), { encoding: 'utf8' });
  assert.deepEqual(parseBlackdetect(run.stderr).map((gap) => Math.round(gap.start * 10) / 10), [2]);
});

// Ревью #43: хвост без предела длины пропускал полностью чёрный preview и ролик, чёрный с середины.
test('regression: an all-black preview or a long black ending blocks', () => {
  const allBlack = evaluateMotionPreview(passing({ blackSegments: [{ start: 0, end: 2.967, duration: 2.967 }] }), EXPECTED);
  assert.equal(byId(allBlack, 'black-frames').status, 'fail');
  const longTail = evaluateMotionPreview(passing({ blackSegments: [{ start: 1, end: 3, duration: 2 }] }), EXPECTED);
  assert.equal(byId(longTail, 'black-frames').status, 'fail');
  const fadeOut = evaluateMotionPreview(passing({ blackSegments: [{ start: 1.8, end: 3, duration: 1.2 }] }), EXPECTED);
  assert.equal(byId(fadeOut, 'black-frames').status, 'pass');
  // Один отрезок не может быть сразу и появлением, и концовкой: короткий ролик целиком чёрный – провал.
  const shortProbe = parseProbe(probeJson({ duration: '0.800000' }));
  const shortAllBlack = evaluateMotionPreview(passing({ probe: shortProbe,
    blackSegments: [{ start: 0, end: 0.8, duration: 0.8 }] }), EXPECTED);
  assert.equal(byId(shortAllBlack, 'black-frames').status, 'fail');
});

test('regression: excerpt edges are not the reel edges, so a gap there still blocks', () => {
  const head = { start: 0, end: 0.4, duration: 0.4 };
  const tail = { start: 2.7, end: 3, duration: 0.3 };
  const inner = evaluateMotionPreview(passing({ blackSegments: [head, tail], edges: { head: false, tail: false } }), EXPECTED);
  assert.equal(byId(inner, 'black-frames').measured.length, 2);
  const opening = evaluateMotionPreview(passing({ blackSegments: [head, tail], edges: { head: true, tail: false } }), EXPECTED);
  assert.deepEqual(byId(opening, 'black-frames').measured, [{ fromSec: 2.7, toSec: 3 }]);
});

test('excerpt edges come from the range and the full reel length', () => {
  const capture = () => ({ stdout: probeJson(), stderr: '' });
  const at = (range) => {
    let seen = null;
    runMotionPreviewGates({ projectDir: '/nowhere', videoPath: 'p.mp4', expected: { ...EXPECTED, totalSec: 30 }, range },
      { write: false, measureImpl: (input) => { seen = input; return passing(); }, captureImpl: capture });
    return seen.edges;
  };
  assert.deepEqual(at({ kind: 'full', fromSec: 0, toSec: 30 }), { head: true, tail: true });
  assert.deepEqual(at({ kind: 'excerpt', fromSec: 0, toSec: 6 }), { head: true, tail: false });
  assert.deepEqual(at({ kind: 'excerpt', fromSec: 24, toSec: 30 }), { head: false, tail: true });
  assert.deepEqual(at({ kind: 'excerpt', fromSec: 10, toSec: 16 }), { head: false, tail: false });
});

test('a file without a video stream fails with a report instead of crashing ffmpeg', () => {
  const calls = [];
  const capture = (command) => {
    calls.push(command);
    return { stdout: JSON.stringify({ streams: [{ codec_type: 'audio', sample_rate: '48000' }], format: { duration: '3.0' } }), stderr: '' };
  };
  const result = runMotionPreviewGates({ projectDir: '/nowhere', videoPath: 'p.mp4', expected: EXPECTED,
    range: { kind: 'full', fromSec: 0, toSec: 3 } }, { write: false, captureImpl: capture });
  assert.deepEqual(calls, ['ffprobe']);
  assert.equal(result.block, true);
  assert.equal(byId(result, 'frame-size').status, 'fail');
  assert.match(byId(result, 'frame-size').message, /видеодорожк/);
  assert.equal(byId(result, 'black-frames').status, 'fail');
});

// Размер файла: полнокадровый шум (зерно, мерцание) h264 не сжимает – 27 с ролика весили 78–136 МБ.
const FULL = { width: 1080, height: 1920, fps: 30 };
const fullProbe = (options) => parseProbe(probeJson({ width: 1080, height: 1920, ...options }));

test('probe asks ffprobe for stream and format bit_rate and falls back to the container rate', () => {
  const entries = probeArgs('a.mp4')[probeArgs('a.mp4').indexOf('-show_entries') + 1];
  assert.match(entries, /stream=[^:]*bit_rate/);
  assert.match(entries, /format=[^:]*bit_rate/);
  const fallback = parseProbe(probeJson({ bitRate: null, formatBitRate: '3000000' }));
  assert.deepEqual([fallback.videoBitRate, fallback.bitRateSource], [3000000, 'format']);
  const none = parseProbe(probeJson({ bitRate: 'N/A' }));
  assert.deepEqual([none.videoBitRate, none.bitRateSource], [null, null]);
});

test('video-bitrate: 23 Mbit/s at 1080x1920 30 fps warns but never blocks', () => {
  const result = evaluateMotionPreview(passing({ probe: fullProbe({ bitRate: '23000000' }) }), FULL);
  const item = byId(result, 'video-bitrate');
  assert.equal(item.status, 'warn');
  assert.equal(result.block, false, 'warn не блокирует публикацию');
  assert.equal(item.measured, 23);
  assert.match(item.limit, /20/);
  assert.match(item.message, /зерно/);
  assert.match(item.message, /тяж[её]л/);
  assert.match(formatMotionReport(result), /⚠️ video-bitrate/);
  assert.match(formatMotionReport(result), /опубликован, есть предупреждения/);
});

test('video-bitrate: 2 Mbit/s passes; the limit scales with pixel area and fps', () => {
  assert.equal(byId(evaluateMotionPreview(passing({ probe: fullProbe({ bitRate: '2000000' }) }), FULL), 'video-bitrate').status, 'pass');
  // 540x960 – четверть площади: порог 5 Мбит/с, 6 Мбит/с уже тяжело.
  const small = { width: 540, height: 960, fps: 30 };
  const probe = (bitRate) => parseProbe(probeJson({ width: 540, height: 960, bitRate }));
  assert.equal(byId(evaluateMotionPreview(passing({ probe: probe('6000000') }), small), 'video-bitrate').status, 'warn');
  assert.equal(byId(evaluateMotionPreview(passing({ probe: probe('4500000') }), small), 'video-bitrate').status, 'pass');
  // 60 fps – порог вдвое выше: 30 Мбит/с ещё в норме.
  const fast = parseProbe(probeJson({ width: 1080, height: 1920, fps: '60/1', bitRate: '30000000' }));
  assert.equal(byId(evaluateMotionPreview(passing({ probe: fast }), { ...FULL, fps: 60 }), 'video-bitrate').status, 'pass');
});

test('video-bitrate: no bit_rate in ffprobe is skipped with a reason, not a pass or a fail', () => {
  const result = evaluateMotionPreview(passing({ probe: fullProbe({ bitRate: null }) }), FULL);
  const item = byId(result, 'video-bitrate');
  assert.equal(item.status, 'skipped');
  assert.match(item.message, /bit_rate/);
  assert.equal(result.block, false);
});
