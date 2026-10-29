import React from 'react';
import {AbsoluteFill, interpolate, useCurrentFrame, Easing} from 'remotion';
// Путь верен после копирования пакета в projects/<id>/motion-vNN/src: четыре уровня вверх – корень движка.
import {FontStyle} from '../../../../src/fonts';
import {C, FONT, CHROME_MAX, WIDTH, HEIGHT} from './tokens';

export {C};
export const ease = (f, a, b, x = 0, y = 1, e = Easing.bezier(.22, 1, .36, 1)) =>
  interpolate(f, [a, b], [x, y], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: e});
export const lin = (f, a, b, x = 0, y = 1) =>
  interpolate(f, [a, b], [x, y], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
// Сид-рандом: частицы одинаковы в каждом рендере.
export const rnd = (i) => {const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453; return x - Math.floor(x);};

const CX = WIDTH / 2, CY = HEIGHT / 2;

export const Stage = ({children}) => (
  <AbsoluteFill style={{background: C.bg, color: C.ink, fontFamily: FONT.display, overflow: 'hidden'}}>
    <FontStyle/>{children}
  </AbsoluteFill>
);

// Удар: тряска камеры, затухающая за n кадров после каждого момента из hits.
export const shakeAt = (f, hits, amp = 26, n = 12) => {
  let x = 0, y = 0, r = 0;
  for (const h of hits) {
    const d = f - h;
    if (d >= 0 && d < n) {
      const k = (1 - d / n) ** 2;
      x += Math.sin(d * 2.9 + h) * amp * k;
      y += Math.cos(d * 3.7 + h) * amp * .7 * k;
      r += Math.sin(d * 2.1) * 1.2 * k;
    }
  }
  return `translate(${x}px,${y}px) rotate(${r}deg)`;
};
export const Shake = ({hits, amp, children}) => {
  const f = useCurrentFrame();
  return <AbsoluteFill style={{transform: shakeAt(f, hits, amp)}}>{children}</AbsoluteFill>;
};

// Вспышка на ударе: склейка без провала в чёрное.
export const Flash = ({at, dur = 8, color = '#FFF6E0', peak = .95}) => {
  const f = useCurrentFrame();
  const o = f < at ? 0 : lin(f, at, at + dur, peak, 0);
  return o > 0 ? <AbsoluteFill style={{background: color, opacity: o, mixBlendMode: 'screen'}}/> : null;
};

// Кольцевая ударная волна из точки (x, y).
export const Shockwave = ({at, x = CX, y = CY, color = C.gold, size = 2600, dur = 22}) => {
  const f = useCurrentFrame();
  if (f < at || f > at + dur) return null;
  const p = ease(f, at, at + dur, 0, 1, Easing.out(Easing.cubic));
  const d = size * p;
  return <>
    <div style={{position: 'absolute', left: x - d / 2, top: y - d / 2, width: d, height: d, borderRadius: '50%', border: `${40 * (1 - p) + 3}px solid ${color}`, opacity: 1 - p, filter: `blur(${4 + 10 * p}px)`, boxShadow: `0 0 80px ${color}, inset 0 0 80px ${color}`}}/>
    <div style={{position: 'absolute', left: x - d * .35, top: y - d * .35, width: d * .7, height: d * .7, borderRadius: '50%', border: '4px solid #FFFFFF', opacity: (1 - p) * .7, filter: 'blur(2px)'}}/>
  </>;
};

// Сноп искр: летят из точки, тянут хвост по скорости, падают под гравитацией.
export const Sparks = ({at, x = CX, y = CY, n = 90, speed = 38, seed = 1, color = C.goldHot, life = 34}) => {
  const f = useCurrentFrame();
  const t = f - at;
  if (t < 0 || t > life) return null;
  return <>{Array.from({length: n}).map((_, i) => {
    const a = rnd(i * 3 + seed) * Math.PI * 2, v = speed * (.35 + rnd(i * 7 + seed) * .9);
    const vx = Math.cos(a) * v, vy = Math.sin(a) * v - 8;
    const px = x + vx * t * (1 - t / (life * 2.2)), py = y + vy * t + 0.9 * t * t * .5;
    const ang = Math.atan2(vy + 0.9 * t, vx) * 180 / Math.PI;
    const len = 10 + v * .9 * (1 - t / life);
    const o = (1 - t / life) * (t < 2 ? t / 2 : 1);
    return <div key={i} style={{position: 'absolute', left: px, top: py, width: len, height: 3, borderRadius: 2, background: `linear-gradient(90deg,transparent,${color})`, transform: `rotate(${ang}deg)`, transformOrigin: 'right center', opacity: o, boxShadow: `0 0 10px ${C.gold}`}}/>;
  })}</>;
};

// Медленно всплывающие угольки на фоне.
export const Embers = ({n = 40, seed = 5}) => {
  const f = useCurrentFrame();
  return <>{Array.from({length: n}).map((_, i) => {
    const x = rnd(i + seed) * WIDTH + Math.sin(f / 30 + i) * 30;
    const y = HEIGHT - ((f * (1.5 + rnd(i * 2 + seed) * 3) + rnd(i * 5 + seed) * HEIGHT) % (HEIGHT + 180));
    const s = 2 + rnd(i * 9 + seed) * 4;
    return <div key={i} style={{position: 'absolute', left: x, top: y, width: s, height: s, borderRadius: '50%', background: C.goldHot, boxShadow: `0 0 ${8 + s * 2}px ${C.ember}`, opacity: .35 + .5 * rnd(i * 11 + seed)}}/>;
  })}</>;
};

// Кинематографичные шторки и виньетка.
export const Letterbox = ({h = 96}) => <>
  <div style={{position: 'absolute', left: 0, right: 0, top: 0, height: h, background: '#000'}}/>
  <div style={{position: 'absolute', left: 0, right: 0, bottom: 0, height: h, background: '#000'}}/>
  <AbsoluteFill style={{background: 'radial-gradient(ellipse at center,transparent 55%,rgba(0,0,0,.65) 100%)'}}/>
</>;

// Анаморфный блик: горизонтальная полоса света через кадр.
export const Flare = ({at, dur = 24, y = CY, color = C.cyan}) => {
  const f = useCurrentFrame();
  if (f < at || f > at + dur) return null;
  const p = lin(f, at, at + dur);
  const o = Math.sin(Math.PI * p);
  return <>
    <div style={{position: 'absolute', left: -200, right: -200, top: y - 3, height: 6, background: `linear-gradient(90deg,transparent,${color},#fff,${color},transparent)`, opacity: o, filter: 'blur(2px)', transform: `translateX(${(p - .5) * 300}px) scaleX(${.6 + .6 * o})`}}/>
    <div style={{position: 'absolute', left: CX - 180 + (p - .5) * 300, top: y - 180, width: 360, height: 360, borderRadius: '50%', background: `radial-gradient(circle,rgba(255,255,255,.9),${color}55 30%,transparent 65%)`, opacity: o, mixBlendMode: 'screen'}}/>
  </>;
};

// Хромированный текст с пробегающим бликом и RGB-расслоением в момент удара.
// Одна строка (nowrap): при ширине 1080 размер не больше CHROME_MAX = 112 px, иначе текст вылезет за кадр.
export const Chrome = ({children, size = 112, sweep = 0, split = 0, weight = 900, spacing = -2, style = {}}) => {
  const base = {fontFamily: FONT.display, fontWeight: weight, fontSize: Math.min(size, CHROME_MAX), letterSpacing: spacing, lineHeight: 1.02, whiteSpace: 'nowrap', textAlign: 'center'};
  const pos = -60 + sweep * 220;
  return <div style={{position: 'relative', ...style}}>
    {split > 0 ? <>
      <div style={{...base, position: 'absolute', inset: 0, color: '#FF2A4A', opacity: .75, transform: `translateX(${-split}px)`, mixBlendMode: 'screen'}}>{children}</div>
      <div style={{...base, position: 'absolute', inset: 0, color: C.cyan, opacity: .75, transform: `translateX(${split}px)`, mixBlendMode: 'screen'}}>{children}</div>
    </> : null}
    <div style={{...base, position: 'relative', backgroundImage: `linear-gradient(105deg,#6E6A63 0%,#F6F2EA 18%,#8C877E 34%,#2B2925 48%,#D9D3C7 62%,#FFFFFF ${Math.max(63, pos)}%,#FFE2A0 ${pos + 6}%,#7A746A 86%,#F4EFE6 100%)`, WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent', filter: 'drop-shadow(0 0 18px rgba(255,178,63,.55)) drop-shadow(0 6px 0 rgba(0,0,0,.6))'}}>{children}</div>
  </div>;
};

// Трейлерная надпись: врезается с увеличения, держится, рассыпается расфокусом.
export const Slam = ({at, out, children, size = 96, y = 1380}) => {
  const f = useCurrentFrame();
  if (f < at || f > out + 8) return null;
  const s = ease(f, at, at + 7, 1.9, 1, Easing.out(Easing.exp));
  const o = Math.min(lin(f, at, at + 3), lin(f, out, out + 8, 1, 0));
  return <div style={{position: 'absolute', left: 0, right: 0, top: y, display: 'flex', justifyContent: 'center', transform: `scale(${s})`, opacity: o, filter: `blur(${lin(f, out, out + 8, 0, 14)}px)`}}>
    <Chrome size={size} sweep={lin(f, at, out, 0, 1)} split={lin(f, at, at + 6, 14, 0)} spacing={4}>{children}</Chrome>
  </div>;
};

// Спокойный вариант перехода: сцены перекрываются на outF кадров, уходящая размывается,
// новая проявляется поверх – без провала в чёрное. Гаснет в ноль только последняя (fadeOut).
export const BlurPass = ({children, dur, inF = 9, outF = 9, fadeOut = false}) => {
  const f = useCurrentFrame();
  const bIn = ease(f, 0, inF, 22, 0), bOut = ease(f, dur - outF, dur, 0, 22);
  const o = Math.min(ease(f, 0, inF), fadeOut ? ease(f, dur - outF, dur, 1, 0) : 1);
  const s = ease(f, 0, dur, 1.04, 1, Easing.linear);
  return <AbsoluteFill style={{filter: `blur(${bIn + bOut}px)`, opacity: o, transform: `scale(${s})`}}>{children}</AbsoluteFill>;
};
