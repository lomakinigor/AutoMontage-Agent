const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { WHISPER_PROBE_PY, evaluateWhisperProbe } = require('../scripts/whisper-check');

const ROOT = path.join(__dirname, '..');

// #98: свежий pip ставил PyAV 19, а faster-whisper 1.2.1 передаёт av.open(metadata_errors=...),
// которого в PyAV 19 нет – транскрипция падала на первом файле.
test('requirements.txt caps PyAV below 19 for faster-whisper 1.2.1', () => {
  const lines = fs.readFileSync(path.join(ROOT, 'requirements.txt'), 'utf8')
    .split('\n').map((line) => line.replace(/#.*/, '').trim()).filter(Boolean);
  const av = lines.find((line) => /^av\b/.test(line));
  assert.ok(av, 'requirements.txt must pin av explicitly');
  const cap = av.match(/<\s*(\d+)/);
  assert.ok(cap, `av needs an upper bound, got "${av}"`);
  assert.ok(Number(cap[1]) <= 19, `av upper bound must exclude 19, got "${av}"`);
});

test('whisper probe decodes real audio through faster_whisper, not just import', () => {
  assert.match(WHISPER_PROBE_PY, /from faster_whisper\.audio import decode_audio/);
  assert.match(WHISPER_PROBE_PY, /decode_audio\(buf\)/);
  assert.match(WHISPER_PROBE_PY, /import av/);
});

test('probe reports the PyAV 19 failure as a warning with the fix', () => {
  const result = evaluateWhisperProbe({
    status: 0,
    stdout: JSON.stringify({
      fasterWhisper: '1.2.1',
      av: '19.0.1',
      decode: false,
      error: "TypeError: open() got an unexpected keyword argument 'metadata_errors'",
    }),
  });
  assert.equal(result.level, 'warn');
  assert.match(result.message, /PyAV 19\.0\.1/);
  assert.match(result.message, /metadata_errors/);
  assert.match(result.message, /pip install -r requirements\.txt/);
});

test('probe passes a compatible pair', () => {
  const result = evaluateWhisperProbe({
    status: 0,
    stdout: JSON.stringify({ fasterWhisper: '1.2.1', av: '18.1.0', decode: true }),
  });
  assert.equal(result.level, 'ok');
  assert.match(result.message, /faster-whisper 1\.2\.1, PyAV 18\.1\.0/);
});

test('probe keeps the missing-package warning and survives garbage output', () => {
  assert.match(evaluateWhisperProbe({ status: 0, stdout: '{"missing": true}' }).message, /не установлен/);
  assert.equal(evaluateWhisperProbe({ status: 1, stdout: '' }).level, 'warn');
  assert.equal(evaluateWhisperProbe({ status: 0, stdout: 'Traceback…' }).level, 'warn');
});
