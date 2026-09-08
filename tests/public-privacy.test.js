const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { checkPublicPrivacy } = require('../scripts/check-public-privacy');

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function write(root, relativePath, bytes) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
  return target;
}

function fixtureRepo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-public-privacy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'privacy-test@example.invalid']);
  git(root, ['config', 'user.name', 'Privacy Test']);
  write(root, 'ASSETS.md', [
    '# Public assets',
    '',
    '| Path | Kind | Origin | Author / license | Source or generator | Redistribution basis |',
    '|---|---|---|---|---|---|',
    '',
  ].join('\n'));
  write(root, '.env.example', 'PUBLIC_THEME=\n');
  write(root, 'README.md', '# Fixture\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'initial fixture']);
  return root;
}

function stageBytes(root, relativePath, bytes) {
  write(root, relativePath, bytes);
  git(root, ['add', '-f', '--', relativePath]);
}

function commitBytes(root, relativePath, bytes) {
  stageBytes(root, relativePath, bytes);
  git(root, ['commit', '-qm', `add ${relativePath}`]);
}

function assetRow(relativePath) {
  return `| \`${relativePath}\` | fixture | local | contributors / MIT | generator | MIT |`;
}

test('a neutral repository passes tracked and staged privacy checks', (t) => {
  const root = fixtureRepo(t);

  assert.deepEqual(checkPublicPrivacy({ root, scope: 'tracked' }), { ok: true, issues: [] });
  assert.deepEqual(checkPublicPrivacy({ root, scope: 'staged' }), { ok: true, issues: [] });
});

test('staged mode rejects a client video before it can be committed', (t) => {
  const root = fixtureRepo(t);
  const privateVideo = ['projects', 'client-a', 'input', 'source.mp4'].join('/');
  stageBytes(root, privateVideo, Buffer.from('private'));

  const result = checkPublicPrivacy({ root, scope: 'staged' });

  assert.equal(result.ok, false);
  assert.match(result.issues[0].message, /forbidden project path/);
  assert.equal(result.issues[0].path, privateVideo);
});

test('staged mode scans the index blob and ignores a safe unstaged replacement', (t) => {
  const root = fixtureRepo(t);
  const leaked = ['', 'Users', 'private-user', 'Desktop', 'source.mp4'].join('/');
  stageBytes(root, 'docs/example.md', leaked);
  write(root, 'docs/example.md', 'portable example\n');

  const result = checkPublicPrivacy({ root, scope: 'staged' });

  assert.equal(result.ok, false);
  assert.match(result.issues[0].message, /absolute local path/);
  assert.doesNotMatch(JSON.stringify(result.issues), /private-user/);
});

test('tracked mode rejects personal absolute paths without echoing their contents', (t) => {
  const root = fixtureRepo(t);
  const unixPath = ['', 'home', 'private-user', 'recordings', 'source.mov'].join('/');
  const windowsPath = ['C:', 'Users', 'private-user', 'recordings', 'source.mov'].join('\\');
  commitBytes(root, 'docs/example.md', `${unixPath}\n${windowsPath}\n`);

  const result = checkPublicPrivacy({ root, scope: 'tracked' });

  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => /absolute local path/.test(issue.message)));
  assert.doesNotMatch(JSON.stringify(result.issues), /private-user/);
});

test('environment files are private except for the documented example', (t) => {
  const root = fixtureRepo(t);
  stageBytes(root, '.env.local', 'TOKEN=secret\n');

  const result = checkPublicPrivacy({ root, scope: 'staged' });

  assert.equal(result.ok, false);
  assert.match(result.issues[0].message, /environment file/);
  assert.equal(result.issues.some((issue) => issue.path === '.env.example'), false);
});

test('tracked media must be declared in the six-column ASSETS table', (t) => {
  const root = fixtureRepo(t);
  commitBytes(root, 'examples/unlisted.mp4', Buffer.from('fixture'));

  const result = checkPublicPrivacy({ root, scope: 'tracked' });

  assert.equal(result.ok, false);
  assert.match(result.issues[0].message, /ASSETS\.md/);
});

test('media declared in ASSETS.md is allowed', (t) => {
  const root = fixtureRepo(t);
  const mediaPath = 'examples/neutral.mp4';
  const assets = `${fs.readFileSync(path.join(root, 'ASSETS.md'), 'utf8')}${assetRow(mediaPath)}\n`;
  write(root, 'ASSETS.md', assets);
  write(root, mediaPath, Buffer.from('fixture'));
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'add declared media']);

  assert.deepEqual(checkPublicPrivacy({ root, scope: 'tracked' }), { ok: true, issues: [] });
});

test('a symlink target is scanned as text', (t) => {
  const root = fixtureRepo(t);
  const target = ['', 'var', 'folders', 'private', 'source.mov'].join('/');
  fs.symlinkSync(target, path.join(root, 'source-link'));
  git(root, ['add', 'source-link']);

  const result = checkPublicPrivacy({ root, scope: 'staged' });

  assert.equal(result.ok, false);
  assert.match(result.issues[0].message, /absolute local path/);
  assert.doesNotMatch(JSON.stringify(result.issues), /source\.mov/);
});

test('unknown scope fails closed', (t) => {
  const root = fixtureRepo(t);

  assert.throws(
    () => checkPublicPrivacy({ root, scope: 'working-tree' }),
    /scope must be tracked or staged/,
  );
});
