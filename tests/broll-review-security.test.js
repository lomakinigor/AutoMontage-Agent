'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { makeReviewProject } = require('./helpers/review-project');
const { startReviewServer } = require('../scripts/review/server');
const { readProjectManifest } = require('../scripts/project/workspace');
const ROOT = path.resolve(__dirname, '..');
async function fixture(t, options = {}) {
  const f = makeReviewProject(t);
  const brief = JSON.parse(fs.readFileSync(f.briefPath));
  brief.scenes[1] = {
    scene: 'broll',
    start: 2,
    end: 4,
    headCream: 'ГОРОД',
    headOrange: 'УТРО',
    brollIntent: {
      goal: 'Показать город',
      sourceText: 'город',
      queryOriginal: 'город',
      queryEnglish: 'city',
    },
  };
  brief.brollReviewPolicy = 'preview-required';
  fs.writeFileSync(f.briefPath, JSON.stringify(brief));
  const image = path.join(f.root, 'photo.jpg');
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=blue:s=320x240',
    '-frames:v',
    '1',
    '-threads',
    '1',
    image,
  ]);
  const bytes = fs.readFileSync(image);
  const counts = { api: 0, thumbnail: 0, full: 0 };
  let unblock = null;
  const candidate = {
    provider: 'pexels',
    providerAssetId: '123',
    sourcePage: 'https://www.pexels.com/photo/example-123/',
    author: { name: 'Jane', url: 'https://www.pexels.com/@jane/' },
    license: { name: 'Pexels License', url: 'https://www.pexels.com/license/' },
    queryOriginal: 'город',
    queryEnglish: 'city',
    retrievedAt: '2026-09-08T00:00:00.000Z',
    rendition: {
      id: 'original',
      width: 320,
      height: 240,
      mimeType: 'image/jpeg',
    },
    mediaKind: 'image',
    width: 320,
    height: 240,
    durationSec: null,
    hasAudio: null,
    thumbnailUrl: 'https://images.pexels.com/thumbnail.jpg',
    previewUrl: null,
    downloadUrl: 'https://images.pexels.com/full.jpg',
  };
  const upstream = http.createServer(async (req, res) => {
    if (req.url === '/api') {
      counts.api++;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ candidates: [candidate], nextPage: null }));
    } else {
      const kind = req.url.includes('full') ? 'full' : 'thumbnail';
      counts[kind]++;
      if (options.delayFull && kind === 'full')
        await new Promise((r) => {
          unblock = r;
        });
      res.setHeader('Content-Type', 'image/jpeg');
      res.end(bytes);
    }
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => upstream.close(r)));
  const remote = `http://127.0.0.1:${upstream.address().port}`;
  const session = await startReviewServer({
    root: ROOT,
    projectDir: f.projectDir,
    editable: options.editable ?? true,
    open: false,
    runToolImpl: () => ({ status: 1 }),
    brollProvider: {
      search: async () => {
        if (options.providerError) throw new Error('key-private-123');
        return (await fetch(`${remote}/api`)).json();
      },
    },
    brollDownload: async ({ url, signal }) => {
      const res = await fetch(`${remote}${new URL(url).pathname}`, { signal });
      return {
        bytes: Buffer.from(await res.arrayBuffer()),
        contentType: res.headers.get('content-type'),
      };
    },
    ...options.server,
  });
  t.after(() => new Promise((r) => session.server.close(r)));
  async function request(route, body, opts = {}) {
    const response = await fetch(`${session.origin}${route}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${session.token}`,
        ...(body
          ? { Origin: session.origin, 'Content-Type': 'application/json' }
          : {}),
        ...opts.headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const raw = await response.text();
    let json;
    try {
      json = JSON.parse(raw);
    } catch {}
    return {
      status: response.status,
      body: json,
      raw,
      headers: response.headers,
    };
  }
  const state = (await request('/api/state')).body;
  const { editable, ...base } = state.session;
  const query = {
    ...base,
    sceneIndex: 1,
    queryOriginal: 'город',
    queryEnglish: 'city',
    mediaKind: 'image',
  };
  return {
    ...f,
    session,
    request,
    query,
    base,
    counts,
    unblock: () => unblock?.(),
    hasBlocked: () => Boolean(unblock),
  };
}
test('real HTTP discovery: shelf/proxy have no full download; selected file imports and saves immutable draft', async (t) => {
  const f = await fixture(t);
  const original = fs.readFileSync(f.briefPath);
  const shelf = await f.request('/api/broll/search', f.query);
  assert.equal(shelf.status, 200, shelf.raw);
  assert.equal(f.counts.full, 0);
  const card = shelf.body.candidates[0];
  const proxy = await f.request(card.thumbnailUrl);
  assert.equal(proxy.status, 200, proxy.raw);
  const ranged = await f.request(card.thumbnailUrl, undefined, {
    headers: { Range: 'bytes=0-3' },
  });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get('content-length'), '4');
  assert.equal(f.counts.full, 0);
  const selected = await f.request('/api/broll/select', {
    ...f.base,
    sceneIndex: 1,
    searchId: shelf.body.searchId,
    candidateId: card.id,
  });
  assert.equal(selected.status, 201, selected.raw);
  assert.equal(f.counts.full, 1);
  assert.match(selected.body.assetId, /^asset-/);
  assert.equal(
    JSON.stringify(selected.body).includes('canonicalSha256'),
    false,
  );
  assert.equal(JSON.stringify(selected.body).includes('scanSha256'), false);
  const asset = selected.body.state.assets.find(
    (a) => a.id === selected.body.assetId,
  );
  assert.equal(asset.provenance.provider, 'pexels');
  assert.ok(asset.textScan);
  const save = await f.request('/api/save', {
    ...f.base,
    commands: [
      { type: 'replace-broll', sceneIndex: 1, assetId: selected.body.assetId },
      { type: 'allow-broll-text', sceneIndex: 1, allowEmbeddedText: true },
    ],
  });
  assert.equal(save.status, 201, save.raw);
  assert.deepEqual(fs.readFileSync(f.briefPath), original);
  const manifest = readProjectManifest(f.projectDir);
  const saved = JSON.parse(
    fs.readFileSync(path.join(f.projectDir, manifest.currentBrief)),
  );
  assert.equal(saved.status, 'draft');
  assert.equal(saved.brollReviewPolicy, 'preview-required');
  assert.equal(
    saved.scenes[1].brollReview.assetSha256,
    saved.scenes[1].brollMedia.sha256,
  );
  assert.match(saved.scenes[1].brollReview.scanSha256, /^[a-f0-9]{64}$/);
  const state = await f.request('/api/state');
  assert.equal(state.body.brief.scenes[1].brollReview, true);
  assert.equal(
    state.raw.includes(saved.scenes[1].brollReview.scanSha256),
    false,
  );
});
test('routes reject read-only, wrong token/origin/host, client URLs, wrong scene and candidate IDs', async (t) => {
  const f = await fixture(t);
  assert.equal(
    (
      await f.request('/api/broll/search', f.query, {
        headers: { Authorization: 'Bearer wrong' },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await f.request('/api/broll/search', f.query, {
        headers: { Origin: 'https://evil.test' },
      })
    ).status,
    403,
  );
  const hostileHost = await new Promise((resolve) => {
    const req = http.request(
      `${f.session.origin}/api/broll/search`,
      {
        method: 'POST',
        headers: {
          Host: 'evil.test',
          Authorization: `Bearer ${f.session.token}`,
          Origin: f.session.origin,
        },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.end();
  });
  assert.equal(hostileHost, 403);
  assert.equal(
    (
      await f.request('/api/broll/search', {
        ...f.query,
        url: 'http://127.0.0.1',
      })
    ).status,
    400,
  );
  const shelf = (await f.request('/api/broll/search', f.query)).body;
  assert.equal(
    (
      await f.request('/api/broll/select', {
        ...f.base,
        sceneIndex: 0,
        searchId: shelf.searchId,
        candidateId: shelf.candidates[0].id,
      })
    ).status,
    400,
  );
  assert.equal(
    (await f.request('/media/broll-candidate/aaaaaaaaaaaaaaaa/thumbnail'))
      .status,
    404,
  );
  const ro = await fixture(t, { editable: false });
  assert.equal((await ro.request('/api/broll/search', ro.query)).status, 405);
  assert.equal(
    (await ro.request(shelf.candidates[0].thumbnailUrl)).status,
    405,
  );
  const other = await fixture(t);
  assert.equal(
    (await other.request(shelf.candidates[0].thumbnailUrl)).status,
    404,
  );
});
test('upstream failures use fixed messages; pending download blocks save and changed base prevents import', async (t) => {
  const bad = await fixture(t, { providerError: true });
  const failed = await bad.request('/api/broll/search', bad.query);
  assert.equal(failed.status, 502);
  assert.equal(failed.raw.includes('private'), false);
  const f = await fixture(t, { delayFull: true });
  const shelf = (await f.request('/api/broll/search', f.query)).body;
  const pending = f.request('/api/broll/select', {
    ...f.base,
    sceneIndex: 1,
    searchId: shelf.searchId,
    candidateId: shelf.candidates[0].id,
  });
  while (!f.hasBlocked()) await new Promise((r) => setTimeout(r, 10));
  assert.equal(
    (await f.request('/api/save', { ...f.base, commands: [] })).status,
    409,
  );
  const brief = JSON.parse(fs.readFileSync(f.briefPath));
  brief.title = 'Changed';
  fs.writeFileSync(f.briefPath, JSON.stringify(brief));
  f.unblock();
  const result = await pending;
  assert.equal(result.status, 409, result.raw);
  assert.equal(result.body.error, 'STALE_REVIEW_BASE');
  assert.equal(
    fs.existsSync(path.join(f.projectDir, 'assets/broll/images')),
    false,
  );
});
test('actual import lease excludes Save and approval until canonical OCR publication completes', async (t) => {
  const { importReviewMedia } = require('../scripts/review/media-import');
  const { approveBrief } = require('../scripts/project/workspace');
  let unblock,
    started = false;
  const f = await fixture(t, {
    server: {
      importMediaImpl: (options) =>
        importReviewMedia({
          ...options,
          scanEmbeddedTextImpl: async () => {
            started = true;
            await new Promise((r) => {
              unblock = r;
            });
            return {
              status: 'unavailable',
              text: '',
              reasons: ['ocr-unavailable'],
              engine: 'tesseract',
            };
          },
        }),
    },
  });
  const shelf = (await f.request('/api/broll/search', f.query)).body;
  const pending = f.request('/api/broll/select', {
    ...f.base,
    sceneIndex: 1,
    searchId: shelf.searchId,
    candidateId: shelf.candidates[0].id,
  });
  while (!started) await new Promise((r) => setTimeout(r, 10));
  assert.equal(
    (await f.request('/api/save', { ...f.base, commands: [] })).status,
    409,
  );
  assert.throws(() => approveBrief(f.workspace, f.briefPath), {
    code: 'PROJECT_MANIFEST_CONFLICT',
  });
  unblock();
  assert.equal((await pending).status, 201);
});

test('changed scan after browser display cannot be acknowledged against unseen evidence', async (t) => {
  const f = await fixture(t);
  const shelf = (await f.request('/api/broll/search', f.query)).body;
  const selection = await f.request('/api/broll/select', {
    ...f.base,
    sceneIndex: 1,
    searchId: shelf.searchId,
    candidateId: shelf.candidates[0].id,
  });
  assert.equal(selection.status, 201);
  const directory = path.join(f.projectDir, 'assets/broll/images');
  const metadataPath = path.join(
    directory,
    fs.readdirSync(directory).find((name) => !name.startsWith('.')),
    'asset.json',
  );
  const metadata = JSON.parse(fs.readFileSync(metadataPath));
  metadata.textScan = {
    status: 'needs-review',
    text: 'CHANGED BRAND',
    reasons: ['embedded-text-detected'],
    engine: 'tesseract',
  };
  fs.writeFileSync(metadataPath, JSON.stringify(metadata));
  const saved = await f.request('/api/save', {
    ...f.base,
    commands: [
      { type: 'replace-broll', sceneIndex: 1, assetId: selection.body.assetId },
      { type: 'allow-broll-text', sceneIndex: 1, allowEmbeddedText: true },
    ],
  });
  assert.ok([409, 422].includes(saved.status), saved.raw);
  assert.equal(readProjectManifest(f.projectDir).briefs.length, 1);
});

test('replacing search while OCR is in progress cancels stale import before publication', async (t) => {
  const { importReviewMedia } = require('../scripts/review/media-import');
  let unblock,
    started = false;
  const f = await fixture(t, {
    server: {
      importMediaImpl: (options) =>
        importReviewMedia({
          ...options,
          scanEmbeddedTextImpl: async () => {
            started = true;
            await new Promise((resolve) => {
              unblock = resolve;
            });
            return {
              status: 'clear',
              text: '',
              reasons: [],
              engine: 'tesseract',
            };
          },
        }),
    },
  });
  const shelf = (await f.request('/api/broll/search', f.query)).body;
  const pending = f.request('/api/broll/select', {
    ...f.base,
    sceneIndex: 1,
    searchId: shelf.searchId,
    candidateId: shelf.candidates[0].id,
  });
  while (!started) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal((await f.request('/api/broll/search', f.query)).status, 200);
  unblock();
  assert.equal((await pending).status, 409);
  const images = path.join(f.projectDir, 'assets/broll/images');
  assert.equal(
    fs.existsSync(images)
      ? fs.readdirSync(images).filter((name) => !name.startsWith('.')).length
      : 0,
    0,
  );
});
