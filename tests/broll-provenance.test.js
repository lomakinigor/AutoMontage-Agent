'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { browserProvenance, validateProvenance } = require('../scripts/broll/provenance');

function provenance(overrides = {}) {
  return {
    provider: 'pexels', providerAssetId: '123',
    sourcePage: 'https://www.pexels.com/photo/example-123/',
    author: { name: 'Jane Example', url: 'https://www.pexels.com/@jane/' },
    license: { name: 'Pexels License', url: 'https://www.pexels.com/license/' },
    queryOriginal: 'офис', queryEnglish: 'office',
    retrievedAt: '2026-09-08T12:00:00.000Z',
    rendition: { id: 'original', width: 1200, height: 800, mimeType: 'image/jpeg' },
    ...overrides,
  };
}

test('provenance is exact, cloned, and browser-safe without download URLs', () => {
  const value = provenance({ semanticDescription: 'People in a bright office' });
  assert.deepEqual(validateProvenance(value), value);
  assert.deepEqual(browserProvenance(value), value);
  assert.notEqual(browserProvenance(value), value);
  assert.throws(() => validateProvenance({ ...value, downloadUrl: 'https://example.com/file' }), /invalid/);
});

test('provenance rejects malformed URLs, controls, unknown nested fields, and bad rendition', () => {
  for (const value of [
    provenance({ sourcePage: 'http://www.pexels.com/photo/example-123/' }),
    provenance({ sourcePage: 'https://u:p@www.pexels.com/photo/example-123/' }),
    provenance({ queryOriginal: 'unsafe\nquery' }),
    provenance({ author: { name: 'Jane', url: 'https://www.pexels.com/@jane/', extra: true } }),
    provenance({ rendition: { id: 'x', width: 0, height: 1, mimeType: 'image/jpeg' } }),
  ]) assert.throws(() => validateProvenance(value), /invalid/);
});

module.exports = { provenance };
