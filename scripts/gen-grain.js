#!/usr/bin/env node
// Детерминированная плитка зерна 256x256 (оттенки серого, 8 бит) для текстуры кадра.
// Только встроенные модули Node: zlib и ручная сборка PNG. Seed фиксирован, поэтому
// повторный запуск даёт тот же файл байт в байт.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SIZE = 256;
const SEED = 20261018;
const DEFAULT_OUTPUT = path.join(__dirname, '../public/textures/grain-256.png');
const DEFAULT_MODULE = path.join(__dirname, '../src/details/grain-data.js');

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xFFFFFFFF;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function generateGrain() {
  const random = mulberry32(SEED);
  const raw = Buffer.alloc((SIZE + 1) * SIZE);
  for (let row = 0; row < SIZE; row += 1) {
    const base = row * (SIZE + 1);
    raw[base] = 0; // фильтр строки: none
    for (let col = 0; col < SIZE; col += 1) raw[base + 1 + col] = Math.floor(random() * 256);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(SIZE, 0);
  header.writeUInt32BE(SIZE, 4);
  header[8] = 8; // глубина
  header[9] = 0; // оттенки серого
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Изолированный public/ рендера не содержит файлов репозитория, поэтому плитку
// встраиваем как data URI (как шрифты в src/fonts-data.js).
function grainModuleSource(png) {
  return `// Автоген scripts/gen-grain.js, не править вручную.\nexport const GRAIN_DATA_URI = 'data:image/png;base64,${png.toString('base64')}';\n`;
}

if (require.main === module) {
  // Без аргументов пишем PNG и модуль; свой PNG-путь не трогает репозиторный модуль,
  // если второй аргумент не задан.
  const png = generateGrain();
  const output = path.resolve(process.argv[2] || DEFAULT_OUTPUT);
  const moduleOutput = process.argv[3] ? path.resolve(process.argv[3]) : (process.argv[2] ? null : DEFAULT_MODULE);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, png);
  console.log(output);
  if (moduleOutput) {
    fs.mkdirSync(path.dirname(moduleOutput), { recursive: true });
    fs.writeFileSync(moduleOutput, grainModuleSource(png));
    console.log(moduleOutput);
  }
}

module.exports = { generateGrain, grainModuleSource, SIZE, SEED };
