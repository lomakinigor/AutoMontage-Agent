// Настоящий рендер MotionReel 1920×1080: все восемь сцен с максимальной длиной кириллического
// текста держат каждый текст и всю раскладку внутри safe-зоны 16:9 без переполнения.
// Тяжёлый тест: запускается только с AUTOMONTAGE_TEST_MOTION_RENDER=1.
const test = require('node:test');
const assert = require('node:assert/strict');
const { scenes, brief, HORIZONTAL_SIZE } = require('./helpers/motion-render');

// SAFE_16x9 = {top 60, bottom 60, left 80, right 80} в кадре 1920×1080 (масштаб 1).
const SAFE = { left: 80, right: 1840, top: 60, bottom: 1020 };

test('real horizontal MotionReel frames keep every maximum-length Cyrillic field inside the 16:9 safe zone', {
  skip: process.env.AUTOMONTAGE_TEST_MOTION_RENDER !== '1', timeout: 600_000,
}, async (t) => {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const { execFileSync } = require('node:child_process');
  const { bundle } = require('@remotion/bundler');
  const { openBrowser, renderStill, selectComposition } = require('@remotion/renderer');
  const { buildMotionProps, validateMotionBrief } = require('../scripts/motion/brief');
  const root = path.join(__dirname, '..');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-render-h-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const outputDir = process.env.AUTOMONTAGE_MOTION_FRAMES_DIR || path.join(work, 'frames');
  fs.mkdirSync(outputDir, { recursive: true });
  const publicDir = path.join(work, 'public');
  fs.mkdirSync(path.join(publicDir, 'assets'), { recursive: true });
  const ffmpeg = process.env.AUTOMONTAGE_FFMPEG_DIR
    ? path.join(process.env.AUTOMONTAGE_FFMPEG_DIR, 'ffmpeg') : 'ffmpeg';
  // Портретная картинка 9:16 в медиа-карточке: проверяем, что она вписана, а не растянута.
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0xDEE7F3:s=360x640', '-frames:v', '1', path.join(publicDir, 'assets/test.png')]);
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=22', path.join(publicDir, 'narration.wav')]);
  const serveUrl = await bundle({ entryPoint: path.join(root, 'src/index.js'), publicDir, outDir: path.join(work, 'bundle') });
  const browser = await openBrowser('chrome', { logLevel: 'error' });
  t.after(() => browser.close({ silent: true }));
  const measured = [];
  const newPage = browser.newPage.bind(browser);
  browser.newPage = async (...args) => {
    const page = await newPage(...args);
    const close = page.close.bind(page);
    page.close = async (...closeArgs) => {
      try {
        const frame = await page.evaluate(() => {
          const rectOf = (el) => {
            const r = el.getBoundingClientRect();
            return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
          };
          const safe = document.querySelector('[data-motion-safe]');
          if (!safe) return null;
          const area = safe.firstElementChild;
          const layout = document.querySelector('[data-motion-layout]');
          const media = document.querySelector('[data-motion-safe] img');
          return {
            safe: rectOf(safe),
            area: { scrollHeight: area.scrollHeight, clientHeight: area.clientHeight },
            layout: layout ? rectOf(layout) : null,
            media: media ? { fit: getComputedStyle(media).objectFit, rect: rectOf(media) } : null,
            boxes: [...document.querySelectorAll('[data-motion-text]')].map((box) => ({
              text: box.textContent, fontSize: getComputedStyle(box).fontSize,
              counter: box.hasAttribute('data-counter-value'),
              box: rectOf(box), content: rectOf(box.firstElementChild),
              scrollWidth: box.firstElementChild.scrollWidth, clientWidth: box.clientWidth,
            })),
          };
        });
        if (frame) measured.push(frame);
      } finally { await close(...closeArgs); }
    };
    return page;
  };
  const wide = brief({}, HORIZONTAL_SIZE);
  assert.equal(validateMotionBrief(wide).ok, true);
  const props = buildMotionProps({ brief: wide, sourceFile: 'narration.wav' });
  const composition = await selectComposition({ serveUrl, id: 'MotionReel', inputProps: props, puppeteerInstance: browser });
  assert.equal(composition.width, 1920);
  assert.equal(composition.height, 1080);
  const unbroken = scenes.map((scene) => {
    const next = { ...scene, caption: 'Щ'.repeat(160) };
    for (const key of ['text', 'title', 'body', 'label', 'overlayText', 'action', 'handle', 'prefix', 'suffix']) {
      if (next[key]) next[key] = 'Щ'.repeat(next[key].length);
    }
    if (next.steps) next.steps = next.steps.map((step) => 'Щ'.repeat(step.length));
    if (next.items) next.items = next.items.map((item) => 'Щ'.repeat(item.length));
    return next;
  });
  const inside = (rect, bounds) => rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1
    && rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1;
  for (const [variant, inputProps] of [
    ['dense', props],
    ['unbroken-caption', { ...props, scenes: unbroken }],
  ]) {
    for (let index = 0; index < scenes.length; index++) {
      const name = `h-${variant}-${scenes[index].scene}`;
      await renderStill({ serveUrl, composition: { ...composition, props: inputProps }, inputProps,
        puppeteerInstance: browser, frame: index * 90 + 89, imageFormat: 'png',
        output: path.join(outputDir, `${name}.png`), logLevel: 'error' });
      const frame = measured.at(-1);
      assert.ok(frame?.boxes.length, `${name}: actual DOM was measured`);
      assert.deepEqual(frame.safe, SAFE, `${name}: safe zone 16:9`);
      assert.ok(frame.layout, `${name}: horizontal layout is used`);
      assert.ok(inside(frame.layout, SAFE), `${name}: layout overflows safe zone ${JSON.stringify(frame.layout)}`);
      assert.ok(frame.area.scrollHeight <= frame.area.clientHeight + 1, `${name}: content overflows the scene ${JSON.stringify(frame.area)}`);
      if (scenes[index].scene === 'media') {
        assert.equal(frame.media?.fit, 'contain', `${name}: 9:16 media is fitted`);
        const { left, right, top, bottom } = frame.media.rect;
        assert.ok(right - left < 1760 && bottom - top <= 960, `${name}: media card is not stretched across the frame`);
      }
      for (const box of frame.boxes) {
        if (box.counter) assert.ok(box.content.bottom - box.content.top <= parseFloat(box.fontSize) * 1.17, `${name}: a number must remain on one line`);
        assert.ok(box.scrollWidth <= box.clientWidth + 1, `${name}: horizontal overflow ${JSON.stringify(box)}`);
        assert.ok(box.content.bottom <= box.box.bottom + 1, `${name}: text exceeds allocated box ${JSON.stringify(box)}`);
        for (const rect of [box.box, box.content]) {
          assert.ok(inside(rect, SAFE), `${name}: safe-zone overflow ${JSON.stringify(box)}`);
        }
      }
    }
  }
  for (const [name, frame] of [['h-steps-connector', 200], ['h-counter-mid', 375], ['h-cta-enter', 555]]) {
    await renderStill({ serveUrl, composition, inputProps: props, puppeteerInstance: browser,
      frame, imageFormat: 'png', output: path.join(outputDir, `${name}.png`), logLevel: 'error' });
  }
  fs.writeFileSync(path.join(outputDir, 'layout-measurements-horizontal.json'), JSON.stringify(measured, null, 2));
});
