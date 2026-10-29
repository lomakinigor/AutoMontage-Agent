// ДНК дизайна пакета. Меняй под ролик: палитру, шрифты, размеры. Файл без импортов –
// render.cjs читает отсюда TOTAL и размеры кадра.

// Длина ролика в кадрах = durationInFrames scaffold brief (= кадры саундтрека).
export const TOTAL = 690;
export const FPS = 30;
// Формат пакета: 'vertical' 1080×1920 (по умолчанию) или 'horizontal' 1920×1080. Должен совпадать
// с output.aspect scaffold brief (automontage motion --aspect); render.cjs --aspect сверяет выбор.
export const ASPECT = 'vertical';
export const WIDTH = ASPECT === 'horizontal' ? 1920 : 1080;
export const HEIGHT = ASPECT === 'horizontal' ? 1080 : 1920;

// Палитра «Блокбастер»: чёрный, расплавленное золото, холодный электрический циан.
export const C = {
  bg: '#050608',
  ink: '#F4F1EA',
  gold: '#FFB23F',
  goldHot: '#FFE6A8',
  ember: '#FF6A1A',
  cyan: '#5FE3FF',
  muted: '#8B8F96',
};

// Шрифты движка с кириллицей (FontStyle из src/fonts движка).
export const FONT = { display: 'Onest', mono: 'JetBrains Mono' };

// Хромированный текст пишется одной строкой: при ширине 1080 не больше 112 px (у 16:9 ширина больше, но строка та же).
export const CHROME_MAX = 112;

// Безопасная зона: у 9:16 важное держи между 260 и 1500 px (низ закрывают элементы площадок),
// у 16:9 – SAFE_16x9 движка: поля сверху и снизу по 60 px, по бокам по 80 px.
export const SAFE = ASPECT === 'horizontal' ? { top: 60, bottom: 1020, side: 80 } : { top: 260, bottom: 1500, side: 80 };
