const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

function packageFiles() {
  const result = spawnSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.length, 1);
  return report[0].files.map((entry) => entry.path);
}

test('npm package excludes local workspaces, memory, renders, and implementation plans', () => {
  const files = packageFiles();
  const forbidden = [
    'docs/superpowers/',
    'projects/',
    'out/',
    'tmp/',
    'memory/',
    'knowledge/',
    '_progress.md',
  ];

  for (const prefix of forbidden) {
    assert.equal(
      files.some((file) => file === prefix || file.startsWith(prefix)),
      false,
      `npm package contains private/local path: ${prefix}`,
    );
  }
});

test('npm package keeps the public CLI, batch guide, skill, and environment template', () => {
  const files = new Set(packageFiles());
  for (const required of [
    'scripts/cli.js',
    'docs/BATCH-REELS-WORKFLOW.md',
    'skills/reel-turnkey/SKILL.md',
    '.env.example',
  ]) {
    assert.ok(files.has(required), `npm package is missing ${required}`);
  }
});
