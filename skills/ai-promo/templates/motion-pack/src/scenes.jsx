import React from 'react';
import {AbsoluteFill, OffthreadVideo, staticFile, useCurrentFrame} from 'remotion';
import {C, ease, lin, rnd, Stage, Shake, Flash, Shockwave, Sparks, Embers, Letterbox, Flare, Chrome, Slam} from './fx';
import {FONT, WIDTH, HEIGHT} from './tokens';

// Все тексты по умолчанию – заглушки. Замени их строками из согласованной копии (copy.md);
// ничего не выдумывай. Время внутри сцены – локальные кадры от её начала.
// dur сцене передаёт Promo из PLAN. Доли сцены (hit, capAt, capOut, stepsAt, stepGap, press,
// fill, swapAt) – числа от 0 до 1 от её длительности: при смене dur удары сдвигаются сами.
// Эффекты сразу после склейки (sparksAt, waveAt) – кадры от начала сцены.

const CX = WIDTH / 2, CY = HEIGHT / 2;
const at = (share, dur) => Math.round(share * dur);

// Заголовок: из темноты и искр собирается хромированная надпись, удар на кадре hit.
export const Forge = ({title = 'ВАШ ПРОДУКТ', dur = 90, hit: hitShare = 0.93}) => {
  const f = useCurrentFrame();
  const hit = at(hitShare, dur);
  const conv = ease(f, 0, hit - 14);
  const reveal = ease(f, hit - 44, hit - 4);
  return <Stage>
    <AbsoluteFill style={{background: `radial-gradient(circle at 50% 50%,rgba(255,106,26,${.14 + .16 * conv}),transparent 55%)`}}/>
    <Shake hits={[hit]} amp={34}>
      {Array.from({length: 120}).map((_, i) => {
        const a = rnd(i) * Math.PI * 2, d = 300 + rnd(i + 50) * 900;
        const tx = (rnd(i + 7) - .5) * 820, ty = (rnd(i + 13) - .5) * 120;
        const x = CX + Math.cos(a + f / 40) * d * (1 - conv) + tx * conv;
        const y = CY + Math.sin(a + f / 40) * d * (1 - conv) + ty * conv;
        return <div key={i} style={{position: 'absolute', left: x, top: y, width: 3, height: 3 + rnd(i) * 4, borderRadius: 2, background: C.goldHot, boxShadow: `0 0 12px ${C.ember}`, opacity: lin(f, 0, 10) * (1 - lin(f, hit - 14, hit))}}/>;
      })}
      <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center'}}>
        <div style={{opacity: reveal, filter: `blur(${(1 - reveal) * 20}px)`, transform: `scale(${1.25 - .25 * reveal + lin(f, hit, hit + 6, 0, .04)})`}}>
          <Chrome size={112} sweep={lin(f, hit - 34, hit + 6)} split={f >= hit ? lin(f, hit, hit + 8, 22, 0) : 0} spacing={ease(f, hit - 44, hit, 16, -1)}>{title}</Chrome>
        </div>
      </AbsoluteFill>
      <Flare at={hit - 14} dur={20} color={C.gold}/>
      <Sparks at={hit} n={110} speed={46} seed={3}/>
      <Shockwave at={hit}/>
    </Shake>
    <Flash at={hit} dur={9}/>
    <Letterbox/>
  </Stage>;
};

// Сгенерированный кинокадр: удар на входе, угольки, искры, волна и трейлерная надпись.
// Клип всегда muted: звук ролика – только саундтрек. Клип не короче сцены (trim + dur).
export const Shot = ({src, dur = 120, caption, capAt = 0.1, capOut = null, trim = 0, punch = true, sparksAt = null, waveAt = null}) => {
  const f = useCurrentFrame();
  return <Stage>
    <Shake hits={punch ? [0] : []} amp={30}>
      <AbsoluteFill style={{transform: `scale(${(punch ? ease(f, 0, 10, 1.18, 1.04) : 1.04) + lin(f, 0, dur, 0, .06)})`}}>
        <OffthreadVideo src={staticFile(src)} muted trimBefore={trim || undefined} style={{width: '100%', height: '100%', objectFit: 'cover'}}/>
      </AbsoluteFill>
      <Embers n={26}/>
      {sparksAt !== null ? <Sparks at={sparksAt} n={80} seed={11}/> : null}
      {waveAt !== null ? <Shockwave at={waveAt} color={C.gold}/> : null}
      {caption ? <Slam at={at(capAt, dur)} out={capOut === null ? dur - 14 : at(capOut, dur)} size={88}>{caption}</Slam> : null}
    </Shake>
    {punch ? <Flash at={0} dur={7}/> : null}
    <Letterbox/>
  </Stage>;
};

