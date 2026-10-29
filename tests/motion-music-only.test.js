// Беззвучный (без речи) MotionReel: `automontage motion --music-only`.
// Источник – готовый саундтрек, Whisper не запускается, transcript = [].
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { fixture, sha, fakeMedia } = require('./helpers/motion-workflow-fixture.cjs');
const { runMotion, parseMotionOptions } = require('../scripts/motion/build');
const { validateMotionBrief, formatMotionBriefMarkdown } = require('../scripts/motion/brief');
const { runPreview } = require('../scripts/preview');
const { approveBrief, readProjectManifest, createOrOpenProject } = require('../scripts/project/workspace');

const ROOT = path.join(__dirname, '..');
const probe = (durationSec = 2) => ({ probeOpenedAudioImpl() { return { mediaKind: 'audio', durationSec }; } });
const noWhisper = { transcribeMotionNarrationImpl() { throw new Error('Whisper must not run for a music-only reel'); } };
const fullHd = { probeVideoImpl: () => ({ width: 1080, height: 1920, fps: 30, duration: 2 }) };

function musicOnlyProject(t, extra = {}) {
  const f = fixture(t);
  const projectDir = path.join(f.root, 'music');
  const result = runMotion({ narrationPath: f.narrationPath, project: 'Промо', projectDir, musicOnly: true, ...extra }, { ...probe(), ...noWhisper });
  return { f, projectDir, result };
}

test('parser accepts --music-only only for audio initialization or --project-dir continuation', () => {
  assert.equal(parseMotionOptions(['track.wav', '--project', 'Promo', '--music-only']).musicOnly, true);
  assert.equal(parseMotionOptions(['--project-dir', '.', '--music-only']).musicOnly, true);
  assert.equal(parseMotionOptions(['track.wav', '--project', 'Promo']).musicOnly, undefined);
  for (const args of [
    ['track.wav', '--project', 'Promo', '--music-only', '--model', 'small'],
    ['--project-dir', '.', '--brief', 'brief/a.json', '--music-only'],
    ['--project-dir', '.', '--music-only', '--version-label', 'x'],
    ['--script', 's.txt', '--voice', 'elevenlabs', '--project', 'P', '--music-only'],
    ['--project-dir', '.', '--music-only', '--voice', 'elevenlabs'],
    ['--project-dir', '.', '--music-only', '--voice-id', 'abc'],
  ]) assert.throws(() => parseMotionOptions(args), /--music-only|voice options|motion TTS/, args.join(' '));
  assert.throws(() => parseMotionOptions(['--project-dir', '.', '--music-only', '--music-only']), /duplicate motion option: --music-only/);
  assert.throws(() => parseMotionOptions(['--music-only']), /motion requires/);
  assert.throws(() => parseMotionOptions(['track.wav', '--music-only']), /motion requires/);
});

test('new music-only project never transcribes and scaffolds a soundtrack brief', (t) => {
  const { projectDir, result } = musicOnlyProject(t);
  assert.equal(result.action, 'draft');
  const brief = JSON.parse(fs.readFileSync(result.jsonPath));
  assert.equal(brief.audioRole, 'music');
  assert.equal(brief.music, undefined);
  assert.equal(brief.status, 'draft');
  assert.equal(brief.output.durationInFrames, 60);
  assert.deepEqual(brief.scenes, [{ scene: 'kinetic-title', start: 0, end: 2, text: 'Промо' }]);
  const manifest = readProjectManifest(projectDir);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(projectDir, manifest.transcript.words))), []);
  assert.deepEqual(manifest.renders, []);
  assert.match(fs.readFileSync(result.markdownPath || result.jsonPath.replace(/\.json$/, '.md'), 'utf8'), /Аудио: музыка без речи \(источник – саундтрек\)/);
  assert.ok(validateMotionBrief(brief).ok);
});

test('music-only duration rounds up to whole frames', (t) => {
  const f = fixture(t);
  const result = runMotion({ narrationPath: f.narrationPath, project: 'Промо', projectDir: path.join(f.root, 'odd'), musicOnly: true }, { ...probe(2.01), ...noWhisper });
  assert.equal(JSON.parse(fs.readFileSync(result.jsonPath)).output.durationInFrames, 61);
});

