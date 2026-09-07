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
