const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPexelsProvider } = require('../scripts/broll/pexels');
const photo = {
  id: 1,
  width: 1920,
  height: 1080,
  url: 'https://www.pexels.com/photo/cat-1/',
  photographer: 'Author',
  photographer_url: 'https://www.pexels.com/@author',
  src: {
    original: 'https://images.pexels.com/photos/1/full.jpg',
    tiny: 'https://images.pexels.com/photos/1/tiny.jpg',
    medium: 'https://images.pexels.com/photos/1/medium.jpg',
  },
};
const video = {
  id: 2,
  width: 1920,
  height: 1080,
  duration: 10,
  url: 'https://www.pexels.com/video/cat-2/',
  user: { name: 'Author', url: photo.photographer_url },
  image: photo.src.tiny,
  video_files: [
    {
      id: 21,
      width: 1920,
      height: 1080,
      file_type: 'video/mp4',
      link: 'https://videos.pexels.com/video-files/2/full.mp4',
    },
    {
      id: 22,
      width: 640,
      height: 360,
      file_type: 'video/mp4',
      link: 'https://player.vimeo.com/external/2.sd.mp4',
    },
  ],
};
const search = {
  queryOriginal: 'кот',
  queryEnglish: 'cat',
  mediaKind: 'image',
  orientation: 'landscape',
  minWidth: 1000,
};
test('missing key and upstream secret errors sanitized', async () => {
  await assert.rejects(createPexelsProvider({}).search(search), {
    code: 'BROLL_KEY_MISSING',
  });
  await assert.rejects(
    createPexelsProvider({
      apiKey: 'secret',
      request: async () => {
        throw new Error('secret');
      },
    }).search(search),
    (e) => e.message === 'BROLL_PROVIDER_FAILED',
  );
});
test('official photo path, bounded JSON, normalization dedupe filter pagination', async () => {
  const provider = createPexelsProvider({
    apiKey: 'secret',
    request: async (options) => {
      const url = new URL(options.url);
      assert.equal(url.pathname, '/v1/search');
      assert.equal(url.searchParams.get('per_page'), '12');
      assert.equal(options.maxBytes, 2097152);
      return {
        bytes: Buffer.from(
          JSON.stringify({
            photos: [
              photo,
              photo,
              { ...photo, id: 3, width: 30 },
              { ...photo, id: 4, url: 'https://evil.test/a' },
            ],
            next_page: 'https://evil.test/secret',
          }),
        ),
      };
    },
  });
  const result = await provider.search(search);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.nextPage, null);
  assert.equal(result.candidates[0].queryOriginal, 'кот');
});
test('video documented path, rendition filtering and distinct SD preview', async () => {
  const provider = createPexelsProvider({
    apiKey: 'key',
    request: async (o) => {
      assert.equal(new URL(o.url).pathname, '/v1/videos/search');
      return {
        bytes: Buffer.from(
          JSON.stringify({
            videos: [video],
            next_page: 'https://api.pexels.com/v1/videos/search?page=2',
          }),
        ),
      };
    },
  });
  const result = await provider.search({
    ...search,
    mediaKind: 'video',
    minDurationSec: 9,
  });
  assert.equal(result.candidates[0].width, 1920);
  assert.equal(result.candidates[0].previewUrl, video.video_files[1].link);
  assert.equal(result.nextPage, 2);
  assert.equal(
    (
      await provider.search({
        ...search,
        mediaKind: 'video',
        minDurationSec: 11,
      })
    ).candidates.length,
    0,
  );
});
test('video never previews full-only rendition and rejects hostile media', async () => {
  const request = async () => ({
    bytes: Buffer.from(
      JSON.stringify({
        videos: [
          { ...video, video_files: [video.video_files[0]] },
          {
            ...video,
            id: 3,
            video_files: [
              {
                ...video.video_files[0],
                link: 'https://127.0.0.1/private.mp4',
              },
            ],
          },
        ],
      }),
    ),
  });
  const { candidates } = await createPexelsProvider({
    apiKey: 'key',
    request,
  }).search({ ...search, mediaKind: 'video' });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].previewUrl, null);
});
test('successful provider payload cannot echo key through metadata', async () => {
  const secret = 'do-not-echo-secret';
  const provider = createPexelsProvider({
    apiKey: secret,
    request: async () => ({
      bytes: Buffer.from(
        JSON.stringify({ photos: [{ ...photo, photographer: secret }] }),
      ),
    }),
  });
  assert.deepEqual((await provider.search(search)).candidates, []);
});