test('regression: empty speech transcript leaves a resumable folder with the exact resume command', (t) => {
  const f = fixture(t);
  const projectDir = path.join(f.root, 'half');
  const previousCwd = process.cwd();
  process.chdir(f.root);
  try {
    let calls = 0;
    assert.throws(() => runMotion({ narrationPath: f.narrationPath, project: 'Промо', projectDir }, {
      ...probe(),
      transcribeMotionNarrationImpl({ workspace }) {
        calls += 1;
        fs.writeFileSync(path.join(workspace.dir, 'transcript/words.json'), '[]\n');
        return { transcript: [] };
      },
    }), (error) => {
      assert.match(error.message, /^narration transcript is empty; a motion draft requires speech text\. For a voiceless music reel continue this project: automontage motion --project-dir half --music-only$/);
      return true;
    });
    assert.equal(calls, 1);
  } finally { process.chdir(previousCwd); }
  assert.equal(readProjectManifest(projectDir).currentBrief, null);
  const resumed = runMotion({ projectDir, musicOnly: true }, { ...probe(), ...noWhisper });
  assert.equal(JSON.parse(fs.readFileSync(resumed.jsonPath)).audioRole, 'music');
  assert.equal(readProjectManifest(projectDir).currentBrief, path.relative(projectDir, resumed.jsonPath).split(path.sep).join('/'));
});

test('empty-transcript error names --project-dir and --music-only from any cwd', (t) => {
  const f = fixture(t);
  assert.throws(() => runMotion({ narrationPath: f.narrationPath, project: 'Промо', projectDir: path.join(f.root, 'other') }, {
    ...probe(), transcribeMotionNarrationImpl: () => ({ transcript: [] }),
  }), (error) => /--project-dir/.test(error.message) && /--music-only/.test(error.message));
});

test('music-only refuses a project whose transcript already has speech', (t) => {
  const f = fixture(t);
  const workspace = createOrOpenProject({ projectDir: path.join(f.root, 'speech'), name: 'Речь', sourcePath: f.narrationPath, projectKind: 'motion-reel', mediaKind: 'audio' });
  fs.writeFileSync(path.join(workspace.dir, 'transcript/words.json'), JSON.stringify([{ start: 0, end: 1, text: 'Привет', words: [{ w: 'Привет', s: 0, e: 1 }] }]));
  assert.throws(() => runMotion({ projectDir: workspace.dir, musicOnly: true }, { ...probe(), ...noWhisper }), /speech/);
  assert.equal(readProjectManifest(workspace.dir).currentBrief, null);
});

test('music-only keeps the existing-brief guard', (t) => {
  const f = fixture(t);
  assert.throws(() => runMotion({ projectDir: f.workspace.dir, musicOnly: true }, { ...probe(), ...noWhisper }), /already has a brief/);
});

test('music-only continuation of an existing project without words writes [] and does not transcribe', (t) => {
  const f = fixture(t);
  const workspace = createOrOpenProject({ projectDir: path.join(f.root, 'fresh'), name: 'Свежий', sourcePath: f.narrationPath, projectKind: 'motion-reel', mediaKind: 'audio' });
  const result = runMotion({ projectDir: workspace.dir, musicOnly: true }, { ...probe(), ...noWhisper });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(workspace.dir, 'transcript/words.json'))), []);
  assert.equal(JSON.parse(fs.readFileSync(result.jsonPath)).audioRole, 'music');
});

test('validation: audioRole music forbids brief.music, unknown roles fail, demo stays valid', (t) => {
  const f = fixture(t);
  const music = { file: 'assets/music/track.wav', sha256: sha('music'), gainDb: -20 };
  const withMusic = validateMotionBrief({ ...f.brief, audioRole: 'music', music });
  assert.equal(withMusic.ok, false);
  assert.ok(withMusic.errors.includes('music: a music-only reel uses the source audio as its soundtrack; mix extra music into the source'));
  assert.equal(validateMotionBrief({ ...f.brief, audioRole: 'narration', music }).ok, true);
  assert.equal(validateMotionBrief({ ...f.brief, audioRole: 'music' }).ok, true);
  assert.equal(validateMotionBrief({ ...f.brief, audioRole: 'voiceover' }).ok, false);
  assert.equal(validateMotionBrief(f.brief).ok, true);
  assert.equal(validateMotionBrief(require('../examples/motion-brief-demo.json')).ok, true);
});

test('Markdown shows the soundtrack line only for music-only briefs', (t) => {
  const f = fixture(t);
  assert.match(formatMotionBriefMarkdown({ ...f.brief, audioRole: 'music' }), /^Аудио: музыка без речи \(источник – саундтрек\)$/m);
  assert.doesNotMatch(formatMotionBriefMarkdown(f.brief), /Аудио:/);
});

function chain(t) {
  const { projectDir, result } = musicOnlyProject(t);
  const workspace = createOrOpenProject({ projectDir });
  const relativePath = path.relative(projectDir, result.jsonPath).split(path.sep).join('/');
  runPreview({ projectDir, briefPath: relativePath, open: false }, { ...fakeMedia(), ...probe(), ...fullHd });
  workspace.manifest = readProjectManifest(projectDir);
  const approved = approveBrief(workspace, result.jsonPath, { confirmPreviewViewed: true });
  const final = (dependencies = {}) => runMotion({ projectDir, briefPath: approved.jsonPath, versionLabel: 'promo' }, { ...fakeMedia(), ...probe(), ...fullHd, ...dependencies });
  return { projectDir, workspace, draft: result, approved, final };
}

