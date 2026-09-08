const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCandidateStore } = require('../scripts/broll/candidates');
const candidate = {
  provider: 'pexels',
  providerAssetId: '1',
  mediaKind: 'image',
  width: 100,
  height: 50,
  author: { name: 'A', url: 'https://www.pexels.com/@a', key: 'secret' },
  license: { name: 'Pexels', url: 'https://www.pexels.com/license/' },
  thumbnailUrl: 'https://images.pexels.com/a?secret',
  previewUrl: null,
  downloadUrl: 'https://images.pexels.com/full?secret',
  raw: 'secret',
};
test('opaque IDs, explicit browser allowlist and cross-session rejection', () => {
  const store = createCandidateStore();
  const {
    searchId,
    candidates: [card],
  } = store.replace({
    sceneIndex: 0,
    query: { queryEnglish: 'cat' },
    candidates: [candidate],
  });
  assert.equal(JSON.stringify(card).includes('secret'), false);
  assert.match(card.thumbnailUrl, /^\/media\/broll-candidate\//);
  assert.equal(
    store.get({ candidateId: card.id, searchId, sceneIndex: 0 }).downloadUrl,
    candidate.downloadUrl,
  );
  assert.equal(
    createCandidateStore().get({
      candidateId: card.id,
      searchId,
      sceneIndex: 0,
    }),
    null,
  );
  assert.equal(
    store.get({ candidateId: card.id, searchId, sceneIndex: 1 }),
    null,
  );
  assert.equal(
    store.get({ candidateId: card.id, searchId: 'wrong', sceneIndex: 0 }),
    null,
  );
});
test('expiry, replacement, reject, clear and capacity', () => {
  let time = 0;
  const store = createCandidateStore({
    now: () => time,
    ttlMs: 10,
    maxEntries: 2,
  });
  const add = (sceneIndex) =>
    store.replace({ sceneIndex, query: {}, candidates: [candidate] });
  let a = add(0);
  const ref = (x) => ({
    candidateId: x.candidates[0].id,
    searchId: x.searchId,
    sceneIndex: 0,
  });
  add(0);
  assert.equal(store.get(ref(a)), null);
  a = add(0);
  time = 10;
  assert.equal(store.get(ref(a)), null);
  a = add(0);
  assert.equal(store.reject(ref(a)), true);
  assert.equal(store.get(ref(a)), null);
  a = add(0);
  add(1);
  add(2);
  assert.equal(store.get(ref(a)), null);
  store.clear();
});
