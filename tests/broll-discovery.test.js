'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBrollDiscovery } = require('../scripts/review/broll-discovery');
const snapshot = {
  baseRevision: 1,
  baseHash: 'a'.repeat(64),
  manifestHash: 'b'.repeat(64),
};
const query = {
  ...snapshot,
  sceneIndex: 0,
  queryOriginal: 'город',
  queryEnglish: 'city',
  mediaKind: 'image',
};
const candidate = {
  provider: 'pexels',
  providerAssetId: '1',
  sourcePage: 'https://www.pexels.com/photo/city-1/',
  author: { name: 'Author', url: 'https://www.pexels.com/@author/' },
  license: { name: 'Pexels License', url: 'https://www.pexels.com/license/' },
  queryOriginal: 'город',
  queryEnglish: 'city',
  retrievedAt: '2026-09-08T00:00:00.000Z',
  rendition: {
    id: 'original',
    width: 1200,
    height: 800,
    mimeType: 'image/jpeg',
  },
  mediaKind: 'image',
  width: 1200,
  height: 800,
  durationSec: null,
  hasAudio: false,
  thumbnailUrl: 'https://images.pexels.com/tiny.jpg',
  previewUrl: 'https://images.pexels.com/medium.jpg',
  downloadUrl: 'https://images.pexels.com/full.jpg',
};
function fixture(overrides = {}) {
  const calls = [];
  let current = { ...snapshot };
  const discovery = createBrollDiscovery({
    provider: {
      search: async () => ({ candidates: [candidate], nextPage: null }),
    },
    getSnapshot: () => ({ ...current, scenes: [{ scene: 'broll' }] }),
    download: async ({ url }) => {
      calls.push(url);
      return {
        bytes: Buffer.from('ffd8ffe0', 'hex'),
        contentType: 'image/jpeg',
      };
    },
    probeProxy: async () => ({ codec_name: 'mjpeg', width: 320, height: 240 }),
    importMedia: async (options) => {
      let bytes = 0;
      for await (const chunk of options.request) bytes += chunk.length;
      assert.equal(bytes, 4);
      assert.equal(options.headers['content-length'], '4');
      assert.equal(options.provenance.provider, 'pexels');
      assert.equal(options.provenance.downloadUrl, undefined);
      return { id: 'imported' };
    },
    registerAsset: () => ({ assetId: 'asset-1', state: {} }),
    ...overrides,
  });
  return {
    discovery,
    calls,
    change: () => {
      current = { ...current, baseRevision: 2 };
    },
  };
}
test('search/proxy never download full; selection streams exactly selected bytes with provenance', async () => {
  const { discovery, calls } = fixture();
  const shelf = await discovery.search(query);
  assert.equal(calls.length, 0);
  const card = shelf.candidates[0];
  assert.equal(JSON.stringify(shelf).includes('images.pexels.com'), false);
  await discovery.proxy(card.id, 'thumbnail');
  assert.deepEqual(calls, [candidate.thumbnailUrl]);
  assert.equal(
    (
      await discovery.select({
        ...snapshot,
        sceneIndex: 0,
        searchId: shelf.searchId,
        candidateId: card.id,
      })
    ).assetId,
    'asset-1',
  );
  assert.deepEqual(calls, [candidate.thumbnailUrl, candidate.downloadUrl]);
});
test('invalid IDs, extra client URL, stale snapshots and replaced generations fail closed', async () => {
  const f = fixture();
  await assert.rejects(
    f.discovery.search({ ...query, url: 'https://evil.test' }),
    { code: 'BROLL_REQUEST_INVALID' },
  );
  const shelf = await f.discovery.search(query);
  const select = {
    ...snapshot,
    sceneIndex: 0,
    searchId: shelf.searchId,
    candidateId: shelf.candidates[0].id,
  };
  await assert.rejects(f.discovery.select({ ...select, candidateId: 'fake' }));
  await f.discovery.search(query);
  await assert.rejects(f.discovery.select(select), {
    code: 'BROLL_CANDIDATE_UNAVAILABLE',
  });
  f.change();
  await assert.rejects(f.discovery.search(query), {
    code: 'STALE_REVIEW_BASE',
  });
});
test('late search completion cannot replace a newer generation and errors never leak upstream text', async () => {
  let finish;
  let count = 0;
  const f = fixture({
    provider: {
      search: async () => {
        if (++count === 1)
          await new Promise((r) => {
            finish = r;
          });
        return { candidates: [candidate] };
      },
    },
  });
  const old = f.discovery.search(query);
  await new Promise((r) => setImmediate(r));
  await f.discovery.search(query);
  finish();
  await assert.rejects(old, { code: 'BROLL_SEARCH_STALE' });
  const bad = fixture({
    provider: {
      search: async () => {
        throw new Error('secret-KEY');
      },
    },
  });
  await assert.rejects(
    bad.discovery.search(query),
    (e) => e.code === 'BROLL_PROVIDER_FAILED' && !e.message.includes('secret'),
  );
});
test('stale download cannot reach importer; close cancels active I/O', async () => {
  let finish;
  const f = fixture({
    download: async () => {
      await new Promise((r) => {
        finish = r;
      });
      return { bytes: Buffer.from('ffd8ffe0', 'hex') };
    },
    importMedia: () => assert.fail('must not import'),
  });
  const shelf = await f.discovery.search(query);
  const pending = f.discovery.select({
    ...snapshot,
    sceneIndex: 0,
    searchId: shelf.searchId,
    candidateId: shelf.candidates[0].id,
  });
  await new Promise((r) => setImmediate(r));
  f.change();
  finish();
  await assert.rejects(pending, { code: 'STALE_REVIEW_BASE' });
  let signal;
  const g = fixture({
    provider: {
      search: async (input) => {
        signal = input.signal;
        await new Promise((resolve) =>
          signal.addEventListener('abort', resolve),
        );
        throw new Error('abort');
      },
    },
  });
  const active = g.discovery.search(query);
  g.discovery.close();
  await assert.rejects(active);
  assert.equal(signal.aborted, true);
});
test('proxy rejects spoofed actual format and excessive decoded dimensions', async () => {
  for (const response of [
    { bytes: Buffer.from('<html>evil</html>'), contentType: 'image/jpeg' },
    { bytes: Buffer.from('ffd8ffe0', 'hex'), contentType: 'image/jpeg' },
  ]) {
    const f = fixture({
      download: async () => response,
      probeProxy: async () => ({
        codec_name: 'mjpeg',
        width: 90000,
        height: 90000,
      }),
    });
    const shelf = await f.discovery.search(query);
    await assert.rejects(
      f.discovery.proxy(shelf.candidates[0].id, 'thumbnail'),
      { code: 'BROLL_PROXY_INVALID' },
    );
  }
});
test('expired/rejected candidates are unusable; proxy and search concurrency is bounded', async () => {
  const { createCandidateStore } = require('../scripts/broll/candidates');
  let now = 0;
  const f = fixture({
    store: createCandidateStore({ ttlMs: 10, now: () => now }),
  });
  let shelf = await f.discovery.search(query);
  now = 11;
  await assert.rejects(f.discovery.proxy(shelf.candidates[0].id, 'thumbnail'), {
    code: 'BROLL_CANDIDATE_UNAVAILABLE',
  });
  shelf = await f.discovery.search(query);
  f.discovery.reject({
    searchId: shelf.searchId,
    candidateId: shelf.candidates[0].id,
  });
  await assert.rejects(f.discovery.proxy(shelf.candidates[0].id, 'thumbnail'), {
    code: 'BROLL_CANDIDATE_UNAVAILABLE',
  });
  let finish;
  const g = fixture({
    maxConcurrent: 1,
    provider: {
      search: async () => {
        await new Promise((r) => {
          finish = r;
        });
        return { candidates: [candidate] };
      },
    },
  });
  const old = g.discovery.search(query);
  await assert.rejects(g.discovery.search(query), { code: 'BROLL_BUSY' });
  finish();
  assert.equal((await old).candidates.length, 1);
  await g.discovery.waitIdle();
});

