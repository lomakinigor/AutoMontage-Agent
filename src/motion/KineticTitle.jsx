import { useCurrentFrame, useVideoConfig } from 'remotion';
import { SceneFrame, TextBox, useEntrance, useMotionStage } from './parts';
import { motionTheme as t, revealProgress } from './motion-theme';

export const KineticTitle = ({ text, emphasis, caption, durationInFrames }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const words = text.split(/(\s+)/);
  const wordCount = words.filter((word) => word.trim()).length;
  let index = 0;
  const emphasisStart = emphasis ? text.indexOf(emphasis) : -1;
  let offset = 0;
  const line = useEntrance(durationInFrames, 1, 2);
  const { horizontal } = useMotionStage();
  // 16:9: заголовок крупно на всю ширину сцены; высота блока – под поле 16:9 с подписью.
  const box = horizontal ? { height: 620, maxSize: 128 } : { height: 760, maxSize: 112 };
  const layout = horizontal ? { 'data-motion-layout': 'horizontal' } : {};
  return <SceneFrame caption={caption}>
    <TextBox text={text} height={box.height} maxSize={box.maxSize} weight={750} {...layout}>
      {words.map((word, key) => {
        const begin = offset;
        offset += word.length;
        if (!word.trim()) return word;
        const progress = revealProgress(frame, fps, durationInFrames, index++, wordCount, 0.22);
        const accented = emphasisStart >= 0 && begin < emphasisStart + emphasis.length && offset > emphasisStart;
        return <span key={key} style={{ opacity: progress, color: accented ? t.accent : t.ink }}>{word}</span>;
      })}
    </TextBox>
    <div aria-hidden="true" style={{ height: 12, background: t.accent, width: 160, borderRadius: 6, ...line }} />
  </SceneFrame>;
};
