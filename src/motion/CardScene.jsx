import { SceneFrame, TextBox, Panel, useEntrance, useMotionStage } from './parts';
import { motionTheme as t } from './motion-theme';

// 16:9: карточка – две колонки, заголовок слева, текст справа; без текста заголовок на всю ширину.
const HorizontalCard = ({ title, body, entry, bodyEntry }) => <Panel style={entry}>
  <div data-motion-layout="horizontal" style={{ display: 'flex', flexDirection: 'row', gap: 64, alignItems: 'flex-start' }}>
    <div data-motion-column="title" style={{ flex: body ? '0 0 640px' : 1, minWidth: 0 }}>
      <div style={{ height: 8, width: 80, background: t.accent, borderRadius: 4, marginBottom: 30 }} />
      <TextBox text={title} height={body ? 520 : 400} maxSize={body ? 80 : 96} weight={750} />
    </div>
    {body && <div data-motion-column="body" style={{ flex: 1, minWidth: 0, ...bodyEntry }}>
      <TextBox text={body} height={560} maxSize={52} weight={400} style={{ color: t.muted }} />
    </div>}
  </div>
</Panel>;

export const CardScene = ({ title, body, caption, durationInFrames }) => {
  const entry = useEntrance(durationInFrames);
  const bodyEntry = useEntrance(durationInFrames, 1, 2);
  const { horizontal } = useMotionStage();
  if (horizontal) {
    return <SceneFrame caption={caption}>
      <HorizontalCard title={title} body={body} entry={entry} bodyEntry={bodyEntry} />
    </SceneFrame>;
  }
  return <SceneFrame caption={caption}>
    <Panel style={entry}>
      <div style={{ height: 8, width: 80, background: t.accent, borderRadius: 4, marginBottom: 30 }} />
      <TextBox text={title} height={260} maxSize={80} weight={750} />
      {body && <TextBox text={body} height={480} maxSize={52} weight={400} style={{ color: t.muted, marginTop: 32, ...bodyEntry }} />}
    </Panel>
  </SceneFrame>;
};
