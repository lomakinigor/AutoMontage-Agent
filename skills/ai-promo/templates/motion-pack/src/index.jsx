import React from 'react';
import {registerRoot, Composition, Sequence, Audio, staticFile} from 'remotion';
import {Forge, Shot, Holo, EnergyButton, Finale} from './scenes';
import {BlurPass} from './fx';
import {TOTAL, FPS, WIDTH, HEIGHT} from './tokens';

// Трейлерный монтаж: склейки на ударах саундтрека, каждая сцена входит со вспышкой.
// Пример: дроп трека на кадре 90 – там первый большой AI-кадр. Все тексты – заглушки:
// замени их строками из согласованной копии. 3 AI-кадра + 4 Remotion-сцены.
// Phone (scenes.jsx) – замена сцены результата, если есть реальная запись экрана или продукта.
// Длина сцены задаётся только dur здесь: начало считается суммой предыдущих, а dur каждой
// сцене передаёт Promo. Удары внутри сцен – доли её длительности и сдвигаются сами.
export const PLAN = [
  {name: 'Заголовок', dur: 90, el: <Forge title="ВАШ ПРОДУКТ"/>},
  {name: 'Кадр 1', dur: 120, el: <Shot src="clips/shot-01.mp4" caption="НАДПИСЬ ОДИН" capAt={0.25} sparksAt={4}/>},
  {name: 'Интерфейс', dur: 90, el: <Holo/>},
  {name: 'Кадр 2', dur: 120, el: <Shot src="clips/shot-02.mp4" caption="НАДПИСЬ ДВА" capAt={0.2} waveAt={2} sparksAt={2}/>},
  {name: 'Кнопка', dur: 90, el: <EnergyButton/>},
  {name: 'Кадр 3', dur: 90, el: <Shot src="clips/shot-03.mp4" sparksAt={6}/>},
  {name: 'Финал', dur: 90, el: <Finale/>},
];

// 0 – жёсткие склейки со вспышкой на ударе; 10 – спокойный вариант: сцены перекрываются
// на 10 кадров через расфокус (BlurPass), без провала в чёрное.
const OVERLAP = 0;

// Сцены идут встык и заканчиваются ровно на TOTAL (= durationInFrames brief).
let cursor = 0;
for (const scene of PLAN) {
  if (!Number.isInteger(scene.dur) || scene.dur <= 0) throw new Error(`PLAN: dur сцены «${scene.name}» – целое число кадров больше 0`);
  scene.from = cursor;
  cursor += scene.dur;
}
if (cursor !== TOTAL) throw new Error(`PLAN кончается на кадре ${cursor}, а TOTAL = ${TOTAL}: поправь dur сцен`);

// withAudio=true – только для прослушивания в Studio (public/audio.wav = саундтрек).
// Рендер пакета всегда withAudio=false: звук ролика – источник проекта --music-only.
const Promo = ({withAudio = false}) => <>
  {withAudio ? <Audio src={staticFile('audio.wav')}/> : null}
  {PLAN.map((s) => {
    const last = s.from + s.dur === TOTAL;
    const dur = OVERLAP && !last ? s.dur + OVERLAP : s.dur;
    return <Sequence key={s.name} name={s.name} from={s.from} durationInFrames={dur}>
      {OVERLAP ? <BlurPass dur={dur} inF={s.from === 0 ? 1 : OVERLAP} outF={last ? 14 : OVERLAP} fadeOut={last}>{React.cloneElement(s.el, {dur: s.dur})}</BlurPass> : React.cloneElement(s.el, {dur: s.dur})}
    </Sequence>;
  })}
</>;

registerRoot(() => <Composition id="Promo" component={Promo} width={WIDTH} height={HEIGHT} fps={FPS} durationInFrames={TOTAL} defaultProps={{withAudio: false}}/>);
