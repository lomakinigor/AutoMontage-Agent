'use strict';
const { randomBytes } = require('node:crypto');
const { failure } = require('./remote');
const clone = (value) => structuredClone(value);
function browserCard(id, candidate) {
  // Nested objects are allowlisted as well: never spread upstream payloads.
  const card = {
    id,
    provider: candidate.provider,
    providerAssetId: candidate.providerAssetId,
    sourcePage: candidate.sourcePage,
    mediaKind: candidate.mediaKind,
    width: candidate.width,
    height: candidate.height,
    durationSec: candidate.durationSec,
    hasAudio: candidate.hasAudio,
    author: { name: candidate.author?.name, url: candidate.author?.url },
    license: { name: candidate.license?.name, url: candidate.license?.url },
    thumbnailUrl: `/media/broll-candidate/${encodeURIComponent(id)}/thumbnail`,
    previewUrl: candidate.previewUrl
      ? `/media/broll-candidate/${encodeURIComponent(id)}/preview`
      : null,
  };
  return card;
}
function createCandidateStore({
  ttlMs = 600000,
  maxEntries = 120,
  now = Date.now,
  randomId = () => randomBytes(24).toString('hex'),
} = {}) {
  if (
    !Number.isFinite(ttlMs) ||
    ttlMs <= 0 ||
    !Number.isInteger(maxEntries) ||
    maxEntries < 1 ||
    maxEntries > 1000
  )
    throw failure('BROLL_STORE_INVALID');
  const entries = new Map();
  const purge = () => {
    const time = now();
    for (const [id, entry] of entries)
      if (entry.expiresAt <= time) entries.delete(id);
  };
  const newId = () => {
    const id = randomId();
    if (
      typeof id !== 'string' ||
      !/^[A-Za-z0-9_-]{16,128}$/.test(id) ||
      entries.has(id)
    )
      throw failure('BROLL_STORE_INVALID');
    return id;
  };
  return {
    replace({ sceneIndex, query, candidates }) {
      if (
        !Number.isInteger(sceneIndex) ||
        sceneIndex < 0 ||
        !Array.isArray(candidates)
      )
        throw failure('BROLL_STORE_INVALID');
      purge();
      for (const [id, entry] of entries)
        if (entry.sceneIndex === sceneIndex) entries.delete(id);
      const searchId = newId(),
        cards = [];
      for (const candidate of candidates.slice(0, Math.min(12, maxEntries))) {
        const id = newId();
        const entry = {
          candidate: clone(candidate),
          searchId,
          sceneIndex,
          query: clone(query),
          expiresAt: now() + ttlMs,
        };
        entries.set(id, entry);
        cards.push(browserCard(id, entry.candidate));
        while (entries.size > maxEntries)
          entries.delete(entries.keys().next().value);
      }
      return { searchId, candidates: cards };
    },
    get({ candidateId, searchId, sceneIndex }) {
      purge();
      const entry = entries.get(candidateId);
      if (
        !entry ||
        entry.searchId !== searchId ||
        entry.sceneIndex !== sceneIndex
      )
        return null;
      return clone(entry.candidate);
    },
    reject({ candidateId, searchId }) {
      purge();
      const entry = entries.get(candidateId);
      return Boolean(
        entry && entry.searchId === searchId && entries.delete(candidateId),
      );
    },
    clear() {
      entries.clear();
    },
  };
}
module.exports = { createCandidateStore };