// Голографический интерфейс: сканирующие линии, глитч, запрос печатается, шаги вспыхивают по очереди.
export const Holo = ({header = 'СИСТЕМА · ONLINE', prompt = 'ваш запрос', steps = ['Шаг первый', 'Шаг второй', 'Шаг третий'], dur = 90, stepsAt = 0.31, stepGap = 0.13}) => {
  const f = useCurrentFrame();
  const glitch = (f % 23 < 2) || (f >= 6 && f < 8);
  const stepAt = (i) => at(stepsAt + i * stepGap, dur);
  const typed = prompt.slice(0, Math.floor(lin(f, 6, Math.max(8, stepAt(0) - 4), 0, prompt.length)));
  return <Stage>
    <AbsoluteFill style={{background: 'radial-gradient(circle at 50% 45%,rgba(95,227,255,.18),transparent 60%)'}}/>
    <Shake hits={[0]} amp={18}>
      <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', transform: `perspective(1400px) rotateX(${ease(f, 0, 18, 28, 8)}deg) translateX(${glitch ? 14 : 0}px)`}}>
        <div style={{width: 880, padding: '56px 56px 64px', borderRadius: 30, border: `2px solid ${C.cyan}`, background: 'linear-gradient(180deg,rgba(95,227,255,.10),rgba(95,227,255,.03))', boxShadow: '0 0 40px rgba(95,227,255,.45),inset 0 0 50px rgba(95,227,255,.15)', position: 'relative', overflow: 'hidden', opacity: lin(f, 0, 6)}}>
          <AbsoluteFill style={{backgroundImage: 'repeating-linear-gradient(0deg,rgba(95,227,255,.09) 0 2px,transparent 2px 7px)', transform: `translateY(${(f * 3) % 7}px)`}}/>
          <div style={{position: 'absolute', left: 0, right: 0, height: 120, top: lin(f, 0, dur, -120, 1100), background: 'linear-gradient(180deg,transparent,rgba(95,227,255,.25),transparent)'}}/>
          <div style={{fontFamily: FONT.mono, fontSize: 30, letterSpacing: 8, color: C.cyan}}>{header}</div>
          <div style={{marginTop: 34, fontFamily: FONT.mono, fontSize: 58, color: C.ink, textShadow: `0 0 18px ${C.cyan}`}}>&gt; {typed}<span style={{opacity: f % 12 < 6 ? 1 : 0}}>_</span></div>
          <div style={{marginTop: 50, display: 'flex', flexDirection: 'column', gap: 26}}>
            {steps.map((s, i) => {
              const d = stepAt(i);
              const on = lin(f, d, d + 4);
              return <div key={i} style={{display: 'flex', alignItems: 'center', gap: 24, fontSize: 44, fontWeight: 600, opacity: lin(f, d - 4, d), color: on > .5 ? C.ink : C.muted}}>
                <div style={{width: 26, height: 26, transform: 'rotate(45deg)', border: `3px solid ${on > .5 ? C.gold : C.cyan}`, background: on > .5 ? C.gold : 'transparent', boxShadow: on > .5 ? `0 0 22px ${C.gold}` : 'none'}}/>
                {s}
                <div style={{flex: 1, height: 2, background: `linear-gradient(90deg,${C.cyan}88,transparent)`, transform: `scaleX(${on})`, transformOrigin: 'left'}}/>
              </div>;
            })}
          </div>
        </div>
      </AbsoluteFill>
      {steps.map((_, i) => <Sparks key={i} at={stepAt(i)} x={150} y={990 + i * 70} n={22} speed={20} seed={i * 5 + 2} life={20}/>)}
    </Shake>
    <Flash at={0} dur={6} color="#BFF4FF" peak={.6}/>
    <Letterbox/>
  </Stage>;
};

