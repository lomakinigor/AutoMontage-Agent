import { useCurrentFrame, useVideoConfig } from 'remotion';
import { evolvePath } from '@remotion/paths';
import { formatNumber } from './odometer.js';
import { barGrowth, barShape, barToLine, barToLineStart, chartLayout, DOT_SIZE, dotShape, lineProgress, linePath } from './chart.js';

const VALUE_ROW = 56;
const LABEL_ROW = 130;
const UNIT_ROW = 44;
const BASE_WIDTH = 4;

const baseSize = (count) => (count <= 3 ? 34 : count <= 5 ? 28 : 22);
const fitSize = (size, slot, chars) => Math.max(12, Math.min(size, Math.floor(slot / (Math.max(1, chars) * 0.62))));

// Цвета и шрифт – только из пропса theme (для motion-reel это motionTheme). Подписи и значения лежат
// отдельными HTML-блоками с data-motion-text (маркер на внешнем блоке, текст во внутреннем div,
// как у TextBox), SVG рисует только фигуры.
export const Chart = ({
  points, chartType = 'bar', unit, highlight, theme = {}, width = 800, height = 600,
  startFrame = 0, durationInFrames, locale = 'ru', decimals,
}) => {
  const frame = useCurrentFrame() - startFrame;
  const { fps } = useVideoConfig();
  const { accent = 'currentColor', ink = 'currentColor', muted = 'currentColor', fontFamily } = theme;
  const header = unit ? UNIT_ROW : 0;
  const plotHeight = Math.max(0, height - header);
  const layout = chartLayout(points, {
    width, height: plotHeight, padding: { top: VALUE_ROW, bottom: LABEL_ROW },
  });
  const { bars, baseline } = layout;
  const slot = points.length ? width / points.length : width;
  const withLine = chartType !== 'bar';
  const morph = chartType === 'bar-to-line'
    ? barToLine(frame, fps, barToLineStart(points.length, fps, { durationInFrames }))
    : { barScale: 0, lineProgress: lineProgress(frame, fps, 0) };
  const hasHighlight = Number.isInteger(highlight);
  const colorOf = (index) => (!hasHighlight || index === highlight ? accent : muted);
  const size = baseSize(points.length);
  const growth = bars.map((_, index) => barGrowth(frame, fps, index));
  const drawn = withLine ? linePath(bars) : '';
  const evolved = withLine && morph.lineProgress > 0 ? evolvePath(morph.lineProgress, drawn) : null;
  const dotsOnly = chartType === 'line' || (chartType === 'bar-to-line' && morph.barScale === 0);

  return <div data-chart-type={chartType} data-chart-highlight={hasHighlight ? String(highlight) : undefined}
    style={{ width, height, fontFamily, color: ink, position: 'relative' }}>
    {unit && <div data-motion-text="true" data-chart-unit="true" style={{
      height: UNIT_ROW, fontSize: 28, lineHeight: 1.16, color: muted, whiteSpace: 'nowrap',
    }}><div>{unit}</div></div>}
    <div style={{ position: 'relative', width, height: plotHeight }}>
      <svg width={width} height={plotHeight} viewBox={`0 0 ${width} ${plotHeight}`}
        style={{ position: 'absolute', left: 0, top: 0 }}>
        {bars.map((bar, index) => {
          if (dotsOnly) {
            const dot = dotShape(bar, growth[index]);
            return <circle key={index} data-chart-dot="true" cx={dot.cx} cy={dot.cy} r={dot.r}
              fill={colorOf(index)} />;
          }
          const shape = barShape(bar, {
            growth: growth[index], baseline, scale: chartType === 'bar-to-line' ? morph.barScale : 1,
          });
          return <rect key={index} data-chart-bar="true" x={shape.x} y={shape.y}
            width={Math.max(0, shape.width)} height={Math.max(0, shape.height)}
            rx={Math.max(0, shape.rx)} fill={colorOf(index)} />;
        })}
        <line data-chart-baseline="true" x1="0" x2={width} y1={baseline + BASE_WIDTH / 2} y2={baseline + BASE_WIDTH / 2}
          stroke={ink} strokeWidth={BASE_WIDTH} strokeLinecap="round" />
        {evolved && <path data-chart-line="true" d={drawn} fill="none" stroke={accent} strokeWidth={6}
          strokeLinecap="round" strokeLinejoin="round" strokeDasharray={evolved.strokeDasharray}
          strokeDashoffset={evolved.strokeDashoffset} />}
      </svg>
      {bars.map((bar, index) => {
        const valueText = formatNumber(bar.value, { decimals, locale });
        const valueSize = fitSize(size, slot, valueText.length);
        const labelSize = fitSize(size, slot, Math.ceil(String(bar.label).length / 3));
        return <div key={index}>
          <div data-motion-text="true" data-chart-value="true" style={{
            position: 'absolute', left: bar.x + bar.w / 2 - slot / 2, width: slot, textAlign: 'center',
            top: bar.y - valueSize * 1.16 - (chartType === 'bar' ? 12 : DOT_SIZE / 2 + 4), fontSize: valueSize, lineHeight: 1.16, whiteSpace: 'nowrap',
            fontVariantNumeric: 'tabular-nums', fontWeight: index === highlight ? 800 : 600,
            color: index === highlight ? accent : ink, opacity: growth[index],
          }}><div>{valueText}</div></div>
          <div data-motion-text="true" data-chart-label="true" style={{
            position: 'absolute', left: bar.x + bar.w / 2 - slot / 2, width: slot, top: baseline + BASE_WIDTH + 12,
            textAlign: 'center', fontSize: labelSize, lineHeight: 1.16, overflowWrap: 'anywhere',
            color: muted, boxSizing: 'border-box', padding: '0 4px',
          }}><div>{bar.label}</div></div>
        </div>;
      })}
    </div>
  </div>;
};
