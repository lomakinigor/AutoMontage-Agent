const fs = require('node:fs');
const path = require('node:path');
const Ajv = require('ajv');
const { frameSnapSeconds, isCanonicalBrollReference } = require('../lesson/broll-media');

const MOTION_SCENES = [
  'kinetic-title',
  'card',
  'steps',
  'list',
  'counter',
  'media',
  'cta',
  'chart',
];

// Переходы между сценами: тот же список и те же значения, что в src/motion/transitions.js
// (ESM-модуль композиции; совпадение проверяет tests/motion-transitions.test.js). frames – в кадрах
// эталона 25 fps и пересчитываются под FPS ролика той же формулой, что ref25 в motion-kit.
const MOTION_TRANSITION_TYPES = ['cut', 'fade', 'slide', 'wipe', 'push'];
const TRANSITION_FRAMES_25 = { default: 10, min: 6, max: 15 };
const DIRECTED_TRANSITIONS = new Set(['slide', 'wipe']);
const ref25 = (frames, fps) => Math.max(1, Math.round((frames * fps) / 25));

const MOTION_MEDIA_EXTENSIONS = {
  image: new Set(['.avif', '.gif', '.jpeg', '.jpg', '.png', '.webp']),
  video: new Set(['.m4v', '.mov', '.mp4', '.webm']),
};

const schemaPath = path.join(__dirname, '../../schema/motion-brief.schema.json');
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
const validator = new Ajv({ allErrors: true, strict: false, strictNumbers: true }).compile(schema);

function schemaErrors(brief) {
  if (validator(brief)) return [];
  return (validator.errors || []).map((error) => {
    const location = error.instancePath || '(корень)';
    const property = error.keyword === 'additionalProperties'
      ? `/${error.params.additionalProperty}`
      : '';
    return `${location}${property}: ${error.message}`;
  });
}

function isFrameSnapped(seconds, fps) {
  try {
    return Math.abs(frameSnapSeconds(seconds, fps) - seconds) < 1e-9;
  } catch (_) {
    return false;
  }
}

function hasEncodedPathSeparatorOrTraversal(value) {
  return value.split('/').some((rawSegment) => {
    let segment = rawSegment;
    for (let depth = 0; depth < 16; depth += 1) {
      let decoded;
      try {
        decoded = decodeURIComponent(segment);
      } catch (_) {
        return false;
      }
      if (decoded === segment) return false;
      if (decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\')) {
        return true;
      }
      segment = decoded;
    }
    return true;
  });
}

function isCanonicalMotionReference(value) {
  return isCanonicalBrollReference(value)
    && !hasEncodedPathSeparatorOrTraversal(value);
}

function containsExecutableMarkup(value) {
  if (typeof value === 'string') {
    return /<\/?(?:script|style|iframe|object|embed|svg|math|link|meta)\b/i.test(value)
      || /\bjavascript\s*:/i.test(value)
      || /\bon[a-z]+\s*=/i.test(value);
  }
  if (Array.isArray(value)) return value.some(containsExecutableMarkup);
  if (value && typeof value === 'object') return Object.values(value).some(containsExecutableMarkup);
  return false;
}

