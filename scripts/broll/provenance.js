'use strict';

const { isDeepStrictEqual } = require('node:util');

const CONTROL = /[\p{Cc}\p{Cf}]/u;
const MIME = /^(?:image\/(?:jpeg|png|webp)|video\/mp4)$/;
const KEYS = [
  'provider', 'providerAssetId', 'sourcePage', 'author', 'license',
  'queryOriginal', 'queryEnglish', 'retrievedAt', 'rendition',
];

function safeText(value, maxBytes) {
  return typeof value === 'string' && value.length > 0
    && value === value.normalize('NFKC') && !CONTROL.test(value)
    && Buffer.byteLength(value, 'utf8') <= maxBytes;
}

function safeHttpsUrl(value) {
  if (!safeText(value, 500)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port
      && !url.hash && url.href === value;
  } catch (_) {
    return false;
  }
}

function exactObject(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());
}

function validateProvenance(value) {
  const keys = value && Object.hasOwn(value, 'semanticDescription')
    ? [...KEYS, 'semanticDescription'] : KEYS;
  if (!exactObject(value, keys)
    || !safeText(value.provider, 64) || !/^[a-z0-9][a-z0-9-]*$/.test(value.provider)
    || !safeText(value.providerAssetId, 200)
    || !safeHttpsUrl(value.sourcePage)
    || !exactObject(value.author, ['name', 'url'])
    || !safeText(value.author.name, 300) || !safeHttpsUrl(value.author.url)
    || !exactObject(value.license, ['name', 'url'])
    || !safeText(value.license.name, 300) || !safeHttpsUrl(value.license.url)
    || !safeText(value.queryOriginal, 500) || !safeText(value.queryEnglish, 200)
    || (Object.hasOwn(value, 'semanticDescription')
      && !safeText(value.semanticDescription, 1000))
    || typeof value.retrievedAt !== 'string'
    || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.retrievedAt)
    || Number.isNaN(Date.parse(value.retrievedAt))
    || !exactObject(value.rendition, ['id', 'width', 'height', 'mimeType'])
    || !safeText(value.rendition.id, 200)
    || !Number.isSafeInteger(value.rendition.width) || value.rendition.width <= 0
    || value.rendition.width > 32768
    || !Number.isSafeInteger(value.rendition.height) || value.rendition.height <= 0
    || value.rendition.height > 32768 || !MIME.test(value.rendition.mimeType)) {
    throw new Error('broll provenance is invalid');
  }
  return structuredClone(value);
}

function browserProvenance(value) {
  const provenance = validateProvenance(value);
  return {
    provider: provenance.provider,
    providerAssetId: provenance.providerAssetId,
    sourcePage: provenance.sourcePage,
    author: { name: provenance.author.name, url: provenance.author.url },
    license: { name: provenance.license.name, url: provenance.license.url },
    queryOriginal: provenance.queryOriginal,
    queryEnglish: provenance.queryEnglish,
    ...(provenance.semanticDescription
      ? { semanticDescription: provenance.semanticDescription } : {}),
    retrievedAt: provenance.retrievedAt,
    rendition: { ...provenance.rendition },
  };
}

module.exports = { browserProvenance, validateProvenance };
