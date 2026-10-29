import { useCurrentFrame, useVideoConfig } from 'remotion';
import { formatNumber, odometerColumns, odometerProgress, odometerRolled } from './odometer.js';

const LINE = 1.16;
const STRIP = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0];

const stripShift = (column) => {
  const position = (((Number(column.char) + column.offset) % 10) + 10) % 10;
  return `translateY(${-position * LINE}em)`;
};

// Итоговая строка лежит в потоке всегда (ширина не прыгает); барабан рисуется поверх,
// только пока цифры крутятся. В покое на экране ровно утверждённая строка.
export const Odometer = ({
  value, prefix = '', suffix = '', decimals, locale = 'ru', layout = 'inline',
  fontSize, color, affixColor, rollSec = 1.5, settleSec, delayFrames = 0,
  'data-motion-text': motionText = 'true', style = {}, ...rest
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const finalText = formatNumber(value, { decimals, locale });
  const progress = odometerProgress(frame, fps, { rollSec, settleSec, delayFrames });
  const rolled = odometerRolled(frame, fps, { rollSec, delayFrames });
  const rolling = progress !== 1;
  const stack = layout === 'stack';
  const affix = { color: affixColor, whiteSpace: 'pre' };
  const root = {
    display: 'flex', flexDirection: stack ? 'column' : 'row', alignItems: stack ? 'flex-start' : 'baseline',
    fontSize, color, fontVariantNumeric: 'tabular-nums', lineHeight: LINE, whiteSpace: 'nowrap', ...style,
  };
  return <div data-motion-text={motionText} data-counter-value={finalText} data-odometer-layout={layout} style={root} {...rest}>
    {prefix && <span style={{ ...affix, ...(stack ? { fontSize: '0.28em' } : {}) }}>{prefix}</span>}
    <span style={{ position: 'relative', display: 'inline-block' }}>
      <span data-odometer-sizer="true" style={{ visibility: rolling ? 'hidden' : 'visible' }}>{finalText}</span>
      {rolling && <span aria-hidden="true" data-odometer-roll="true"
        style={{ position: 'absolute', left: 0, top: 0, display: 'inline-flex' }}>
        {odometerColumns(finalText, progress, { rolled }).map((column, index) => column.digit
          ? <span key={index} style={{ display: 'inline-block', height: `${LINE}em`, overflow: 'hidden' }}>
            <span style={{ display: 'flex', flexDirection: 'column', transform: stripShift(column) }}>
              {STRIP.map((digit, cell) => <span key={cell} style={{ height: `${LINE}em` }}>{digit}</span>)}
            </span>
          </span>
          : <span key={index} style={{ whiteSpace: 'pre' }}>{column.char}</span>)}
      </span>}
    </span>
    {suffix && <span style={{ ...affix, ...(stack ? { fontSize: '0.3em' } : {}) }}>{suffix}</span>}
  </div>;
};
