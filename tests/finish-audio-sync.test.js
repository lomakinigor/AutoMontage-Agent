const test = require('node:test');
const assert = require('node:assert/strict');

const {
  REMOTION_AUDIO_ADVANCE_MS,
  buildFinishAudioFilter,
} = require('../scripts/finish-audio');
const { finishEncodeCommand } = require('../scripts/finish');

test('Remotion 4.0.536 signals the AAC delay itself: finish does not advance its audio', () => {
  // Регрессия: срез 42,5 мс поверх edit list Remotion уводил голос вперёд и резал 2 кадра хвоста.
  assert.equal(REMOTION_AUDIO_ADVANCE_MS, 0);
  assert.equal(buildFinishAudioFilter(REMOTION_AUDIO_ADVANCE_MS), 'loudnorm=I=-14:TP=-1.5:LRA=11');
});

test('explicit audio advance still trims the measured delay', () => {
  assert.equal(
    buildFinishAudioFilter(42.5),
    'atrim=start=0.0425,asetpts=PTS-STARTPTS,loudnorm=I=-14:TP=-1.5:LRA=11',
  );
});

test('finish audio filter leaves timing untouched without compensation', () => {
  assert.equal(
    buildFinishAudioFilter(0),
    'loudnorm=I=-14:TP=-1.5:LRA=11',
  );
});

test('finish caps filtered audio at the copied video duration', () => {
  const command = finishEncodeCommand('input.mp4', 'output.mp4', {
    hdrMode: 'off',
    sharpen: false,
    lanczos: null,
    audioAdvanceMs: 42.5,
  }, false);

  assert.ok(command.args.includes('-shortest'));
});