test('music-only chain: draft → preview → explicit approval → final, bound to source hash and duration', (t) => {
  const c = chain(t);
  const approvedBrief = JSON.parse(fs.readFileSync(c.approved.jsonPath));
  assert.equal(approvedBrief.audioRole, 'music');
  assert.equal(approvedBrief.approval.sourceSha256, sha(fs.readFileSync(c.workspace.sourcePath)));
  const calls = [];
  const result = c.final({ ...fakeMedia(calls), ...probe(), ...fullHd });
  assert.equal(result.action, 'render');
  assert.equal(calls.some(call => call.stage === 'motion music mix'), false);
  assert.equal(readProjectManifest(c.projectDir).renders.at(-1).status, 'complete');
});

test('music-only final rejects a tampered audioRole, a replaced soundtrack and a changed duration', (t) => {
  for (const mutation of ['audioRole', 'soundtrack', 'duration']) {
    const c = chain(t);
    let dependencies = {};
    if (mutation === 'audioRole') {
      const brief = JSON.parse(fs.readFileSync(c.approved.jsonPath));
      brief.audioRole = 'narration';
      fs.writeFileSync(c.approved.jsonPath, `${JSON.stringify(brief, null, 2)}\n`);
    }
    if (mutation === 'soundtrack') fs.writeFileSync(c.workspace.sourcePath, 'another soundtrack');
    if (mutation === 'duration') dependencies = probe(3);
    const expected = { audioRole: /approved copy hash changed/, soundtrack: /changed|hash|stale/i, duration: /duration does not match/ }[mutation];
    assert.throws(() => c.final(dependencies), expected, mutation);
    assert.deepEqual(fs.readdirSync(path.join(c.projectDir, 'renders')), [], mutation);
  }
});

test('help texts mention --music-only', () => {
  const motion = spawnSync(process.execPath, [path.join(ROOT, 'scripts/motion/build.js'), '--help'], { encoding: 'utf8' });
  assert.equal(motion.status, 0);
  assert.match(motion.stdout, /--project <name> --music-only/);
  assert.match(motion.stdout, /--project-dir <dir> --music-only/);
  const cli = spawnSync(process.execPath, [path.join(ROOT, 'scripts/cli.js'), '--help'], { encoding: 'utf8' });
  assert.equal(cli.status, 0);
  assert.match(cli.stdout, /--music-only/);
});

test('regression: --music-only with --accept-provider-cost is rejected and the message names the flag', () => {
  assert.throws(() => parseMotionOptions(['--project-dir', '.', '--music-only', '--accept-provider-cost']),
    /--music-only .*--accept-provider-cost/);
  assert.throws(() => parseMotionOptions(['track.wav', '--project', 'P', '--accept-provider-cost', '--music-only']),
    /--accept-provider-cost/);
});

test('regression: resume path never passes a dash-leading or backslash path to the shell unquoted', () => {
  const { resumeDir } = require('../scripts/motion/build');
  const cwd = '/work/engine';
  const at = (relative) => path.posix.join(cwd, relative);
  const posix = (relative) => resumeDir(at(relative), { platform: 'darwin', cwd });
  assert.equal(resumeDir(cwd, { platform: 'linux', cwd }), '.');
  assert.equal(posix('projects/promo-1'), 'projects/promo-1');
  assert.equal(posix('-rf'), './-rf');
  assert.equal(posix('--music-only'), './--music-only');
  assert.equal(posix('a\\b'), "'a\\b'");
  assert.equal(posix("it's"), "'it'\\''s'");
  assert.equal(posix('-a b'), "'./-a b'");
});

// #99: on Windows the hint was printed as 'projects\x' in single quotes, which cmd keeps literally.
test('regression: resume path on Windows uses backslashes and double quotes for cmd/PowerShell', () => {
  const { resumeDir } = require('../scripts/motion/build');
  const cwd = 'C:\\Users\\me\\AutoMontage-Agent';
  const win = (relative) => resumeDir(path.win32.join(cwd, relative), { platform: 'win32', cwd });
  assert.equal(resumeDir(cwd, { platform: 'win32', cwd }), '.');
  assert.equal(win('projects\\promo-1'), 'projects\\promo-1');
  assert.equal(win('projects\\2026.10.17 Промо'), '"projects\\2026.10.17 Промо"');
  assert.equal(win("projects\\it's"), '"projects\\it\'s"');
  assert.equal(win('-rf'), '.\\-rf');
  assert.equal(win('-a b'), '".\\-a b"');
  assert.doesNotMatch(win('projects\\a b'), /'/);
});
