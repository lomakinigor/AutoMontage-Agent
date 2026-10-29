import { useCurrentFrame, useVideoConfig } from 'remotion';
import { Odometer, formatNumber } from '../details/index.js';
import { SceneFrame, TextBox, useMotionStage } from './parts';
import { clamp01, motionTheme as t } from './motion-theme';

// Прокрутка 1,5 с + оседание 0,5 с; в короткой сцене обе части сжимаются, но к последнему кадру число стоит.
const rollTiming = (fps, durationInFrames) => {
  const total = Math.max(0, Math.min(2, (durationInFrames - 1) / fps));
  return { total, rollSec: total * 0.75, settleSec: total * 0.25 };
};

export const CounterScene = ({ label, value, prefix = '', suffix = '', layout = 'inline', caption, durationInFrames }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { total, rollSec, settleSec } = rollTiming(fps, durationInFrames);
  const progress = total <= 0 ? 1 : clamp01(frame / (total * fps));
  const stack = layout === 'stack';
  const { horizontal } = useMotionStage();
  const number = (height, maxSize) => <TextBox data-counter-value={formatNumber(value)} height={height} maxSize={maxSize} weight={800}
    style={{ color: t.accent, whiteSpace: 'nowrap', overflowWrap: 'normal' }}>
    <Odometer value={value} prefix={prefix} suffix={suffix} layout={layout} data-motion-text={null}
      affixColor={t.muted} rollSec={rollSec} settleSec={settleSec} />
  </TextBox>;
  const bar = <div aria-hidden="true" style={{ height: 14, background: t.line, borderRadius: 7 }}>
    <div style={{ width: `${progress * 100}%`, height: '100%', background: t.accent, borderRadius: 7 }} />
  </div>;
  if (horizontal) {
    // 16:9: число слева крупно (строка 220 px в блоке 300, вровень с подписью), подпись справа,
    // полоса прогресса под ними.
    const height = stack ? 560 : 300;
    return <SceneFrame caption={caption}>
      <div data-motion-layout="horizontal" style={{ display: 'flex', flexDirection: 'row', gap: 56, alignItems: 'center' }}>
        <div style={{ flex: '3 1 0', minWidth: 0 }}>{number(height, 220)}</div>
        <div style={{ flex: '2 1 0', minWidth: 0 }}><TextBox text={label} height={300} maxSize={72} weight={600} /></div>
      </div>
      {bar}
    </SceneFrame>;
  }
  return <SceneFrame caption={caption}>
    <TextBox text={label} height={260} maxSize={76} weight={600} />
    {number(stack ? 560 : 390, 190)}
    {bar}
  </SceneFrame>;
};
