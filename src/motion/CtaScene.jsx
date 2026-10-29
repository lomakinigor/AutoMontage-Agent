import { SceneFrame, TextBox, Panel, useEntrance, useMotionStage } from './parts';
import { useVideoConfig } from 'remotion';
import { entranceDelay, motionTheme as t } from './motion-theme';

export const CtaScene = ({ title, action, handle, caption, durationInFrames }) => {
  const { fps } = useVideoConfig();
  const titleEntry = useEntrance(durationInFrames);
  const actionEntry = useEntrance(durationInFrames, 1, handle ? 3 : 2);
  const handleEntry = useEntrance(durationInFrames, 2, 3);
  const { horizontal } = useMotionStage();
  const sheenFrame = entranceDelay(fps, durationInFrames, 1, handle ? 3 : 2);
  const actionStyle = { background: t.accent, color: t.panel, borderColor: t.accent, ...actionEntry };
  if (horizontal) {
    // 16:9: призыв крупно слева, кнопка действия и контакт – правая колонка.
    return <SceneFrame caption={caption}>
      <div data-motion-layout="horizontal" style={{ display: 'flex', flexDirection: 'row', gap: 64, alignItems: 'center' }}>
        <div style={{ flex: '1 1 0', minWidth: 0 }}>
          <TextBox text={title} height={560} maxSize={96} weight={750} style={titleEntry} />
        </div>
        <div style={{ flex: '1 1 0', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 28 }}>
          <Panel sheenFrame={sheenFrame} style={actionStyle}>
            <TextBox text={action} height={260} maxSize={76} weight={650} />
          </Panel>
          {handle && <TextBox text={handle} height={180} maxSize={54} weight={500} style={{ color: t.muted, ...handleEntry }} />}
        </div>
      </div>
    </SceneFrame>;
  }
  return <SceneFrame caption={caption}>
    <TextBox text={title} height={310} maxSize={90} weight={750} style={titleEntry} />
    <Panel sheenFrame={sheenFrame} style={actionStyle}>
      <TextBox text={action} height={260} maxSize={76} weight={650} />
    </Panel>
    {handle && <TextBox text={handle} height={230} maxSize={54} weight={500} style={{ color: t.muted, ...handleEntry }} />}
  </SceneFrame>;
};
