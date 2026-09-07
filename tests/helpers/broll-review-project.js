const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
let previewBytes;
function videoFixture() {
  if (!previewBytes) previewBytes = execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x416b5a:s=320x180:r=25', '-t', '4', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1']);
  return previewBytes;
}

async function mockBrollReview({ editable = true } = {}) {
  const calls = [];
  const state = {
    project: { name: 'Discovery fixture' }, source: { url: '/media/source' },
    output: { width: 1920, height: 1080, fps: 25, durationInFrames: 100 },
    session: { editable, baseRevision: 1, baseHash: 'brief-hash', manifestHash: 'manifest-hash' },
    brief: { title: 'B-roll test', status: 'draft', scenes: [{ scene: 'broll', start: 0, end: 4,
      brollIntent: { goal: 'Показать прогулку', sourceText: 'Мы идём по лесу', queryOriginal: 'лес', queryEnglish: 'forest walk' } }] },
    transcript: { words: [] }, assets: [], timing: { errors: [], warnings: [], suggestions: [] },
  };
  const cards = Array.from({ length: 12 }, (_, i) => ({ id: `candidate_${String(i).padStart(16, '0')}`,
    provider: 'Pexels', sourcePage: 'https://www.pexels.com/video/123/', mediaKind: 'video',
    width: 1920, height: 1080, durationSec: 8, author: { name: i === 0 ? '<img src=x onerror=alert(1)>' : `Author ${i}`, url: 'https://www.pexels.com/@author/' },
    license: { name: 'Pexels License', url: 'https://www.pexels.com/license/' }, previewUrl: 'present',
  }));
  const settings = { failSelect: false, missingKey: false, delay: 0, conflict: false };
  const video = videoFixture();
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const json = (value, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (pathname === '/api/state') return json(state);
    if (pathname === '/media/source' || pathname.endsWith('/preview')) {
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
      if (range) { const start = Number(range[1]); const end = range[2] ? Math.min(Number(range[2]), video.length - 1) : video.length - 1;
        res.writeHead(206, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${video.length}`, 'Content-Length': end - start + 1 }); return res.end(video.subarray(start, end + 1)); }
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': video.length }); return res.end(video);
    }
    if (pathname.endsWith('/thumbnail')) { res.writeHead(200, { 'Content-Type': 'image/svg+xml' }); return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180"><rect width="320" height="180" fill="#416b5a"/><circle cx="235" cy="48" r="22" fill="#e3bc78"/><path d="M0 180 100 30 200 180M110 180 225 65 320 180" fill="#234c43"/></svg>'); }

    if (req.method === 'POST') {
      let body = ''; for await (const chunk of req) body += chunk;
      const data = JSON.parse(body); calls.push({ pathname, data });
      if (settings.delay) await new Promise(resolve => setTimeout(resolve, settings.delay));
      if (pathname.startsWith('/api/broll/') && settings.conflict) return json({ error: 'BROLL_BUSY' }, 409);
      if (pathname === '/api/broll/search') return settings.missingKey ? json({ error: 'BROLL_KEY_MISSING' }, 503) : json({ searchId: 'search-id', candidates: cards.map(c => ({ ...c, mediaKind: data.mediaKind })), nextPage: 2 });
      if (pathname === '/api/broll/reject') return json({ ok: true });
      if (pathname === '/api/broll/select') {
        if (settings.failSelect) return json({ error: 'BROLL_IMPORT_FAILED' }, 422);
        state.assets = [{ id: 'asset-1', label: 'Selected forest', mediaKind: 'image', kind: 'project', url: '/media/assets/asset-1', capabilities: { brollImage: true }, provenance: cards[0], textScan: { status: 'needs-review', text: 'FOREST', reasons: ['recognized-text'], engine: 'tesseract' } }];
        return json({ assetId: 'asset-1', state });
      }
      if (pathname === '/api/validate') return json({ destinationRevision: 2, timing: state.timing, diff: data.commands.map(c => ({ kind: c.type, scene: c.sceneIndex })) });
      if (pathname === '/api/save') { for (const c of data.commands) {
        if (c.type === 'set-broll-query') Object.assign(state.brief.scenes[0].brollIntent, { queryOriginal: c.queryOriginal, queryEnglish: c.queryEnglish });
        if (c.type === 'replace-broll') state.brief.scenes[0].brollMedia = { kind: 'image', assetId: c.assetId, fit: 'cover' };
        if (c.type === 'allow-broll-text') state.brief.scenes[0].brollReview = c.allowEmbeddedText;
      } state.session.baseRevision++; return json({}, 201); }
    }
    const file = path.join(__dirname, '../../review', pathname === '/' ? 'index.html' : path.basename(pathname));
    if (!pathname.startsWith('/media/') && fs.existsSync(file)) { res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html'); return res.end(fs.readFileSync(file)); }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { state, calls, cards, settings, url: `http://127.0.0.1:${server.address().port}/#token=test-token`, close: () => new Promise(resolve => server.close(resolve)) };
}
module.exports = { mockBrollReview };
