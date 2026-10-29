const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { loadMotion, brief } = require('./helpers/motion-render');
const { validateMotionBrief } = require('../scripts/motion/brief');

const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '../schema/motion-brief.schema.json'), 'utf8'));
const video = (extra = {}) => ({ kind: 'video', src: 'motion-v01/layer.mp4', sha256: 'd'.repeat(64), fit: 'cover', ...extra });
const mediaBrief = (scene) => brief({ scenes: [{ scene: 'media', start: 0, end: 22, ...scene }] });

function findAll(node, predicate, found = []) {
  if (!node || typeof node !== 'object') return found;
  if (Array.isArray(node)) { node.forEach((child) => findAll(child, predicate, found)); return found; }
  if (predicate(node)) found.push(node);
  findAll(node.props?.children, predicate, found);
  return found;
}

test('schema: video media frame is an optional card|full enum, image media has no frame', () => {
  const [image, vid] = schema.definitions.mediaScene.properties.media.oneOf;
  assert.deepEqual(vid.properties.frame, { enum: ['card', 'full'] });
  assert.ok(!vid.required.includes('frame'));
  assert.equal(image.properties.frame, undefined);
});

test('validator: frame absent, card and full are accepted for video media', () => {
  for (const frame of [undefined, 'card', 'full']) {
    const result = validateMotionBrief(mediaBrief({ media: video(frame ? { frame } : {}) }));
    assert.equal(result.ok, true, `${frame}: ${result.errors.join('; ')}`);
  }
});

test('validator: unknown frame and frame on image media are rejected', () => {
  assert.equal(validateMotionBrief(mediaBrief({ media: video({ frame: 'wide' }) })).ok, false);
  const image = { kind: 'image', src: 'assets/test.png', sha256: 'a'.repeat(64), fit: 'contain', frame: 'full' };
  assert.equal(validateMotionBrief(mediaBrief({ media: image })).ok, false);
});

test('validator: full-frame media rejects overlayText and caption with a clear message', () => {
  const overlay = validateMotionBrief(mediaBrief({ overlayText: 'Текст', media: video({ frame: 'full' }) }));
  assert.equal(overlay.ok, false);
  assert.ok(overlay.errors.some((e) => /scenes\[0\]\.overlayText: .*frame "full"/.test(e)), overlay.errors.join('; '));
  const caption = validateMotionBrief(mediaBrief({ caption: 'Подпись', media: video({ frame: 'full' }) }));
  assert.equal(caption.ok, false);
  assert.ok(caption.errors.some((e) => /scenes\[0\]\.caption: .*frame "full"/.test(e)), caption.errors.join('; '));
  // card keeps overlayText and caption as before
  assert.equal(validateMotionBrief(mediaBrief({ overlayText: 'Текст', caption: 'Подпись', media: video({ frame: 'card' }) })).ok, true);
});

test('full-frame video renders edge to edge without SceneFrame, zoom or card box and keeps trim/audio', () => {
  const { MediaScene } = loadMotion('src/motion/MediaScene.jsx');
  for (const audioMode of [undefined, 'mute', 'mix', 'replace']) {
    const tree = MediaScene({ media: video({ frame: 'full', trimStartSec: 2.4, audioMode }), durationInFrames: 90 });
    const videos = findAll(tree, (el) => el.type === 'video');
    assert.equal(videos.length, 1);
    const [el] = videos;
    assert.equal(el.props.src, '/static/motion-v01/layer.mp4');
    assert.equal(el.props.trimBefore, 72);
    assert.equal(el.props.muted, audioMode === undefined || audioMode === 'mute');
    assert.deepEqual(el.props.style, { width: '100%', height: '100%', objectFit: 'cover' });
    if (audioMode === 'mix' || audioMode === 'replace') {
      assert.equal(el.props.volume(45), audioMode === 'mix' ? 10 ** (-18 / 20) : 1);
    }
  }
  const markup = renderToStaticMarkup(React.createElement(MediaScene, { media: video({ frame: 'full' }), durationInFrames: 90 }));
  assert.doesNotMatch(markup, /data-motion-safe|scale\(|border-radius/);
  assert.match(markup, /<video/);
});

test('card frame (default) still uses SceneFrame with the card box', () => {
  const { MediaScene } = loadMotion('src/motion/MediaScene.jsx');
  for (const media of [video(), video({ frame: 'card' })]) {
    const markup = renderToStaticMarkup(React.createElement(MediaScene, { media, durationInFrames: 90 }));
    assert.match(markup, /data-motion-safe/);
    assert.match(markup, /border-radius/);
  }
});

test('draft watermark is drawn on top of a full-frame media scene', () => {
  const { MotionDirector } = loadMotion('src/MotionDirector.jsx');
  const scene = { scene: 'media', start: 0, end: 3, media: video({ frame: 'full' }) };
  const markup = renderToStaticMarkup(React.createElement(MotionDirector, { scenes: [scene], draftPreview: true }));
  const videoAt = markup.indexOf('<video');
  const watermarkAt = markup.indexOf('data-draft-preview-watermark');
  assert.ok(videoAt >= 0 && watermarkAt > videoAt, 'watermark follows the media layer in paint order');
  assert.match(markup, /z-index:1000/);
});
