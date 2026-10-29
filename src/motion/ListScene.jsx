import { SceneFrame, TextBox, useEntrance, useMotionStage } from './parts';
import { motionTheme as t } from './motion-theme';

const ListItem = ({ text, index, count, durationInFrames, textHeight = 128 }) => {
  const entry = useEntrance(durationInFrames, index, count);
  return <div style={{ display: 'flex', gap: 24, padding: '24px 28px', background: t.panel,
    borderRadius: 24, border: `1px solid ${t.line}`, ...entry,
  }}>
    <span style={{ color: t.accent, fontWeight: 750, fontSize: 32, paddingTop: 4 }}>{String(index + 1).padStart(2, '0')}</span>
    <div style={{ flex: 1, minWidth: 0 }}><TextBox text={text} height={textHeight} maxSize={46} weight={500} /></div>
  </div>;
};

// 16:9: при четырёх пунктах – две колонки (сетка 2×2), при меньшем числе – широкие строки.
const HorizontalList = ({ title, items, durationInFrames }) => {
  const twoColumns = items.length >= 4;
  return <>
    {title && <TextBox text={title} height={150} maxSize={70} weight={750} />}
    <div data-motion-layout="horizontal" style={{ display: 'grid', gap: 18,
      gridTemplateColumns: twoColumns ? 'repeat(2, minmax(0, 1fr))' : 'minmax(0, 1fr)',
    }}>
      {items.map((item, index) => <ListItem key={index} text={item} index={index} count={items.length}
        durationInFrames={durationInFrames} textHeight={twoColumns ? 200 : 128} />)}
    </div>
  </>;
};

export const ListScene = ({ title, items, caption, durationInFrames }) => {
  const { horizontal } = useMotionStage();
  if (horizontal) {
    return <SceneFrame caption={caption}><HorizontalList title={title} items={items} durationInFrames={durationInFrames} /></SceneFrame>;
  }
  return <SceneFrame caption={caption}>
    {title && <TextBox text={title} height={200} maxSize={70} weight={750} />}
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {items.map((item, index) => <ListItem key={index} text={item} index={index} count={items.length} durationInFrames={durationInFrames} />)}
    </div>
  </SceneFrame>;
};
