import { createContext, useContext, useLayoutEffect, useRef } from 'react';
import { continueRender, delayRender, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { motionTheme } from '../motion/motion-theme';
import { GRAIN_DATA_URI } from './grain-data.js';
import { DRIFT_COLOR_KEYS, DRIFT_OPACITY, GRAIN_OPACITY, GRAIN_TILE, driftAt, grainOffset, paintDrift, sheenProgress } from './texture.js';

// 'none' | 'subtle': Panel узнаёт режим отсюда и рисует блик только при subtle.
export const TextureContext = createContext('none');
export const useTexture = () => useContext(TextureContext);

const fill = { position: 'absolute', inset: 0, pointerEvents: 'none' };

// frame – явный кадр композиции. Фон сцены в режиме переходов лежит внутри sequence, где
// useCurrentFrame локальный; с глобальным кадром зерно и дрейф идут непрерывно через сцены и
// совпадают со слоем корня. Без frame – текущий кадр, как раньше.
const useTextureFrame = (frame) => {
  const current = useCurrentFrame();
  return frame ?? current;
};

// Зерно лежит под сценой и неподвижно (см. grainOffset). Рисовать только на тёмном фоне:
// на светлом его не видно, а файл тяжелеет.
export const Grain = ({ opacity = GRAIN_OPACITY, src = null, frame: absoluteFrame = null }) => {
  const frame = useTextureFrame(absoluteFrame);
  const { x, y } = grainOffset(frame);
  return <div aria-hidden="true" data-texture-grain="true" style={{ ...fill,
    backgroundImage: `url(${src ? staticFile(src) : GRAIN_DATA_URI})`, backgroundSize: `${GRAIN_TILE}px ${GRAIN_TILE}px`,
    backgroundPosition: `${-x}px ${-y}px`, opacity: Math.min(opacity, GRAIN_OPACITY),
  }} />;
};

// Медленный дрейф цветных пятен фона. Слой шире кадра на амплитуду, края не открываются.
// Пятна рисуются в canvas один раз (paintDrift, кеш на вкладку) и кладутся в <img>, по кадрам
// меняется только transform. CSS radial-gradient на весь кадр Chrome растеризует заново на каждом
// снимке кадра, это было +380 % ко времени рендера; картинка та же (сдвиг и пятна прежние).
// Именно <img>, а не сам canvas: canvas Chrome выносит в отдельный слой, и текст над ним теряет
// субпиксельное сглаживание (кадр отличался на краях букв до 94 из 255).
const driftImages = new Map();
export const Drift = ({ colors = DRIFT_COLOR_KEYS.map((key) => motionTheme[key]), amplitude = 0.06, frame: absoluteFrame = null }) => {
  const frame = useTextureFrame(absoluteFrame);
  const { fps, width, height } = useVideoConfig();
  const { x, y } = driftAt(frame, fps, { amplitude });
  const [first, second] = colors;
  const imgRef = useRef(null);
  useLayoutEffect(() => {
    const img = imgRef.current;
    if (!img || typeof document === 'undefined') return;
    // Размер слоя – из размеров кадра, а не offsetWidth: при монтировании (premount, скрытая
    // sequence) слой бывает нулевым, и дрейф пропадал. Плотность – как у кадра (scale рендера).
    const layerWidth = Math.round(width * (1 + 2 * amplitude));
    const layerHeight = Math.round(height * (1 + 2 * amplitude));
    const scale = window.devicePixelRatio || 1;
    const key = [first, second, layerWidth, layerHeight, scale].join('|');
    let src = driftImages.get(key);
    if (!src) {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext?.('2d');
      if (!ctx) return;
      canvas.width = Math.max(1, Math.round(layerWidth * scale));
      canvas.height = Math.max(1, Math.round(layerHeight * scale));
      paintDrift(ctx, { width: layerWidth, height: layerHeight, scale, colors: [first, second] });
      src = canvas.toDataURL('image/png');
      driftImages.set(key, src);
    }
    // Кадр снимается только после декодирования картинки, иначе дрейф может пропасть.
    const handle = delayRender('texture-drift');
    img.src = src;
    const done = () => continueRender(handle);
    if (img.decode) img.decode().then(done, done);
    else done();
  }, [first, second, amplitude, width, height]);
  const size = `${(1 + 2 * amplitude) * 100}%`;
  return <div aria-hidden="true" data-texture-drift="true" style={{ ...fill, overflow: 'hidden' }}>
    <img ref={imgRef} alt="" style={{ position: 'absolute', left: `${-amplitude * 100}%`, top: `${-amplitude * 100}%`,
      width: size, height: size,
      transform: `translate(${x * width}px, ${y * height}px)`,
      opacity: DRIFT_OPACITY,
    }} />
  </div>;
};

// Один проход по карточке на входе; вне прохода ничего не рисуется (не в цикле). zIndex -1 кладёт
// блик под контент родителя, если родитель – свой контекст наложения (так делает Panel).
export const Sheen = ({ enterFrame = 0, color = motionTheme.accentSoft, zIndex }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const progress = sheenProgress(frame, fps, enterFrame);
  if (progress === null) return null;
  return <div aria-hidden="true" data-texture-sheen="true" style={{ ...fill, overflow: 'hidden', borderRadius: 'inherit', ...(zIndex === undefined ? {} : { zIndex }) }}>
    <div style={{ position: 'absolute', top: 0, bottom: 0, width: '40%', left: `${-40 + 140 * progress}%`,
      background: `linear-gradient(100deg, transparent 0%, ${color} 50%, transparent 100%)`,
      opacity: 0.35, transform: 'skewX(-12deg)',
    }} />
  </div>;
};
