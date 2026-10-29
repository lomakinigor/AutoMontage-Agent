// Горизонтальный motion-ролик 16:9: aspect в ТЗ, сверка с размером, флаг --aspect у scaffold.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { fixture } = require('./helpers/motion-workflow-fixture.cjs');
const { runMotion, parseMotionOptions } = require('../scripts/motion/build');
const { validateMotionBrief } = require('../scripts/motion/brief');

const probe = { probeOpenedAudioImpl() { return { mediaKind: 'audio', durationSec: 2 }; } };
const noWhisper = { transcribeMotionNarrationImpl() { throw new Error('Whisper must not run'); } };
const speech = {
  transcribeMotionNarrationImpl({ workspace }) {
    const transcript = [{ start: 0, end: 2, text: 'Привет', words: [] }];
    fs.writeFileSync(path.join(workspace.dir, 'transcript/words.json'), JSON.stringify(transcript));
    return { transcript };
  },
};

function makeBrief(output) {
  return {
    version: 1, kind: 'motion-reel', status: 'draft', source: 'input/narration.mp3',
    theme: 'motion-neutral', title: 'Горизонталь',
    output: { fps: 30, durationInFrames: 90, ...output },
    scenes: [{ scene: 'kinetic-title', start: 0, end: 3, text: 'Главная мысль' }],
  };
}

test('horizontal brief 1920x1080 is valid, vertical 1080x1920 still is', () => {
  assert.equal(validateMotionBrief(makeBrief({ aspect: 'horizontal', width: 1920, height: 1080 })).ok, true);
  assert.equal(validateMotionBrief(makeBrief({ aspect: 'vertical', width: 1080, height: 1920 })).ok, true);
});

test('aspect and size mismatch is a clear Russian validator error, both ways', () => {
  const wrongH = validateMotionBrief(makeBrief({ aspect: 'horizontal', width: 1080, height: 1920 }));
  assert.equal(wrongH.ok, false);
  assert.ok(wrongH.errors.some(e => /output\.aspect.*horizontal.*ширина.*больше высоты/.test(e)), wrongH.errors.join('\n'));
  const wrongV = validateMotionBrief(makeBrief({ aspect: 'vertical', width: 1920, height: 1080 }));
  assert.equal(wrongV.ok, false);
  assert.ok(wrongV.errors.some(e => /output\.aspect.*vertical.*высота.*больше ширины/.test(e)), wrongV.errors.join('\n'));
  assert.equal(validateMotionBrief(makeBrief({ aspect: 'square', width: 1080, height: 1080 })).ok, false);
});

test('parser accepts --aspect for scaffold and music-only, rejects it for final and TTS', () => {
  assert.equal(parseMotionOptions(['t.wav', '--project', 'P', '--aspect', 'horizontal']).aspect, 'horizontal');
  assert.equal(parseMotionOptions(['t.wav', '--project', 'P', '--music-only', '--aspect', 'horizontal']).aspect, 'horizontal');
  assert.equal(parseMotionOptions(['t.wav', '--project', 'P']).aspect, undefined);
  assert.throws(() => parseMotionOptions(['--project-dir', '.', '--brief', 'brief/a.json', '--aspect', 'horizontal']), /--aspect/);
  assert.throws(() => parseMotionOptions(['--script', 's.txt', '--voice', 'elevenlabs', '--project', 'P', '--aspect', 'horizontal']), /--aspect/);
});

test('unknown --aspect exits with code 2 and a Russian message', () => {
  const run = spawnSync(process.execPath, [path.join(__dirname, '../scripts/motion/build.js'),
    't.wav', '--project', 'P', '--aspect', 'square'], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /--aspect.*vertical.*horizontal/);
  assert.throws(() => parseMotionOptions(['t.wav', '--project', 'P', '--aspect', 'square']), (e) => e.exitCode === 2);
});

for (const musicOnly of [false, true]) {
  test(`scaffold${musicOnly ? ' --music-only' : ''}: --aspect horizontal gives 1920x1080, default stays 1080x1920`, (t) => {
    const make = (name, aspect) => {
      const f = fixture(t);
      const result = runMotion({ narrationPath: f.narrationPath, project: 'Промо', projectDir: path.join(f.root, name),
        ...(musicOnly ? { musicOnly: true } : {}), ...(aspect ? { aspect } : {}) },
      { ...probe, ...(musicOnly ? noWhisper : speech) });
      const brief = JSON.parse(fs.readFileSync(result.jsonPath));
      assert.equal(validateMotionBrief(brief).ok, true);
      return brief.output;
    };
    const horizontal = make('h', 'horizontal');
    assert.deepEqual([horizontal.aspect, horizontal.width, horizontal.height], ['horizontal', 1920, 1080]);
    const vertical = make('v');
    assert.deepEqual([vertical.aspect, vertical.width, vertical.height], ['vertical', 1080, 1920]);
  });
}