// Энергетическая кнопка: курсор нажимает на кадре press, взрыв энергии, ударная волна, прогресс.
export const EnergyButton = ({status = 'СТАТУС', idle = 'Нажать', done = 'ГОТОВО', progress = 'result.mp4', dur = 90, press: pressShare = 1 / 3, fill = 0.6}) => {
  const f = useCurrentFrame();
  const press = at(pressShare, dur);
  const filled = press + Math.max(8, at(fill, dur));
  const pressing = f >= press - 4 && f < press + 1;
  const ok = f >= press;
  return <Stage>
    <AbsoluteFill style={{background: `radial-gradient(circle at 50% 50%,rgba(255,140,40,${.22 + .18 * lin(f, press, press + 10)}),transparent 62%)`}}/>
    <Embers n={30} seed={17}/>
    <Shake hits={[press]} amp={40}>
      <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', flexDirection: 'column'}}>
        <div style={{fontFamily: FONT.mono, fontSize: 32, letterSpacing: 10, color: C.muted, marginBottom: 46, opacity: lin(f, 0, 8)}}>{status}</div>
        <div style={{width: 720, height: 170, borderRadius: 85, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 66, fontWeight: 900, color: ok ? '#1A1006' : C.ink, background: ok ? `linear-gradient(90deg,${C.ember},${C.gold},${C.goldHot})` : 'rgba(255,178,63,.16)', border: `3px solid ${ok ? C.goldHot : C.gold}`, boxShadow: ok ? `0 0 90px ${C.gold},0 0 200px ${C.ember}` : `0 0 ${20 + Math.sin(f / 3) * 10}px ${C.gold}`, transform: `scale(${pressing ? .92 : ok ? ease(f, press, press + 10, 1.12, 1) : 1})`, opacity: lin(f, 0, 8)}}>
          {ok ? done : idle}
        </div>
        <div style={{marginTop: 56, width: 620, height: 10, borderRadius: 5, background: '#1A1A1E', overflow: 'hidden', opacity: lin(f, press + 4, press + 10)}}>
          <div style={{width: `${ease(f, press + 6, filled) * 100}%`, height: '100%', background: `linear-gradient(90deg,${C.ember},${C.goldHot})`, boxShadow: `0 0 18px ${C.gold}`}}/>
        </div>
        <div style={{marginTop: 18, fontFamily: FONT.mono, fontSize: 30, color: C.muted, opacity: lin(f, press + 4, press + 10)}}>{progress} · {Math.round(ease(f, press + 6, filled) * 100)}%</div>
      </AbsoluteFill>
      <svg width="70" height="70" viewBox="0 0 24 24" style={{position: 'absolute', left: ease(f, 4, press - 6, 880, 600), top: ease(f, 4, press - 6, 1600, 1010), opacity: lin(f, 4, 8) * (1 - lin(f, press + 2, press + 6))}}><path d="M4 2 L4 19 L8.5 15 L11.5 22 L14.5 20.7 L11.5 14 L18 14 Z" fill="#fff" stroke="#111" strokeWidth="1.2"/></svg>
      <Sparks at={press} n={140} speed={52} seed={21}/>
      <Shockwave at={press} size={3000}/>
      <Shockwave at={press + 6} color={C.cyan} size={2200} dur={18}/>
    </Shake>
    <Flash at={0} dur={6}/>
    <Flash at={press} dur={10}/>
    <Letterbox/>
  </Stage>;
};