// Вход в сцену index из предыдущей. Содержимое сцены видно ровно в start; предыдущая сцена
// тянется до start (через паузу, если она есть) и дальше на хвост перехода стоп-кадром. Переход
// не длиннее самой сцены и предыдущей сцены (по их длине из ТЗ, без паузы). У push первая половина
// (lead = floor(frames/2)) идёт до start, поэтому вход не может начаться раньше предыдущей сцены.
function transitionErrors(scenes, index, fps) {
  const transition = scenes[index]?.transition;
  if (!transition || typeof transition !== 'object') return [];
  const at = `scenes[${index}].transition`;
  const errors = [];
  const { type, frames, direction } = transition;
  if (!MOTION_TRANSITION_TYPES.includes(type)) {
    return [`${at}.type: неизвестный переход "${type}", допустимо: ${MOTION_TRANSITION_TYPES.join(', ')}`];
  }
  if (type === 'cut') {
    if (frames !== undefined) errors.push(`${at}.frames: у склейки cut нет длительности – уберите frames`);
    if (direction !== undefined) errors.push(`${at}.direction: у склейки cut нет направления – уберите direction`);
    return errors;
  }
  if (index === 0) {
    return [`${at}: у первой сцены нет предыдущей, входить не из чего – уберите transition или поставьте cut`];
  }
  if (direction !== undefined && !DIRECTED_TRANSITIONS.has(type)) {
    errors.push(`${at}.direction: направление задаётся только у slide и wipe, у ${type} его нет – уберите direction`);
  }
  if (frames !== undefined && (!Number.isInteger(frames)
    || frames < TRANSITION_FRAMES_25.min || frames > TRANSITION_FRAMES_25.max)) {
    errors.push(`${at}.frames: длительность перехода ${frames} вне ${TRANSITION_FRAMES_25.min}–${TRANSITION_FRAMES_25.max} кадров при 25 fps`);
    return errors;
  }
  if (!Number.isFinite(fps)) return errors;
  const length = ref25(Number.isInteger(frames) ? frames : TRANSITION_FRAMES_25.default, fps);
  const scene = scenes[index];
  const prev = scenes[index - 1];
  const bounds = (value) => (Number.isFinite(value?.start) && Number.isFinite(value?.end)
    ? { from: Math.round(value.start * fps), to: Math.round(value.end * fps) } : null);
  const own = bounds(scene);
  const before = bounds(prev);
  if (!own || !before) return errors;
  const lead = type === 'push' ? Math.floor(length / 2) : 0;
  // Две проверки ниже у сцен по порядку не срабатывают (own.from >= before.to, lead <= длины
  // предыдущей сцены, start >= 0); они достижимы только у пересекающихся сцен, где уже есть ошибка
  // «пересекается», и уточняют её для push. Оставлены как защита, если проверку порядка ослабят.
  if (own.from - lead < before.from) {
    errors.push(`${at}: push начинается за ${lead} кадров до start, раньше начала предыдущей сцены; укоротите frames или поставьте другой переход`);
  }
  if (own.from - lead < 0) {
    errors.push(`${at}: push начинается за ${lead} кадров до start, раньше начала ролика`);
  }
  if (length > before.to - before.from) {
    errors.push(`${at}: переход (${length} кадров) длиннее предыдущей сцены (${before.to - before.from} кадров)`);
  }
  if (length > own.to - own.from) {
    errors.push(`${at}: переход (${length} кадров) длиннее самой сцены (${own.to - own.from} кадров)`);
  }
  // Вход в предыдущую сцену должен закончиться не позже, чем начнётся выход из неё в эту сцену,
  // иначе предыдущая сцена одновременно входит и выходит и в кадре три сцены сразу.
  const entry = index >= 2 ? resolvedTransitionFrames(prev?.transition, fps) : null;
  if (entry) {
    const entryEnd = before.from - entry.lead + entry.length;
    const exitStart = own.from - lead;
    if (entryEnd > exitStart) {
      errors.push(`${at}: переход ${type} в scenes[${index}] начинается на кадре ${exitStart}, а переход ${prev.transition.type} в scenes[${index - 1}] ещё идёт до кадра ${entryEnd}; удлините scenes[${index - 1}] или укоротите один из переходов`);
    }
  }
  return errors;
}

// Длительность в кадрах FPS ролика и lead корректного не-cut перехода; иначе null.
function resolvedTransitionFrames(transition, fps) {
  if (!transition || typeof transition !== 'object' || transition.type === 'cut'
    || !MOTION_TRANSITION_TYPES.includes(transition.type)) return null;
  const { frames } = transition;
  if (frames !== undefined && (!Number.isInteger(frames)
    || frames < TRANSITION_FRAMES_25.min || frames > TRANSITION_FRAMES_25.max)) return null;
  const length = ref25(frames ?? TRANSITION_FRAMES_25.default, fps);
  return { length, lead: transition.type === 'push' ? Math.floor(length / 2) : 0 };
}

// aspect должен совпадать с реальным размером кадра: горизонталь 16:9 – шире, чем выше; вертикаль – наоборот.
function aspectErrors(output) {
  const { aspect, width, height } = output || {};
  if (!Number.isInteger(width) || !Number.isInteger(height)) return [];
  if (aspect === 'horizontal' && width <= height) {
    return [`output.aspect: для horizontal ширина должна быть больше высоты (сейчас ${width}x${height}); горизонтальный ролик – 1920x1080`];
  }
  if (aspect === 'vertical' && height <= width) {
    return [`output.aspect: для vertical высота должна быть больше ширины (сейчас ${width}x${height}); вертикальный ролик – 1080x1920`];
  }
  return [];
}

