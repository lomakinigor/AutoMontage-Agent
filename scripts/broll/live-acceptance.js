#!/usr/bin/env node
'use strict';
const path = require('node:path');
const { Readable } = require('node:stream');
const { loadBrollConfig } = require('./config');
const { createPexelsProvider, IMAGE_HOSTS, VIDEO_HOSTS } = require('./pexels');
const { requestRemote, LIMITS, failure } = require('./remote');
async function main(args = process.argv.slice(2)) {
  let config;
  try {
    config = loadBrollConfig({ root: path.resolve(__dirname, '../..') });
  } catch (error) {
    if (error.code === 'BROLL_KEY_MISSING') {
      console.log('SKIPPED: PEXELS_API_KEY is not configured');
      return;
    }
    throw error;
  }
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (
      !['--query', '--select', '--project-dir'].includes(args[i]) ||
      !args[i + 1]
    )
      throw failure('BROLL_LIVE_ARGUMENTS_INVALID');
    options[args[i]] = args[i + 1];
  }
  if (
    Boolean(options['--select']) !== Boolean(options['--project-dir']) ||
    (options['--select'] &&
      !/^(image|video):[1-9][0-9]*$/.test(options['--select']))
  )
    throw failure('BROLL_LIVE_ARGUMENTS_INVALID');
  const provider = createPexelsProvider(config),
    found = [];
  for (const mediaKind of ['image', 'video']) {
    const query = options['--query'] || 'nature';
    const { candidates } = await provider.search({
      queryOriginal: query,
      queryEnglish: query,
      mediaKind,
    });
    found.push(...candidates);
    console.log(
      `${mediaKind}: ${candidates.length} candidates; IDs ${candidates.map((c) => c.providerAssetId).join(',')}`,
    );
    const card = candidates[0];
    if (card) {
      await requestRemote({
        url: card.thumbnailUrl,
        allowedHosts: IMAGE_HOSTS,
        maxBytes: LIMITS.thumbnail,
        expectedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
      });
      if (card.previewUrl)
        await requestRemote({
          url: card.previewUrl,
          allowedHosts: mediaKind === 'video' ? VIDEO_HOSTS : IMAGE_HOSTS,
          maxBytes: LIMITS.preview,
          expectedMimeTypes:
            mediaKind === 'video'
              ? ['video/mp4']
              : ['image/jpeg', 'image/png', 'image/webp'],
        });
    }
  }
  if (!options['--select']) {
    console.log('SEARCH/PROXY PASSED; selection not requested');
    return;
  }
  const candidate = found.find(
    (c) => `${c.mediaKind}:${c.providerAssetId}` === options['--select'],
  );
  if (!candidate) throw failure('BROLL_LIVE_FIXTURE_NOT_FOUND');
  const response = await requestRemote({
    url: candidate.downloadUrl,
    allowedHosts: candidate.mediaKind === 'video' ? VIDEO_HOSTS : IMAGE_HOSTS,
    maxBytes: LIMITS[candidate.mediaKind],
    timeoutMs: 120000,
    expectedMimeTypes: [candidate.rendition.mimeType],
  });
  const {
    importReviewMedia,
    createImportController,
  } = require('../review/media-import');
  const { runMediaProcess } = require('../review/media-process');
  const filename = `pexels-${candidate.providerAssetId}${path.extname(new URL(candidate.downloadUrl).pathname)}`;
  await importReviewMedia({
    request: Readable.from([response.bytes]),
    projectDir: path.resolve(options['--project-dir']),
    outputFps: 30,
    headers: {
      'content-type': response.contentType,
      'content-length': String(response.bytes.length),
      'x-automontage-filename': filename,
    },
    controller: createImportController(),
    runMediaProcessImpl: runMediaProcess,
  });
  console.log(
    'SELECTED FIXTURE IMPORT PASSED; no brief approval or final render performed',
  );
}
if (require.main === module)
  main().catch(() => {
    console.error('BROLL_LIVE_FAILED');
    process.exitCode = 1;
  });
module.exports = { main };
