const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadBrollConfig } = require('../scripts/broll/config');
test('missing key fixed typed error', () =>
  assert.throws(() => loadBrollConfig({ env: {} }), {
    code: 'BROLL_KEY_MISSING',
    message: 'BROLL_KEY_MISSING',
  }));
test('dotenv only optional local fallback, never mutates environment', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'broll-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, '.env'),
    'PEXELS_API_KEY="local-value"\nOTHER=ignored\n',
  );
  const env = {};
  assert.deepEqual(loadBrollConfig({ root, env }), {
    provider: 'pexels',
    apiKey: 'local-value',
  });
  assert.deepEqual(env, {});
  assert.equal(
    loadBrollConfig({ root, env: { PEXELS_API_KEY: 'environment-value' } })
      .apiKey,
    'environment-value',
  );
});
