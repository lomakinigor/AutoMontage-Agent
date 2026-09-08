'use strict';

const crypto = require('node:crypto');
const { runMediaProcess } = require('../review/media-process');

const TEXT_MAX_BYTES = 4096;
const FRAME_MAX_BYTES = 16 * 1024 * 1024;
const OCR_OUTPUT_MAX_BYTES = 16 * 1024;
const ENGINE = 'tesseract';

function normalizeText(value) {
  const normalized = String(value || '').normalize('NFKC')
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ').trim();
  const bytes = Buffer.from(normalized);
  return bytes.length <= TEXT_MAX_BYTES
    ? normalized : bytes.subarray(0, TEXT_MAX_BYTES).toString('utf8').replace(/\uFFFD$/u, '');
}

function scanResult(texts) {
  const text = normalizeText(texts.filter(Boolean).join(' | '));
  return text
    ? { status: 'needs-review', text, reasons: ['embedded-text-detected'], engine: ENGINE }
    : { status: 'clear', text: '', reasons: [], engine: ENGINE };
}

function unavailable(reason = 'ocr-unavailable') {
  return { status: 'unavailable', text: '', reasons: [reason], engine: ENGINE };
}

async function recognize({ input, signal, run }) {
  const result = await run({
    command: 'tesseract',
    args: ['stdin', 'stdout', '-l', 'eng', '--psm', '11'],
    ...(input ? { stdin: input } : {}),
    signal,
    timeoutMs: 20_000,
    maxStdoutBytes: OCR_OUTPUT_MAX_BYTES,
    maxStderrBytes: OCR_OUTPUT_MAX_BYTES,
  });
  return normalizeText(result.stdout);
}

async function scanEmbeddedText({ filePath, mediaKind, durationSec = 0, signal, run = runMediaProcess } = {}) {
  if (typeof filePath !== 'string' || !['image', 'video'].includes(mediaKind)) {
    return unavailable('unsupported-media');
  }
  try {
    if (mediaKind === 'image') {
      const result = await run({
        command: 'tesseract', args: [filePath, 'stdout', '-l', 'eng', '--psm', '11'], signal,
        timeoutMs: 20_000, maxStdoutBytes: OCR_OUTPUT_MAX_BYTES,
        maxStderrBytes: OCR_OUTPUT_MAX_BYTES,
      });
      return scanResult([result.stdout]);
    }
    if (!Number.isFinite(durationSec) || durationSec <= 0) return unavailable('invalid-duration');
    const texts = [];
    for (const fraction of [0.25, 0.5, 0.75]) {
      const frame = await run({
        command: 'ffmpeg',
        args: ['-v', 'error', '-ss', String(durationSec * fraction), '-i', filePath,
          '-map', '0:v:0', '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'],
        signal, timeoutMs: 20_000, maxStdoutBytes: FRAME_MAX_BYTES,
        maxStderrBytes: OCR_OUTPUT_MAX_BYTES, stdoutEncoding: null,
      });
      texts.push(await recognize({ input: frame.stdout, signal, run }));
    }
    return scanResult(texts);
  } catch (error) {
    if (signal?.aborted || error?.code === 'MEDIA_PROCESS_ABORTED') {
      if (error?.code === 'MEDIA_PROCESS_ABORTED') throw error;
      throw Object.assign(new Error('embedded text scan aborted'), {
        code: 'MEDIA_PROCESS_ABORTED', cause: error,
      });
    }
    return unavailable('ocr-failed');
  }
}

function hashTextScan(scan) {
  const canonical = JSON.stringify({
    status: scan?.status,
    text: scan?.text,
    reasons: scan?.reasons,
    engine: scan?.engine,
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

module.exports = { hashTextScan, scanEmbeddedText };