// Результат в 3D-телефоне. На экране – только реальная запись или экран продукта пользователя.
export const Phone = ({src, dur = 90, screenText = 'подпись на экране', slam = 'РЕЗУЛЬТАТ'}) => {
  const f = useCurrentFrame();
  const ry = ease(f, 0, dur, -28, 14), rx = ease(f, 0, dur, 10, 2);
  return <Stage>
    <AbsoluteFill style={{background: 'radial-gradient(circle at 50% 50%,rgba(255,140,40,.28),transparent 60%)'}}/>
    <Embers n={50} seed={9}/>
    <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', perspective: 1600}}>
      <div style={{width: 520, height: 1060, borderRadius: 72, padding: 16, background: 'linear-gradient(135deg,#3A3A40,#0D0D10 40%,#2A2A30)', boxShadow: '0 0 0 2px #55555C, 0 50px 140px rgba(0,0,0,.8), 0 0 120px rgba(255,150,40,.35)', transform: `rotateY(${ry}deg) rotateX(${rx}deg) scale(${ease(f, 0, 14, .8, 1)})`, opacity: lin(f, 0, 6)}}>
        <div style={{width: '100%', height: '100%', borderRadius: 58, overflow: 'hidden', position: 'relative'}}>
          <OffthreadVideo src={staticFile(src)} muted style={{width: '100%', height: '100%', objectFit: 'cover'}}/>
          {screenText ? <div style={{position: 'absolute', left: 30, right: 30, bottom: 150, textAlign: 'center', fontSize: 40, fontWeight: 900, color: '#fff', textShadow: '0 3px 12px #000', opacity: lin(f, 16, 22)}}>{screenText}</div> : null}
          <AbsoluteFill style={{background: `linear-gradient(${110 + ry * 2}deg,transparent 40%,rgba(255,255,255,.22) 50%,transparent 60%)`}}/>
        </div>
      </div>
    </AbsoluteFill>
    {slam ? <Slam at={10} out={dur - 16} size={84} y={1560}>{slam}</Slam> : null}
    <Flash at={0} dur={6}/>
    <Letterbox/>
  </Stage>;
};

// Финал: слоган двумя ударами, затем знак, подпись и CTA.
export const Finale = ({line1 = 'СЛОГАН –', line2 = 'ВТОРАЯ СТРОКА', brand = 'ВАШ ПРОДУКТ', sub = 'ПОДПИСЬ', cta = 'призыв к действию', dur = 90, swapAt: swapShare = 0.53}) => {
  const f = useCurrentFrame();
  const swapAt = at(swapShare, dur);
  const swap = f >= swapAt;
  return <Stage>
    <AbsoluteFill style={{background: 'radial-gradient(circle at 50% 50%,rgba(255,106,26,.22),transparent 55%)'}}/>
    <Embers n={40} seed={13}/>
    <Shake hits={[0, 10, swapAt]} amp={28}>
      {!swap ? <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 10}}>
        <div style={{transform: `scale(${ease(f, 0, 7, 2, 1)})`, opacity: lin(f, 0, 3)}}><Chrome size={104} split={lin(f, 0, 6, 16, 0)} sweep={lin(f, 0, swapAt)}>{line1}</Chrome></div>
        <div style={{transform: `scale(${ease(f, 10, 17, 2, 1)})`, opacity: lin(f, 10, 13)}}><Chrome size={104} split={lin(f, 10, 16, 16, 0)} sweep={lin(f, 10, swapAt)}>{line2}</Chrome></div>
      </AbsoluteFill> :
      <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', flexDirection: 'column'}}>
        <div style={{transform: `scale(${ease(f, swapAt, swapAt + 8, 1.5, 1)})`}}><Chrome size={112} sweep={lin(f, swapAt, dur)} split={lin(f, swapAt, swapAt + 6, 18, 0)}>{brand}</Chrome></div>
        {sub ? <div style={{marginTop: 26, fontFamily: FONT.mono, fontSize: 42, letterSpacing: 22, color: C.gold, textShadow: `0 0 18px ${C.gold}`, opacity: lin(f, swapAt + 6, swapAt + 12)}}>{sub}</div> : null}
        {cta ? <div style={{marginTop: 60, fontSize: 38, letterSpacing: 2, color: C.ink, opacity: lin(f, swapAt + 12, swapAt + 20)}}>{cta}</div> : null}
      </AbsoluteFill>}
      <Sparks at={0} n={70} seed={31} y={900}/>
      <Sparks at={10} n={70} seed={37} y={1020}/>
      <Shockwave at={swapAt}/>
      <Sparks at={swapAt} n={120} speed={48} seed={41}/>
    </Shake>
    <Flash at={0} dur={6}/><Flash at={swapAt} dur={9}/>
    <Letterbox/>
  </Stage>;
};
