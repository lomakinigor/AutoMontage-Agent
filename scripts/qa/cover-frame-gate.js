// G13 «Обложка – кадр 0» – чистое решение по замеру первого кадра финала (frameStats из
// scripts/layer/sheet.js: доля краёв и средняя яркость 0–255). Ролик, начатый с затемнения или пустого
// фона, в ленте получит чёрную или пустую обложку. Статус только warn: финальный QA публикацию не блокирует.
'use strict';
const { gate } = require('./report');
const { SHARE_THRESHOLD } = require('./empty-frame-gate');

const COVER_EDGE_SHARE_MIN = SHARE_THRESHOLD;
const COVER_LUMA_MIN = 20;
const HINT = 'обложка в ленте будет пустой или чёрной – начните с кадра со спикером или заголовком';

const ru = (value) => String(Math.round(value * 100) / 100).replace('.', ',');

// stats – {edgeShare, meanLuma} или null, если кадр не удалось замерить (это тоже warn, а не молчание).
function coverFrameGate(stats) {
  const valid = stats && Number.isFinite(stats.edgeShare) && Number.isFinite(stats.meanLuma);
  let note = null;
  if (!valid) note = 'кадр 0 не удалось прочитать';
  else if (stats.meanLuma < COVER_LUMA_MIN) note = 'кадр 0 почти чёрный';
  else if (stats.edgeShare < COVER_EDGE_SHARE_MIN) note = 'кадр 0 пустой или однотонный';
  return gate('G13', 'Обложка – кадр 0', {
    status: note ? 'warn' : 'pass',
    value: valid ? ru(stats.meanLuma) : null,
    unit: valid ? 'средняя яркость' : '',
    threshold: `яркость не меньше ${COVER_LUMA_MIN}, доля краёв не меньше ${ru(COVER_EDGE_SHARE_MIN * 100)} %`,
    spans: note ? [{ fromSec: 0, toSec: 0, note }] : [],
    hint: note ? HINT : '',
  });
}

module.exports = { COVER_EDGE_SHARE_MIN, COVER_LUMA_MIN, coverFrameGate };
