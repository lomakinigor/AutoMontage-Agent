const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('music ducking applies the approved start, speed and edge fades', () => {
  const script = path.join(__dirname, '../scripts/mix-music.js');
  const result = spawnSync(process.execPath, [
    script,
    'voice.mp4',
    'music.mp3',
    'out.mp4',
    '--gain', '-22',
    '--start', '24',
    '--rate', '1.06',
    '--fade-in', '0.15',
    '--fade-out', '0.8',
    '--duration', '53.6',
    '--dry-run',
  ], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /atrim=start=24/);
  assert.match(result.stdout, /atempo=1\.06/);
  assert.match(result.stdout, /afade=t=in:st=0:d=0\.15/);
  assert.match(result.stdout, /afade=t=out:st=52\.8:d=0\.8/);
  assert.match(result.stdout, /sidechaincompress=/);
});

// Регрессия #43: настоящий микс голоса после finish.js с музыкой на −6 dB. Раньше выход был 44,1 кГц и
// громче −14 LUFS (музыка добавлялась уже после loudnorm финиша); теперь – 48 кГц и −14 ±1 LUFS.
test('real mix of a finished voice with loud music stays at −14 LUFS and 48 kHz', (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const { toolAvailable, runTool } = require('./helpers/media-fixtures');
  const { parseEbur128 } = require('../scripts/qa/motion-preview-gates');
  if (!toolAvailable('ffmpeg') || !toolAvailable('ffprobe')) { t.skip('ffmpeg недоступен'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mix-loudnorm-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const voice = path.join(dir, 'voice.mp4'); const finished = path.join(dir, 'finished.mp4');
  const music = path.join(dir, 'music.wav'); const mixed = path.join(dir, 'mixed.mp4');
  runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=25:d=12',
    '-f', 'lavfi', '-i', "aevalsrc='0.3*sin(2*PI*220*t)*gt(sin(2*PI*0.5*t),0)':s=48000:d=12",
    '-map', '0:v', '-map', '1:a', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '2', voice]);
  runTool(process.execPath, [path.join(__dirname, '../scripts/finish.js'), voice, finished]);
  runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=44100:duration=5', '-ac', '2', music]);
  runTool(process.execPath, [path.join(__dirname, '../scripts/mix-music.js'), finished, music, mixed, '--gain', '-6']);
  const rate = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=sample_rate', '-of', 'csv=p=0', mixed], { encoding: 'utf8' });
  assert.equal(rate.stdout.trim(), '48000');
  const loud = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', mixed, '-af', 'ebur128=peak=true:framelog=verbose', '-f', 'null', '-'], { encoding: 'utf8' });
  const { integratedLufs, truePeakDbtp } = parseEbur128(loud.stderr);
  assert.ok(Math.abs(integratedLufs + 14) <= 1, `микс ${integratedLufs} LUFS`);
  assert.ok(truePeakDbtp <= -1.5, `пик ${truePeakDbtp} dBTP`);
});
