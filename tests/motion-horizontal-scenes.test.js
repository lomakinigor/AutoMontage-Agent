// Горизонтальная раскладка сцен motion (16:9): каждая сцена в кадре 1920×1080 раскладывается
// двумя колонками или широким рядом, а вертикальная разметка всех восьми сцен не меняется.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { loadMotion, scenes, brief, HORIZONTAL_SIZE } = require('./helpers/motion-render');
const { validateMotionBrief } = require('../scripts/motion/brief');

const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const html = (Component, props) => renderToStaticMarkup(React.createElement(Component, props));
const componentsAt = (size) => loadMotion('src/MotionDirector.jsx', {}, size).MOTION_COMPONENTS;
const sceneOf = (name) => scenes.find((scene) => scene.scene === name);
const styleOf = (markup, marker) => {
  const match = markup.match(new RegExp(`${marker}[^>]*style="([^"]*)"`));
  assert.ok(match, `${marker} есть в разметке`);
  return match[1];
};
const horizontal = componentsAt(HORIZONTAL_SIZE);

// Разметка сцен до горизонтальной раскладки (коммит c5c4c3bb, 1080×1920, подпись «Подпись»,
// durationInFrames 90): вертикаль должна совпадать байт-в-байт.
const VERTICAL_SCENE_SHA = {
  'kinetic-title': 'a6827147624db50f8b87bec8b52506688a597504a66d96cb22f13c6ccddd7646',
  card: 'e7841eb01c9014a61d67e83febcd5147a6d1ee1cf34f306a131d2086d23e8e2b',
  steps: 'd79242e21df47305a616fdade434058e55199d0eeccd8397824734f6b9516038',
  list: '7f466d8d48f2b90302d19517cb392f41840e44334a9e64a321ae4038e9cde582',
  counter: '5242a866bf92a6d60612924e594e7df22999a700f6eeb9d561cac44c4cfc9396',
  media: '99ef1ba4e3bc6ffcdf4095644a0da52088b5da757b44bd1199e6faae6f62fc5f',
  cta: 'c3292bf8b319f72b223af9a145a2727b75ec94d0f0daecb34f998db207896520',
  chart: 'c9305ba160ede878c609570f5f88c2904b79583aa014ca658e0efea9e8621232',
};
const VERTICAL_MEDIA_VIDEO_SHA = '6d00a14297504b1b23cf902ed075a777ac7e17e25119259f50b91e5821114672';

test('вертикальная разметка всех восьми сцен совпадает с прежней байт-в-байт', () => {
  const vertical = componentsAt();
  for (const scene of scenes) {
    assert.equal(sha(html(vertical[scene.scene], { ...scene, caption: 'Подпись', durationInFrames: 90 })),
      VERTICAL_SCENE_SHA[scene.scene], scene.scene);
  }
  assert.equal(sha(html(vertical.media, { media: { kind: 'video', src: 'a.mp4', fit: 'cover' }, durationInFrames: 90 })),
    VERTICAL_MEDIA_VIDEO_SHA);
});

test('хелпер рендера: горизонтальное ТЗ 1920×1080 валидно, вертикаль по умолчанию прежняя', () => {
  assert.deepEqual(brief().output, { aspect: 'vertical', width: 1080, height: 1920, fps: 30, durationInFrames: 720 });
  const wide = brief({}, HORIZONTAL_SIZE);
  assert.deepEqual(wide.output, { aspect: 'horizontal', width: 1920, height: 1080, fps: 30, durationInFrames: 720 });
  assert.equal(validateMotionBrief(wide).ok, true);
});

test('в 16:9 каждая сцена получает горизонтальную раскладку и сохраняет весь текст', () => {
  for (const scene of scenes) {
    const markup = html(horizontal[scene.scene], { ...scene, durationInFrames: 90 });
    assert.match(markup, /data-motion-safe/, scene.scene);
    assert.match(markup, /data-motion-layout="horizontal"/, scene.scene);
    const text = markup.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');
    for (const key of ['text', 'title', 'body', 'label', 'overlayText', 'action', 'handle']) {
      if (scene[key]) assert.ok(text.includes(scene[key].trim().replace(/\s+/g, ' ')), `${scene.scene}.${key}`);
    }
  }
});

