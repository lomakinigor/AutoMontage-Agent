const test = require('node:test');
const assert = require('node:assert/strict');
const { finishEncodeCommand } = require('../scripts/finish');

// loudnorm resamples internally to 192 kHz and outputs 96 kHz unless the rate is pinned:
// preview/final audio must leave finish at 48 kHz.
for (const [label, options, isHDR] of [
  ['copied video', { hdrMode: 'off', sharpen: false, lanczos: null, audioAdvanceMs: 0 }, false],
  ['re-encoded video', { hdrMode: 'on', sharpen: true, lanczos: { width: 1080, height: 1920 }, audioAdvanceMs: 42.5 }, true],
]) {
  test(`finish pins AAC output to 48 kHz after loudnorm (${label})`, () => {
    const { args } = finishEncodeCommand('input.mp4', 'output.mp4', options, isHDR);
    const ar = args.indexOf('-ar');
    assert.ok(ar > args.indexOf('-af'), 'sample rate is set for the filtered audio');
    assert.equal(args[ar + 1], '48000');
    assert.equal(args[args.indexOf('-c:a') + 1], 'aac');
    assert.equal(args.filter((arg) => arg === '-ar').length, 1);
  });
}
