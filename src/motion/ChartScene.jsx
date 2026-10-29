import { Chart } from '../details/index.js';
import { CONTENT_WIDTH, Panel, SceneFrame, TextBox, useMotionStage } from './parts';
import { motionTheme as t } from './motion-theme';

const PANEL_PADDING = 38;
const CHART_HEIGHT = 700;
// 16:9: график на всю ширину сцены и ниже, заголовок короче по высоте – всё помещается с подписью.
const HORIZONTAL = { chartHeight: 520, titleHeight: 150 };

// Значения и подписи берутся из ТЗ дословно; цвета и шрифт – из motionTheme.
export const ChartScene = ({ title, chartType = 'bar', points, unit, highlight, caption, durationInFrames }) => {
  const { horizontal, contentWidth } = useMotionStage();
  const chart = (width, height) => <Chart points={points} chartType={chartType} unit={unit} highlight={highlight}
    theme={t} width={width - PANEL_PADDING * 2} height={height}
    durationInFrames={durationInFrames} />;
  if (horizontal) {
    return <SceneFrame caption={caption}>
      <TextBox text={title} height={HORIZONTAL.titleHeight} maxSize={64} weight={700} />
      <div data-motion-layout="horizontal">
        <Panel style={{ padding: PANEL_PADDING }}>{chart(contentWidth, HORIZONTAL.chartHeight)}</Panel>
      </div>
    </SceneFrame>;
  }
  return <SceneFrame caption={caption}>
    <TextBox text={title} height={220} maxSize={64} weight={700} />
    <Panel style={{ padding: PANEL_PADDING }}>{chart(CONTENT_WIDTH, CHART_HEIGHT)}</Panel>
  </SceneFrame>;
};
