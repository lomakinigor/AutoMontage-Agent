'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { hashTextScan, scanEmbeddedText } = require('../scripts/broll/text-scan');

test('missing OCR tool records unavailable evidence and scan hashes are deterministic', async () => {
  const scan = await scanEmbeddedText({
    filePath: '/normalized/image.webp', mediaKind: 'image',
    run: async () => { throw Object.assign(new Error('missing'), { code: 'MEDIA_PROCESS_SPAWN' }); },
  });
  assert.deepEqual(scan, {
    status: 'unavailable', text: '', reasons: ['ocr-failed'], engine: 'tesseract',
  });
  assert.match(hashTextScan(scan), /^[a-f0-9]{64}$/);
  assert.equal(hashTextScan(scan), hashTextScan(structuredClone(scan)));
});

test('image OCR uses bounded shell-free process request and conservatively flags text', async () => {
  let invocation;
  const scan = await scanEmbeddedText({
    filePath: '/normalized/image.webp', mediaKind: 'image',
    run: async (value) => { invocation = value; return { stdout: ' ACME   2026\n' }; },
  });
  assert.equal(invocation.command, 'tesseract');
  assert.deepEqual(invocation.args.slice(0, 2), ['/normalized/image.webp', 'stdout']);
  assert.ok(invocation.timeoutMs <= 20_000);
  assert.equal(scan.status, 'needs-review');
  assert.equal(scan.text, 'ACME 2026');
});

test('video OCR samples three evenly spaced frames through bounded pipes', async () => {
  const calls = [];
  const scan = await scanEmbeddedText({
    filePath: '/normalized/video.mp4', mediaKind: 'video', durationSec: 20,
    run: async (value) => {
      calls.push(value);
      if (value.command === 'ffmpeg') return { stdout: Buffer.from('png') };
      return { stdout: '' };
    },
  });
  const frames = calls.filter((call) => call.command === 'ffmpeg');
  assert.deepEqual(frames.map((call) => call.args[call.args.indexOf('-ss') + 1]), ['5', '10', '15']);
  assert.equal(calls.filter((call) => call.command === 'tesseract').length, 3);
  assert.ok(calls.every((call) => Number.isSafeInteger(call.maxStdoutBytes)));
  assert.equal(scan.status, 'clear');
});

test('installed Tesseract scans generated image and video text locally', async (t) => {
  const available = (command) => !spawnSync(command, ['-version'], { encoding: 'utf8' }).error;
  if (!available('tesseract') || !available('ffmpeg')) return t.skip('local OCR tools unavailable');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-ocr-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const image = path.join(directory, 'text.png');
  const video = path.join(directory, 'text.mp4');
  const filter = "drawtext=fontfile=/System/Library/Fonts/Helvetica.ttc:text=ACME2026:fontcolor=black:fontsize=100:x=(w-text_w)/2:y=(h-text_h)/2";
  for (const [target, args] of [
    [image, ['-f', 'lavfi', '-i', 'color=white:s=1000x300', '-vf', filter, '-frames:v', '1']],
    [video, ['-f', 'lavfi', '-i', 'color=white:s=1000x300:r=5:d=2', '-vf', filter, '-c:v', 'libx264', '-pix_fmt', 'yuv420p']],
  ]) {
    const made = spawnSync('ffmpeg', ['-y', '-v', 'error', ...args, target], { encoding: 'utf8' });
    assert.equal(made.status, 0, made.stderr);
  }
  const imageScan = await scanEmbeddedText({ filePath: image, mediaKind: 'image' });
  const videoScan = await scanEmbeddedText({ filePath: video, mediaKind: 'video', durationSec: 2 });
  assert.equal(imageScan.status, 'needs-review');
  assert.equal(videoScan.status, 'needs-review');
  assert.match(`${imageScan.text} ${videoScan.text}`, /ACME/i);
});
