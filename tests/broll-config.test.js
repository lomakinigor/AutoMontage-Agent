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
test('provider setting permits Pexels and rejects unsupported values without echo', () => {
  assert.equal(
    loadBrollConfig({
      env: { PEXELS_API_KEY: 'key', BROLL_SEARCH_PROVIDER: 'pexels' },
    }).provider,
    'pexels',
  );
  assert.throws(
    () =>
      loadBrollConfig({
        env: {
          PEXELS_API_KEY: 'key',
          BROLL_SEARCH_PROVIDER: 'secret-unsupported',
        },
      }),
    {
      code: 'BROLL_PROVIDER_UNSUPPORTED',
      message: 'BROLL_PROVIDER_UNSUPPORTED',
    },
  );
});
test('dotenv provider is validated even with environment key and can be overridden', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'broll-provider-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, '.env'),
    'BROLL_SEARCH_PROVIDER=unsupported\nPEXELS_API_KEY=local\n',
  );
  assert.throws(
    () => loadBrollConfig({ root, env: { PEXELS_API_KEY: 'environment' } }),
    { code: 'BROLL_PROVIDER_UNSUPPORTED' },
  );
  assert.deepEqual(
    loadBrollConfig({
      root,
      env: { PEXELS_API_KEY: 'environment', BROLL_SEARCH_PROVIDER: 'pexels' },
    }),
    { provider: 'pexels', apiKey: 'environment' },
  );
});
