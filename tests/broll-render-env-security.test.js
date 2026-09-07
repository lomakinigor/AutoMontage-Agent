const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveRemotionCommand } = require('../scripts/env');
const { remotionRenderCommand } = require('../scripts/build-commands');
const { remotionChunkCommand } = require('../scripts/render-chunks');
const { docPreviewCommand } = require('../scripts/generate-doc-preview');

const ROOT = path.resolve(__dirname, '..');
const cliDirectory = path.dirname(require.resolve('@remotion/cli/package.json'));

// Run the installed CLI parser and browser-environment loader in an isolated child.
// Match the real remotion-cli.js dotenv bootstrap without starting a render.
function browserEnvironment(t, argv, filename = '.env') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-render-env-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'package.json'), '{"name":"synthetic-env-fixture"}');
  fs.writeFileSync(path.join(directory, filename), [
    'PEXELS_API_KEY=synthetic-provider-secret-do-not-publish',
    'UNRELATED_PRIVATE_VALUE=synthetic-private-value',
    'REMOTION_PUBLIC_FIXTURE=public-dotenv-value',
  ].join('\n'));
  const script = `
    process.argv = [process.execPath, ...JSON.parse(process.argv[1])];
    require(${JSON.stringify(require.resolve('dotenv'))}).config({ quiet: true });
    const { parsedCli } = require(${JSON.stringify(path.join(cliDirectory, 'dist/parsed-cli.js'))});
    const { getEnvironmentVariables } = require(${JSON.stringify(path.join(cliDirectory, 'dist/get-env.js'))});
    const env = getEnvironmentVariables(undefined, 'error', false);
    console.log(JSON.stringify({
      keys: Object.keys(env),
      leakedProvider: env.PEXELS_API_KEY !== undefined,
      leakedPrivate: env.UNRELATED_PRIVATE_VALUE !== undefined,
      publicProcess: env.REMOTION_PUBLIC_PROCESS,
      publicDotenv: env.REMOTION_PUBLIC_FIXTURE,
      positionals: parsedCli._,
      envFile: parsedCli['env-file'],
    }));
  `;
  const result = spawnSync(process.execPath, ['-e', script, JSON.stringify(argv)], {
    cwd: directory,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, REMOTION_PUBLIC_PROCESS: 'public-process-value' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, /synthetic-provider-secret|synthetic-private-value/);
  return JSON.parse(result.stdout);
}

const builders = {
  final: (resolved) => remotionRenderCommand(resolved, {
    entry: 'src/index.js', composition: 'LessonSeq', output: '/tmp/final.mp4', props: '/tmp/props.json',
  }),
  preview: (resolved) => remotionRenderCommand(resolved, {
    entry: 'src/index.js', composition: 'LessonSeq', output: '/tmp/preview.mp4', props: '/tmp/props.json',
    scale: 0.5, crf: 28, frameRange: { fromFrame: 0, toFrameExclusive: 2 },
  }),
  chunk: (resolved) => remotionChunkCommand(resolved, {
    composition: 'LessonSeq', output: '/tmp/chunk.mp4', props: '/tmp/props.json', from: 0, to: 1,
  }),
  still: (resolved) => docPreviewCommand(resolved, '/tmp/still.png'),
};

test('installed Remotion loader reproduces root dotenv browser exposure without protection', (t) => {
  const result = browserEnvironment(t, [path.join(cliDirectory, 'remotion-cli.js'), 'render']);
  assert.equal(result.leakedProvider, true);
  assert.equal(result.leakedPrivate, true);
  assert.equal(result.publicProcess, 'public-process-value');
});

for (const [name, build] of Object.entries(builders)) {
  for (const filename of ['.env', '.env.local']) {
    test(`${name} excludes private ${filename} keys using the installed CLI parser and loader`, (t) => {
      const command = build(resolveRemotionCommand(ROOT));
      const result = browserEnvironment(t, command.args, filename);
      assert.equal(result.leakedProvider, false);
      assert.equal(result.leakedPrivate, false);
      assert.equal(result.publicProcess, 'public-process-value');
      if (filename === '.env') assert.equal(result.publicDotenv, 'public-dotenv-value');
      assert.deepEqual(result.positionals.slice(0, 3), [name === 'still' ? 'still' : 'render', 'src/index.js', 'LessonSeq']);
      assert.ok(path.isAbsolute(result.envFile));
      assert.ok(fs.readFileSync(result.envFile, 'utf8').split('\n').every((line) => !line.trim() || line.trim().startsWith('#')));
    });
  }
}
