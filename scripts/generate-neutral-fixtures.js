#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const REPOSITORY_ROOT = path.resolve(__dirname, '..');
const PUBLIC_TEXT_FIXTURES = Object.freeze([
  'src/data/transcript.json',
  'src/data/captions.js',
  'props/job1v.json',
  'props/preview.json',
  'props/preview_h.json',
]);
const TEXT = 'Это нейтральное демо автомонтажа. Агент получает исходник, добавляет титры, '
  + 'выбирает визуальные сцены и собирает готовый ролик. Личные материалы остаются локально.';

function roundTime(value) {
  return Math.round(value * 100) / 100;
}

function timedWords() {
  let cursor = 0.35;
  return TEXT.split(' ').map((token) => {
    const letters = token.replace(/[.,!?]/gu, '').length;
    const start = roundTime(cursor);
    const end = roundTime(start + Math.min(0.64, 0.22 + letters * 0.025));
    cursor = end + (/[.!?]$/u.test(token) ? 0.28 : 0.08);
    return { w: token, s: start, e: end };
  });
}

function captionGroups(words) {
  const groups = [];
  for (let index = 0; index < words.length; index += 4) {
    const groupWords = words.slice(index, index + 4);
    groups.push({
      start: groupWords[0].s,
      end: groupWords.at(-1).e,
      words: groupWords,
    });
  }
  return groups;
}

function blocks(captions, horizontal) {
  const position = horizontal ? { h: 'right', v: 'top' } : undefined;
  const withPosition = (block) => (position ? { ...block, pos: position } : block);
  return [
    { type: 'LabelTop', start: 0.3, text: '>_ ДЕМО АВТОМОНТАЖА' },
    {
      type: 'CaptionsAuto',
      start: 0,
      groups: captions,
      pos: horizontal ? 'bottom' : 'top',
      offset: horizontal ? 40 : 150,
    },
    withPosition({
      type: 'InfoCard',
      start: 0.8,
      end: 4.1,
      tag: '// PIPELINE',
      title: 'ИСХОДНИК → СЦЕНЫ',
      pills: ['локальная обработка', 'готовый план'],
    }),
    {
      type: 'BrollFullscreen',
      start: 4.3,
      end: 7.1,
      image: 'broll/screenshot.png',
      caption: 'визуальные сцены',
      fit: horizontal ? 'contain' : 'cover',
      transition: 'slide',
    },
    withPosition({
      type: 'SubtitleCard',
      start: 7.3,
      end: 10.1,
      text: 'Титры по таймкоду',
      accent: true,
      sub: 'синхронно с речью',
    }),
    {
      type: 'BrollFullscreen',
      start: 10.3,
      end: 12.4,
      image: 'broll/growth.png',
      caption: 'готовый ролик',
      fit: 'contain',
      transition: 'wipe',
    },
    withPosition({
      type: 'CTACard',
      start: 12.5,
      head: 'СОБЕРИ ДЕМО',
      btn: 'automontage demo',
    }),
  ];
}

function propsFixture({ captions, width, height, horizontal = false }) {
  return {
    source: 'demo-source.mp4',
    theme: 'craft',
    width,
    height,
    fps: 25,
    durationInFrames: 350,
    beatZoom: true,
    beatSec: 3,
    blocks: blocks(captions, horizontal),
  };
}

function writeText(root, relativePath, source) {
  const destination = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, source);
}

function generateNeutralFixtures({ root = REPOSITORY_ROOT } = {}) {
  const destinationRoot = path.resolve(root);
  const words = timedWords();
  const captions = captionGroups(words);
  const transcript = [{
    start: words[0].s,
    end: words.at(-1).e,
    text: TEXT,
    words: words.map((word) => ({ ...word, w: ` ${word.w}` })),
  }];
  const fixtures = {
    'src/data/transcript.json': `${JSON.stringify(transcript, null, 2)}\n`,
    'src/data/captions.js': [
      '// АВТОГЕНЕРАЦИЯ (scripts/generate-neutral-fixtures.js).',
      `export const CAPTIONS = ${JSON.stringify(captions, null, 2)};`,
      '',
    ].join('\n'),
    'props/job1v.json': `${JSON.stringify(propsFixture({
      captions, width: 1080, height: 1920,
    }), null, 2)}\n`,
    'props/preview.json': `${JSON.stringify(propsFixture({
      captions, width: 1080, height: 1920,
    }), null, 2)}\n`,
    'props/preview_h.json': `${JSON.stringify(propsFixture({
      captions, width: 1280, height: 720, horizontal: true,
    }), null, 2)}\n`,
  };

  for (const relativePath of PUBLIC_TEXT_FIXTURES) {
    writeText(destinationRoot, relativePath, fixtures[relativePath]);
  }
  return { files: [...PUBLIC_TEXT_FIXTURES], transcript, captions };
}

if (require.main === module) {
  const result = generateNeutralFixtures();
  console.log(`neutral fixtures: ${result.files.length}`);
}

module.exports = {
  PUBLIC_TEXT_FIXTURES,
  TEXT,
  generateNeutralFixtures,
};
