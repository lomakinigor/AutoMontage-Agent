// G14 «Текст за краем» и G15 «Наложение надписей»: чистые гейты над рамками текста, которые
// собраны с отрендеренных кадров. Ввода-вывода здесь нет. Оба гейта дают только warn: часть блоков
// движка (LabelTop, Chip, карточки) по своей вёрстке стоит вне безопасной зоны, и fail срабатывал бы
// почти на каждом финале. Такая находка – задача движка, а не повод пересобирать ролик.
const { gate } = require('./report');
const { overflow, safeRect } = require('./safe-rect');

const OVERLAP_SHARE_MAX = 0.04;
const MAX_SPANS = 10;
const SIDES = { left: 'слева', top: 'сверху', right: 'справа', bottom: 'снизу' };
const NO_TEXT = 'в кадрах нет размеченного текста';

// Подпись субтитров и подложка (caption-3, caption-3b, caption-3b2) – один блок.
// Суффикс b режем только сразу после цифры, чтобы не задеть слова вроде label-tab.
const groupOf = (id) => String(id).replace(/(?<=\d)b\d*$/u, '');
const sameGroup = (a, b) => groupOf(a) === groupOf(b);

const area = (r) => Math.max(0, r.right - r.left) * Math.max(0, r.bottom - r.top);

function intersection(a, b) {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return w > 0 && h > 0 ? w * h : 0;
}

function textLayoutGates({ samples, width, height, error } = {}) {
  const list = Array.isArray(samples) ? samples : [];
  if (!Array.isArray(samples) || !list.some((s) => Array.isArray(s?.boxes) && s.boxes.length)) {
    const hint = error ? String(error) : NO_TEXT;
    return [
      gate('G14', 'Текст за краем', { status: 'skipped', hint }),
      gate('G15', 'Наложение надписей', { status: 'skipped', hint }),
    ];
  }
  const safe = safeRect(width, height);
  const edge = [];
  const overlap = [];
  for (const sample of list) {
    const boxes = Array.isArray(sample?.boxes) ? sample.boxes : [];
    for (const b of boxes) {
      const out = overflow(b.rect, safe);
      if (!out && !b.clipped) continue;
      const parts = out ? Object.entries(out).map(([side, px]) => `${SIDES[side]} на ${px} px`) : [];
      if (b.clipped) parts.push('обрезан');
      edge.push({ timeSec: sample.timeSec, note: `${b.id}: ${parts.join(', ')}` });
    }
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        if (sameGroup(boxes[i].id, boxes[j].id)) continue;
        const smaller = Math.min(area(boxes[i].rect), area(boxes[j].rect));
        const shared = intersection(boxes[i].rect, boxes[j].rect);
        if (smaller <= 0 || shared <= 0) continue;
        const share = shared / smaller;
        if (share > OVERLAP_SHARE_MAX) {
          overlap.push({ timeSec: sample.timeSec, note: `${boxes[i].id} и ${boxes[j].id}: пересечение ${Math.round(share * 100)} % меньшей надписи` });
        }
      }
    }
  }
  const spans = (items) => items.slice(0, MAX_SPANS).map((v) => ({ fromSec: v.timeSec, toSec: v.timeSec, note: v.note }));
  return [
    gate('G14', 'Текст за краем', {
      status: edge.length ? 'warn' : 'pass', value: edge.length, unit: 'шт.',
      threshold: 'внутри безопасной зоны на каждом кадре', spans: spans(edge),
      hint: edge.length ? 'сдвиньте или сократите надпись, чтобы она целиком лежала в безопасной зоне' : '',
    }),
    gate('G15', 'Наложение надписей', {
      status: overlap.length ? 'warn' : 'pass', value: overlap.length, unit: 'шт.',
      threshold: `пересечение не больше ${Math.round(OVERLAP_SHARE_MAX * 100)} % площади меньшей надписи`, spans: spans(overlap),
      hint: overlap.length ? 'разнесите надписи по времени или по месту: они закрывают друг друга' : '',
    }),
  ];
}

module.exports = { OVERLAP_SHARE_MAX, sameGroup, textLayoutGates };
