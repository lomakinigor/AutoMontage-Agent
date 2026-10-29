// Математика одометра: форматирование числа, столбцы-разряды и ритм прокрутки. Без React и тем.
const NBSP = ' ';
const DIGIT = /[0-9]/;
const SETTLE_SEC = 0.5;
const OVERSHOOT = 0.2;

const clamp01 = (value) => Math.max(0, Math.min(1, value));
const easeOut = (value) => 1 - (1 - clamp01(value)) ** 3;

// Сколько знаков после запятой в записи самого числа (в том числе у 1e-7).
const naturalDecimals = (value) => {
  const [mantissa, exponent] = String(Math.abs(value)).split('e');
  const fraction = (mantissa.split('.')[1] || '').length;
  return Math.max(0, Math.min(20, fraction - Number(exponent || 0)));
};

// ru: разряды U+00A0, десятичная запятая; остальные локали: запятая и точка.
export const formatNumber = (value, { decimals, locale = 'ru' } = {}) => {
  if (!Number.isFinite(value) || Math.abs(value) >= 1e21) return String(value);
  const places = decimals ?? naturalDecimals(value);
  const [whole, fraction] = Math.abs(value).toFixed(places).split('.');
  const russian = locale === 'ru';
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, russian ? NBSP : ',');
  const sign = value < 0 && Number(`${whole}.${fraction || 0}`) !== 0 ? '-' : '';
  return `${sign}${grouped}${fraction ? `${russian ? ',' : '.'}${fraction}` : ''}`;
};

// offset в высотах цифры: 0 – стоит на итоговой цифре. Младшие разряды делают больше оборотов.
// До прокрутки (progress 0) каждая цифра показывает 0, при progress > 1 – лёгкий перелёт вперёд.
export const odometerColumns = (finalText, progress, { rolled = false } = {}) => {
  const chars = [...finalText];
  let seen = 0;
  return chars.map((char) => {
    if (!DIGIT.test(char)) return { char, digit: false, offset: 0 };
    const turns = 1 + Math.min(seen, 9);
    seen += 1;
    const travel = 10 * turns + Number(char);
    // После прокрутки (rolled) все цифры качаются одинаково на (progress - 1), в обе стороны.
    const offset = rolled || progress >= 1 ? progress - 1 : -travel * (1 - Math.max(0, progress));
    return { char, digit: true, offset };
  });
};

// Прокрутка закончилась: дальше только пружина успокоения, без обратного движения разрядов.
export const odometerRolled = (frame, fps, { rollSec = 1.5, delayFrames = 0 } = {}) =>
  rollSec <= 0 || (frame - delayFrames) / fps >= rollSec;

export const odometerProgress = (frame, fps, { rollSec = 1.5, settleSec = SETTLE_SEC, delayFrames = 0 } = {}) => {
  if (rollSec <= 0) return 1;
  const time = (frame - delayFrames) / fps;
  if (time <= 0) return 0;
  if (time < rollSec) return easeOut(time / rollSec);
  const settle = settleSec > 0 ? (time - rollSec) / settleSec : 1;
  if (settle >= 1) return 1;
  // Затухающая пружина: перелёт до 0,12, дальше строго к 1.
  return 1 + OVERSHOOT * Math.sin(2 * Math.PI * settle) * (1 - settle) ** 2;
};