const { validateProvenance } = require('../scripts/broll/provenance');
function provenanceOf(candidate) {
  const keys = ['provider', 'providerAssetId', 'sourcePage', 'author', 'license',
    'queryOriginal', 'queryEnglish', 'retrievedAt', 'rendition'];
  return Object.fromEntries(keys.map(key => [key, candidate[key]]));
}
function fixtureProvider(override = {}) {
  return createPexelsProvider({apiKey: 'fixture-api-secret', request: async () => ({
    bytes: Buffer.from(JSON.stringify({photos: [{...photo, ...override}]})),
  })});
}
test('provider emits NFKC Unicode metadata accepted by provenance contract', async () => {
  const { candidates } = await fixtureProvider({photographer: ' Jose\u0301 '}).search({
    ...search, queryOriginal: ' Cafe\u0301 ', queryEnglish: ' Ｃａｆｅ ',
  });
  assert.equal(candidates.length, 1);
  const provenance = validateProvenance(provenanceOf(candidates[0]));
  assert.equal(provenance.author.name, 'José');
  assert.equal(provenance.queryOriginal, 'Café');
  assert.equal(provenance.queryEnglish, 'Cafe');
});
test('provider text UTF8 byte boundaries match immutable provenance', async () => {
  const {candidates} = await fixtureProvider({photographer: 'é'.repeat(150)}).search({
    ...search, queryOriginal: 'é'.repeat(250), queryEnglish: 'é'.repeat(100),
  });
  assert.equal(candidates.length, 1);
  assert.doesNotThrow(() => validateProvenance(provenanceOf(candidates[0])));
  assert.equal((await fixtureProvider({photographer:'é'.repeat(150)+'a'}).search(search)).candidates.length, 0);
  for (const field of ['queryOriginal', 'queryEnglish']) {
    const value = 'é'.repeat(field === 'queryOriginal' ? 250 : 100) + 'a';
    await assert.rejects(fixtureProvider().search({...search,[field]:value}),{code:'BROLL_SEARCH_INVALID'});
  }
});
test('provider rejects Unicode control/format characters in text and raw URLs', async () => {
  for (const control of ['\u0000', '\n', '\t', '\u200b', '\u202e']) {
    await assert.rejects(fixtureProvider().search({...search,queryEnglish:`cat${control}`}),{code:'BROLL_SEARCH_INVALID'});
    assert.equal((await fixtureProvider({photographer:`Author${control}`}).search(search)).candidates.length, 0);
    assert.equal((await fixtureProvider({url:`https://www.pexels.com/photo/${control}cat-1/`}).search(search)).candidates.length, 0);
  }
});
test('provider canonical URL byte boundaries match provenance contract', async () => {
  const prefix = 'https://www.pexels.com/photo/';
  const url = prefix + 'a'.repeat(500 - prefix.length);
  const {candidates} = await fixtureProvider({url}).search(search);
  assert.equal(candidates.length, 1);
  assert.doesNotThrow(() => validateProvenance(provenanceOf(candidates[0])));
  assert.equal((await fixtureProvider({url:url+'a'}).search(search)).candidates.length, 0);
});
test('URL cap is checked after canonical percent encoding', async () => {
  const prefix = 'https://www.pexels.com/photo/';
  const url = prefix + 'é'.repeat(70);
  assert.ok(Buffer.byteLength(url) < 500);
  assert.ok(new URL(url).href.length < 500);
  const {candidates} = await fixtureProvider({url}).search(search);
  assert.equal(candidates.length, 1);
  assert.doesNotThrow(() => validateProvenance(provenanceOf(candidates[0])));
  const oversized = prefix + 'é'.repeat(80);
  assert.ok(Buffer.byteLength(oversized) < 500);
  assert.ok(new URL(oversized).href.length > 500);
  assert.equal((await fixtureProvider({url:oversized}).search(search)).candidates.length, 0);
});
