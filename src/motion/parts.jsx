import { useLayoutEffect, useRef } from 'react';
import { cancelRender, continueRender, delayRender, useCurrentFrame, useVideoConfig } from 'remotion';
import { safeFor } from '../scenes/safezone';
import { Sheen, useTexture } from '../details/Texture.jsx';
import { sheenProgress } from '../details/texture.js';
import { motionTheme as t, motionPresets, revealProgress } from './motion-theme';

// Две сцены motion: вертикальная 1080×1920 и горизонтальная 1920×1080. Сцена выбирается по
// реальному кадру композиции (ширина больше высоты – горизонталь) и масштабируется к нему по
// короткой стороне: k = min(width, height) / 1080. Safe-зона и ширина содержимого – по сцене.
export const MOTION_STAGES = Object.freeze({
  vertical: Object.freeze({ width: 1080, height: 1920 }),
  horizontal: Object.freeze({ width: 1920, height: 1080 }),
});
export const stageFor = (width, height) => (width > height ? MOTION_STAGES.horizontal : MOTION_STAGES.vertical);
const contentWidthFor = (stage, safe) => stage.width - safe.left - safe.right;

// Прежние вертикальные константы: значения не меняются, вертикальные сцены и тесты на них опираются.
export const MOTION_WIDTH = MOTION_STAGES.vertical.width;
export const MOTION_HEIGHT = MOTION_STAGES.vertical.height;
const safe = safeFor(MOTION_WIDTH, MOTION_HEIGHT);
export const CONTENT_WIDTH = contentWidthFor(MOTION_STAGES.vertical, safe);

// Сцена текущей композиции для раскладки: {stage, safe, contentWidth, horizontal}.
export const useMotionStage = () => {
  const { width, height } = useVideoConfig();
  const stage = stageFor(width, height);
  const stageSafe = safeFor(stage.width, stage.height);
  return { stage, safe: stageSafe, contentWidth: contentWidthFor(stage, stageSafe), horizontal: stage === MOTION_STAGES.horizontal };
};

// Акцентная черта над safe-зоной и подпись внизу. В вертикали – прежние значения; в горизонтали
// верхнее поле SAFE_16x9 узкое, поэтому черта стоит по его центру, а подпись ниже (две строки
// на ширине 1760 вмещают тот же текст, что три строки на 880).
const ACCENT = { width: 70, height: 8 };
const CAPTION = { vertical: { height: 160 }, horizontal: { height: 120 } };
const accentTopFor = (stage, stageSafe) => (stage === MOTION_STAGES.horizontal
  ? (stageSafe.top - ACCENT.height) / 2
  : 175);

// Font fit uses the real bundled Cyrillic font, not a Latin character-width estimate.
// Wait for fit before capturing a frame. No clipping, truncation or omitted words.
export const TextBox = ({ text, children, height, maxSize = 64, weight = 600, style = {}, ...data }) => {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const handle = delayRender('Fit motion text');
    let cancelled = false;
    const fit = async () => {
      try {
        await document.fonts.load(`${weight} ${maxSize}px Onest`);
        if (cancelled || !ref.current) return;
        const el = ref.current;
        const computed = getComputedStyle(el);
        const availableHeight = el.clientHeight - parseFloat(computed.paddingTop) - parseFloat(computed.paddingBottom);
        let low = 1;
        let high = maxSize;
        while (high - low > 0.25) {
          const size = (low + high) / 2;
          el.style.fontSize = `${size}px`;
          const content = el.firstElementChild;
          const fits = content.scrollWidth <= el.clientWidth + 1
            && content.offsetHeight <= availableHeight;
          if (fits) low = size;
          else high = size;
        }
        el.style.fontSize = `${Math.floor(low * 4) / 4}px`;
      } catch (error) {
        if (!cancelled) cancelRender(error);
      } finally {
        continueRender(handle);
      }
    };
    fit();
    return () => { cancelled = true; continueRender(handle); };
  }, [text, height, maxSize, weight]);
  return <div ref={ref} data-motion-text="true" {...data} style={{
    width: '100%', height, flexShrink: 0, fontSize: maxSize, fontWeight: weight,
    lineHeight: 1.16, overflowWrap: 'anywhere', whiteSpace: 'normal', ...style,
  }}><div>{children ?? text}</div></div>;
};

export const useEntrance = (durationInFrames, index = 0, count = 1, spacingSec) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const progress = revealProgress(frame, fps, durationInFrames, index, count, spacingSec);
  return { opacity: progress, transform: `translateY(${(1 - progress) * motionPresets.risePx}px)` };
};

export const SceneFrame = ({ children, caption }) => {
  const { width, height } = useVideoConfig();
  const { stage, safe: stageSafe, contentWidth, horizontal } = useMotionStage();
  const scale = Math.min(width / stage.width, height / stage.height);
  return <div style={{ position: 'absolute', width: stage.width, height: stage.height,
    left: (width - stage.width * scale) / 2, top: (height - stage.height * scale) / 2,
    transform: `scale(${scale})`, transformOrigin: 'top left',
    color: t.ink, fontFamily: t.fontFamily,
  }}>
    <div aria-hidden="true" style={{ position: 'absolute', top: accentTopFor(stage, stageSafe), left: stageSafe.left, width: ACCENT.width, height: ACCENT.height, background: t.accent, borderRadius: 4 }} />
    <div data-motion-safe="true" style={{ position: 'absolute', top: stageSafe.top, left: stageSafe.left,
      width: contentWidth, height: stage.height - stageSafe.top - stageSafe.bottom,
      display: 'flex', flexDirection: 'column', gap: 30,
    }}>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 28 }}>{children}</div>
      {caption && <TextBox data-motion-caption="true" text={caption} height={CAPTION[horizontal ? 'horizontal' : 'vertical'].height} maxSize={34} weight={400}
        style={{ color: t.muted, borderTop: `2px solid ${t.line}`, paddingTop: 12, boxSizing: 'border-box' }} />}
    </div>
  </div>;
};

// Блик (subtle) есть в DOM только на свои 12 кадров при 25 fps. Вне прохода карточка та же, что при
// none: без блика, обёрток и лишнего position. В проходе карточка – свой контекст наложения
// (isolation), блик с z-index -1 лежит над её фоном и под контентом. children всегда во втором слоте,
// поэтому смена кадра не перемонтирует их.
export const Panel = ({ children, style = {}, sheenFrame = 0 }) => {
  const subtle = useTexture() === 'subtle';
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enterFrame = Math.round(sheenFrame);
  const sheen = subtle && sheenProgress(frame, fps, enterFrame) !== null;
  const background = style.background || t.panel;
  // Блик контрастирует с фоном карточки: на светлой панели акцентно-светлый, на акцентной белый.
  const sheenColor = background === t.panel ? t.accentSoft : t.panel;
  return <div style={{
    background: t.panel, borderRadius: t.radius, padding: 38, boxSizing: 'border-box',
    border: `1px solid ${t.line}`, ...(sheen ? { position: 'relative', isolation: 'isolate' } : {}), ...style,
  }}>{sheen ? <Sheen enterFrame={enterFrame} color={sheenColor} zIndex={-1} /> : null}{children}</div>;
};
