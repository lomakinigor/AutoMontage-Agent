import { useCurrentFrame, useVideoConfig } from 'remotion';
import { SceneFrame, TextBox, useMotionStage } from './parts';
import { motionTheme as t, revealProgress } from './motion-theme';

export const stepState = (frame, fps, durationInFrames, count) => {
  const progress = (index) => revealProgress(frame, fps, durationInFrames, index, count * 2 - 1, 0.9);
  return {
    nodes: Array.from({ length: count }, (_, index) => progress(index * 2)),
    connectors: Array.from({ length: count - 1 }, (_, index) => progress(index * 2 + 1)),
  };
};

const NODE = 66;

// 16:9: шаги – горизонтальная цепочка слева направо. Соединитель идёт от кружка шага к следующему
// и растёт по ширине; карточка шага стоит под своим кружком.
const HorizontalSteps = ({ title, steps, state }) => <>
  {title && <TextBox text={title} height={170} maxSize={70} weight={750} />}
  <div data-motion-layout="horizontal" style={{ display: 'flex', flexDirection: 'row', gap: 24 }}>
    {steps.map((step, index) => <div key={index} style={{ position: 'relative', flex: 1, minWidth: 0 }}>
      <div data-step-node={index} style={{ display: 'flex', flexDirection: 'column', gap: 20, opacity: state.nodes[index] }}>
        <div style={{ width: NODE, height: NODE, flexShrink: 0, borderRadius: '50%', background: t.accent,
          color: t.panel, display: 'flex', justifyContent: 'center', alignItems: 'center', fontSize: 30, fontWeight: 700,
        }}>{index + 1}</div>
        <div style={{ padding: '20px 26px', background: t.panel, borderRadius: 24, border: `1px solid ${t.line}` }}>
          <TextBox text={step} height={300} maxSize={44} />
        </div>
      </div>
      {index < steps.length - 1 && <div data-step-connector={index + 1} style={{ position: 'absolute',
        top: (NODE - 4) / 2, left: NODE + 20, right: -4, height: 4,
        background: t.accent, transform: `scaleX(${state.connectors[index]})`, transformOrigin: 'left',
      }} />}
    </div>)}
  </div>
</>;

export const StepsScene = ({ title, steps, caption, durationInFrames }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const state = stepState(frame, fps, durationInFrames, steps.length);
  const { horizontal } = useMotionStage();
  if (horizontal) {
    return <SceneFrame caption={caption}><HorizontalSteps title={title} steps={steps} state={state} /></SceneFrame>;
  }
  return <SceneFrame caption={caption}>
    {title && <TextBox text={title} height={210} maxSize={70} weight={750} />}
    <div>{steps.map((step, index) => <div key={index}>
      {index > 0 && <div data-step-connector={index} style={{ height: 42, width: 4, marginLeft: 31,
        background: t.accent, transform: `scaleY(${state.connectors[index - 1]})`, transformOrigin: 'top',
      }} />}
      <div data-step-node={index} style={{ display: 'flex', alignItems: 'center', gap: 24, opacity: state.nodes[index] }}>
        <div style={{ width: 66, height: 66, flexShrink: 0, borderRadius: '50%', background: t.accent,
          color: t.panel, display: 'flex', justifyContent: 'center', alignItems: 'center', fontSize: 30, fontWeight: 700,
        }}>{index + 1}</div>
        <div style={{ flex: 1, minWidth: 0, padding: '20px 26px', background: t.panel, borderRadius: 24, border: `1px solid ${t.line}` }}>
          <TextBox text={step} height={112} maxSize={48} />
        </div>
      </div>
    </div>)}</div>
  </SceneFrame>;
};