test('a twelve-card proxy shelf queues bounded work instead of returning broken-media busy errors', async () => {
  let active = 0,
    peak = 0;
  const f = fixture({
    download: async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return {
        bytes: Buffer.from('ffd8ffe0', 'hex'),
        contentType: 'image/jpeg',
      };
    },
  });
  const shelf = await f.discovery.search(query);
  const results = await Promise.all(
    Array.from({ length: 12 }, () =>
      f.discovery.proxy(shelf.candidates[0].id, 'thumbnail'),
    ),
  );
  assert.equal(results.length, 12);
  assert.ok(peak <= 4);
});

test('proxy queue is bounded and close cancels active and queued requests without starting queued downloads', async () => {
  let downloads = 0;
  const f = fixture({
    maxConcurrent: 1,
    download: ({ signal }) =>
      new Promise((resolve, reject) => {
        downloads++;
        signal.addEventListener('abort', () => reject(new Error('cancelled')), {
          once: true,
        });
      }),
  });
  const shelf = await f.discovery.search(query);
  const pending = Array.from({ length: 26 }, () =>
    f.discovery.proxy(shelf.candidates[0].id, 'thumbnail'),
  );
  const settled = Promise.allSettled(pending);
  f.discovery.close();
  const results = await settled;
  assert.equal(downloads, 1);
  assert.equal(
    results.filter((result) => result.reason?.code === 'BROLL_BUSY').length,
    1,
  );
  assert.equal(
    results.filter((result) => result.reason?.code === 'BROLL_REMOTE_ABORTED')
      .length,
    25,
  );
  await f.discovery.waitIdle();
});
test('rejecting one candidate does not cancel another candidate proxy in the same search', async () => {
  const releases = [];
  const f = fixture({
    provider: {
      search: async () => ({
        candidates: [candidate, { ...candidate, providerAssetId: '2' }],
      }),
    },
    download: ({ signal }) =>
      new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('cancelled')), {
          once: true,
        });
        releases.push(() =>
          resolve({
            bytes: Buffer.from('ffd8ffe0', 'hex'),
            contentType: 'image/jpeg',
          }),
        );
      }),
  });
  const shelf = await f.discovery.search(query);
  const first = f.discovery.proxy(shelf.candidates[0].id, 'thumbnail');
  const second = f.discovery.proxy(shelf.candidates[1].id, 'thumbnail');
  const settled = Promise.allSettled([first, second]);
  f.discovery.reject({
    searchId: shelf.searchId,
    candidateId: shelf.candidates[0].id,
  });
  releases[1]();
  const results = await settled;
  assert.equal(results[0].reason.code, 'BROLL_REMOTE_ABORTED');
  assert.equal(results[1].status, 'fulfilled');
});