function validateMotionBrief(brief, { requireApproved = false } = {}) {
  const errors = schemaErrors(brief);
  const scenes = Array.isArray(brief?.scenes) ? brief.scenes : [];
  const fps = brief?.output?.fps;
  const durationInFrames = brief?.output?.durationInFrames;

  if (typeof brief?.source === 'string' && !isCanonicalMotionReference(brief.source)) {
    errors.push('source: ссылка на narration должна быть канонической относительной внутри проекта');
  }
  errors.push(...aspectErrors(brief?.output));
  if (brief?.status === 'draft' && brief.approval) errors.push('draft cannot carry an approval receipt');
  if (brief?.audioRole === 'music' && brief.music) {
    errors.push('music: a music-only reel uses the source audio as its soundtrack; mix extra music into the source');
  }
  if (brief?.music && !isCanonicalMotionReference(brief.music.file)) {
    errors.push('music.file: music must be a canonical project reference');
  }
  if (containsExecutableMarkup(brief)) {
    errors.push('brief: executable HTML or JavaScript markup is not allowed');
  }

  scenes.forEach((scene, index) => {
    if (!MOTION_SCENES.includes(scene?.scene)) {
      errors.push(`scenes[${index}]: сцена "${scene?.scene}" не входит в motion library`);
    }
    if (Number.isFinite(scene?.start) && Number.isFinite(scene?.end) && scene.end <= scene.start) {
      errors.push(`scenes[${index}]: end (${scene.end}) должен быть больше start (${scene.start})`);
    }
    for (const field of ['start', 'end']) {
      if (Number.isFinite(scene?.[field]) && Number.isFinite(fps)
        && !isFrameSnapped(scene[field], fps)) {
        errors.push(`scenes[${index}].${field}: тайминг должен совпадать с границей кадра`);
      }
    }
    if (index > 0 && Number.isFinite(scene?.start) && Number.isFinite(scenes[index - 1]?.end)
      && scene.start < scenes[index - 1].end) {
      errors.push(`scenes[${index}]: тайминг пересекается с предыдущей сценой`);
    }
    if (Number.isFinite(scene?.end) && Number.isFinite(fps) && Number.isInteger(durationInFrames)
      && Math.round(scene.end * fps) > durationInFrames) {
      errors.push(`scenes[${index}].end: сцена выходит за длительность narration`);
    }
    errors.push(...transitionErrors(scenes, index, fps));
    if (scene?.scene === 'chart' && Array.isArray(scene.points) && Number.isInteger(scene.highlight)
      && scene.highlight >= scene.points.length) {
      errors.push(`scenes[${index}].highlight: индекс ${scene.highlight} вне диапазона точек графика (0–${scene.points.length - 1})`);
    }
    if (scene?.scene === 'media' && scene.media) {
      const { kind, src } = scene.media;
      if (!isCanonicalMotionReference(src)) {
        errors.push(`scenes[${index}].media.src: ссылка должна быть канонической относительной внутри проекта`);
      } else if (MOTION_MEDIA_EXTENSIONS[kind]
        && !MOTION_MEDIA_EXTENSIONS[kind].has(path.posix.extname(src).toLowerCase())) {
        errors.push(`scenes[${index}].media.src: расширение не соответствует media kind ${kind}`);
      }
      if (kind === 'video' && Number.isFinite(scene.media.trimStartSec)
        && Number.isFinite(fps) && !isFrameSnapped(scene.media.trimStartSec, fps)) {
        errors.push(`scenes[${index}].media.trimStartSec: тайминг должен совпадать с границей кадра`);
      }
      if (kind === 'video' && scene.media.frame === 'full') {
        for (const field of ['overlayText', 'caption']) {
          if (scene[field] !== undefined) {
            errors.push(`scenes[${index}].${field}: media with frame "full" fills the whole frame and has no room for ${field}; remove ${field} or use frame "card"`);
          }
        }
      }
    }
  });

  if (requireApproved && brief?.status !== 'approved') {
    errors.push('motion brief is not approved: status must be approved');
  }
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

function motionProps({ brief, theme, sourceFile = 'narration.mp3' }) {
  return {
    theme: theme ?? brief.theme,
    scenes: brief.scenes,
    ...(brief.style ? { style: brief.style } : {}),
    audioSrc: sourceFile,
    videoTitle: brief.title,
    width: brief.output.width,
    height: brief.output.height,
    fps: brief.output.fps,
    durationInFrames: brief.output.durationInFrames,
  };
}

function buildDraftMotionProps(options) {
  const validation = validateMotionBrief(options.brief);
  if (!validation.ok) throw new Error(validation.errors.join('\n'));
  if (options.brief.status !== 'draft') throw new Error('motion preview requires status draft');
  return { ...motionProps(options), draftPreview: true };
}

function buildMotionProps(options) {
  const validation = validateMotionBrief(options.brief, { requireApproved: true });
  if (!validation.ok) throw new Error(validation.errors.join('\n'));
  return motionProps(options);
}

function clock(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(safe / 60);
  const rest = Math.floor(safe % 60);
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

function cell(value) {
  return String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function sceneSummary(scene) {
  if (scene.scene === 'kinetic-title') return scene.text;
  if (scene.scene === 'card') return [scene.title, scene.body].filter(Boolean).join(': ');
  if (scene.scene === 'steps') return [scene.title, ...(scene.steps || [])].filter(Boolean).join(' → ');
  if (scene.scene === 'list') return [scene.title, ...(scene.items || [])].filter(Boolean).join('; ');
  if (scene.scene === 'counter') return `${scene.label}: ${scene.prefix || ''}${scene.value}${scene.suffix || ''}`;
  if (scene.scene === 'chart') {
    const points = (scene.points || []).map(point => `${point.label} ${point.value}`).join('; ');
    return `${scene.title} (${scene.chartType}${scene.unit ? `, ${scene.unit}` : ''}): ${points}`;
  }
  if (scene.scene === 'media') return `${scene.media?.kind}: ${scene.media?.src}${scene.overlayText ? ` – ${scene.overlayText}` : ''}`;
  return [scene.title, scene.action, scene.handle].filter(Boolean).join(' – ');
}

const DIRECTION_WORDS = { left: 'влево', right: 'вправо', up: 'вверх', down: 'вниз' };

// Строка о входе в сцену для человека, который утверждает ТЗ: тип, длительность в секундах при FPS
// ролика (тот же пересчёт, что в рендере) и направление у slide/wipe. cut и отсутствие поля – пусто.
function transitionSummary(scene, index, fps) {
  const transition = scene?.transition;
  if (index === 0 || !transition || transition.type === 'cut') return '';
  const frames = Number.isInteger(transition.frames) ? transition.frames : TRANSITION_FRAMES_25.default;
  const seconds = Number.isFinite(fps) && fps > 0 ? ref25(frames, fps) / fps : frames / 25;
  const parts = [transition.type, `${String(Math.round(seconds * 100) / 100).replace('.', ',')} с`];
  if (DIRECTED_TRANSITIONS.has(transition.type)) parts.push(DIRECTION_WORDS[transition.direction ?? 'left']);
  if (transition.type === 'push') parts.push('середина на границе');
  return `Вход: ${parts.join(', ')}`;
}

function formatMotionBriefMarkdown(brief) {
  const sceneRows = (brief.scenes || []).map((scene, index) => {
    const summary = [transitionSummary(scene, index, brief.output?.fps), sceneSummary(scene)].filter(Boolean).join('. ');
    return `| ${String(index + 1).padStart(2, '0')} | ${scene.scene} | ${clock(scene.start)}–${clock(scene.end)} | ${cell(summary)} |`;
  });
  return [
    `# Motion Reel: ${brief.title || 'VIDEO'}`,
    '',
    `Статус: \`${brief.status}\``,
    `Формат: \`${brief.output.aspect}\`, ${brief.output.width}x${brief.output.height}, ${brief.output.fps} FPS`,
    ...(brief.audioRole === 'music' ? ['Аудио: музыка без речи (источник – саундтрек)'] : []),
    '',
    '## Сцены',
    '',
    '| № | Сцена | Тайминг | Что на экране |',
    '|---:|---|---:|---|',
    ...sceneRows,
    '',
    'Рендер разрешён только после явного утверждения и смены статуса на `approved`.',
    '',
  ].join('\n');
}

module.exports = {
  MOTION_SCENES,
  MOTION_TRANSITION_TYPES,
  TRANSITION_FRAMES_25,
  buildDraftMotionProps,
  buildMotionProps,
  formatMotionBriefMarkdown,
  validateMotionBrief,
};