test('карточка: заголовок и текст – две колонки в ряд', () => {
  const markup = html(horizontal.card, { ...sceneOf('card'), durationInFrames: 90 });
  assert.match(styleOf(markup, 'data-motion-layout="horizontal"'), /flex-direction:row/);
  assert.ok(markup.indexOf('data-motion-column="title"') < markup.indexOf('data-motion-column="body"'));
  const solo = html(horizontal.card, { title: 'Заголовок', durationInFrames: 90 });
  assert.doesNotMatch(solo, /data-motion-column="body"/);
});

test('шаги: горизонтальная цепочка, соединители растут по ширине', () => {
  const markup = html(horizontal.steps, { ...sceneOf('steps'), durationInFrames: 90 });
  assert.match(styleOf(markup, 'data-motion-layout="horizontal"'), /flex-direction:row/);
  assert.equal(markup.match(/data-step-node=/g).length, 4);
  assert.equal(markup.match(/data-step-connector=/g).length, 3);
  for (const index of [1, 2, 3]) assert.match(styleOf(markup, `data-step-connector="${index}"`), /scaleX\(/);
});

test('список: две колонки при четырёх пунктах, одна колонка при трёх', () => {
  const four = html(horizontal.list, { ...sceneOf('list'), durationInFrames: 90 });
  assert.match(styleOf(four, 'data-motion-layout="horizontal"'), /grid-template-columns:repeat\(2, *minmax\(0, *1fr\)\)/);
  const three = html(horizontal.list, { ...sceneOf('list'), items: sceneOf('list').items.slice(0, 3), durationInFrames: 90 });
  assert.match(styleOf(three, 'data-motion-layout="horizontal"'), /grid-template-columns:minmax\(0, *1fr\)/);
});

test('счётчик: число слева, подпись справа', () => {
  const markup = html(horizontal.counter, { ...sceneOf('counter'), durationInFrames: 90 });
  assert.match(styleOf(markup, 'data-motion-layout="horizontal"'), /flex-direction:row/);
  assert.ok(markup.indexOf('data-counter-value') < markup.indexOf(sceneOf('counter').label));
});

test('график: на всю ширину содержимого 16:9 и ниже вертикального', () => {
  const markup = html(horizontal.chart, { ...sceneOf('chart'), durationInFrames: 90 });
  const style = styleOf(markup, 'data-chart-type');
  const width = Number(style.match(/(?:^|;)width:(\d+)px/)[1]);
  const height = Number(style.match(/(?:^|;)height:(\d+)px/)[1]);
  assert.equal(width, 1760 - 38 * 2);
  assert.ok(height < 700, `высота графика ${height}`);
});

test('медиа-карточка в 16:9 вписывает видео 9:16 (contain), а не растягивает его на кадр', () => {
  const video = { kind: 'video', src: 'assets/portrait.mp4', fit: 'cover' };
  for (const overlayText of [undefined, 'Текст рядом с видео']) {
    const markup = html(horizontal.media, { media: video, overlayText, durationInFrames: 90 });
    assert.match(markup, /data-motion-layout="horizontal"/);
    const style = styleOf(markup, '<video');
    assert.match(style, /object-fit:contain/);
    assert.doesNotMatch(style, /scale\(1\.0/);
  }
  const withText = html(horizontal.media, { media: video, overlayText: 'Текст', durationInFrames: 90 });
  assert.match(styleOf(withText, 'data-motion-layout="horizontal"'), /flex-direction:row/);
});

test('медиа frame: full в 16:9 не меняется: слой на весь кадр с выбранным fit', () => {
  const markup = html(horizontal.media, { media: { kind: 'video', src: 'a.mp4', fit: 'cover', frame: 'full' }, durationInFrames: 90 });
  assert.doesNotMatch(markup, /data-motion-safe|data-motion-layout/);
  assert.match(styleOf(markup, '<video'), /width:100%;height:100%;object-fit:cover/);
});

test('CTA: заголовок слева, действие и контакт справа', () => {
  const markup = html(horizontal.cta, { title: 'Призыв', action: 'Действие', handle: 'Контакт', durationInFrames: 90 });
  assert.match(styleOf(markup, 'data-motion-layout="horizontal"'), /flex-direction:row/);
  assert.ok(markup.indexOf('Призыв') < markup.indexOf('Действие'));
  assert.ok(markup.indexOf('Действие') < markup.indexOf('Контакт'));
});
