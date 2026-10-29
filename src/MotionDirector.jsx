import { AbsoluteFill, Audio, Freeze, Sequence, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { FontStyle } from './fonts';
import { sourceVolumeForFrame } from './scenes/BrollMedia';
import { KineticTitle } from './motion/KineticTitle';
import { CardScene } from './motion/CardScene';
import { StepsScene } from './motion/StepsScene';
import { ListScene } from './motion/ListScene';
import { ChartScene } from './motion/ChartScene';
import { CounterScene } from './motion/CounterScene';
import { MediaScene } from './motion/MediaScene';
import { CtaScene } from './motion/CtaScene';
import { motionTheme } from './motion/motion-theme';
import { Drift, Grain, TextureContext } from './details/Texture.jsx';
import { isDarkBackground } from './details/texture.js';
import { TransitionSeries } from '@remotion/transitions';
import {
  backdropVisible, contentFrameAt, getSceneTiming, hasSceneTransitions, planSceneTransitions, presentationFor,
  sceneHold, transitionLead,
} from './motion/transitions';

export const MOTION_COMPONENTS = {
  'kinetic-title': KineticTitle, card: CardScene, steps: StepsScene, list: ListScene,
  counter: CounterScene, media: MediaScene, cta: CtaScene, chart: ChartScene,
};

export const getMotionTiming = getSceneTiming;

const sceneElement = (scene, durationInFrames) => {
  const Component = MOTION_COMPONENTS[scene.scene];
  if (!Component) throw new Error(`Unknown motion scene: ${scene.scene}`);
  return <Component {...scene} durationInFrames={durationInFrames} />;
};

// Слои текстуры под сценами: subtle – дрейф фона, зерно только на тёмном фоне (на светлом его не
// видно, а шум раздувает файл). frame – глобальный кадр для фона сцены, без него – текущий кадр.
export const textureLayers = ({ texture, background = motionTheme.background, frame = null }) => {
  if (texture !== 'subtle') return null;
  const props = frame === null ? {} : { frame };
  return <><Drift {...props} />{isDarkBackground(background) && <Grain {...props} />}</>;
};

// Режим переходов: TransitionSeries ставит сцены подряд, поэтому паузы между сценами и старт
// первой сцены задаются offset. Содержимое сцены получает длительность из ТЗ (у push – плюс lead
// кадров до start, анимация входа начинается в start - lead). Всё после живой части – хвост под
// переход и пауза перед ним – стоп-кадр последнего живого кадра: Freeze держит картинку и глушит
// звук клипа, поэтому видео не продолжается и не обрывается в пустоту.
// Непрозрачный фон сцены в режиме переходов: тот же фон корня и та же текстура, что под сценами.
// Входящая сцена закрывает уходящую целиком (wipe открывает новую сцену, а не просвет старой,
// push не даёт двойной экспозиции), уходящая при slide и push не открывает просвет. Текстура идёт
// от глобального кадра композиции, поэтому зерно и дрейф не прыгают на границе сцен. Фон лежит
// вне Freeze: стоп-кадр хвоста держит содержимое, но не текстуру.
// Фон есть только в кадрах перехода (backdropVisible по локальному кадру sequence): вне них сцена
// не трансформирована, и слой корня под ней даёт тот же кадр, а лишняя копия текстуры – лишь
// время рендера.
export const SceneBackdrop = ({ texture, frame, enterFrames, exitFrames, durationInFrames }) => {
  const local = useCurrentFrame();
  if (!backdropVisible(local, { enterFrames, exitFrames, durationInFrames })) return null;
  return <AbsoluteFill data-motion-scene-backdrop="true" style={{ background: motionTheme.background }}>
    {textureLayers({ texture, background: motionTheme.background, frame })}
  </AbsoluteFill>;
};

const renderSceneTransitions = ({ scenes, fps, width, height, texture, frame }) => {
  const plan = planSceneTransitions(scenes, fps);
  let cursor = 0;
  const items = [];
  plan.forEach(({ index, from, durationInFrames, transition }, position) => {
    const natural = cursor - (transition?.frames ?? 0);
    if (transition) {
      const { presentation, timing } = presentationFor(transition, { width, height });
      items.push(<TransitionSeries.Transition key={`t${index}`} presentation={presentation} timing={timing} />);
    }
    const lead = transitionLead(transition);
    const { liveFrames, freezeFrame } = sceneHold({ lead, nominal: getSceneTiming(scenes[index], fps).durationInFrames });
    const content = lead
      ? sceneElement({ ...scenes[index], leadFrames: lead }, liveFrames)
      : sceneElement(scenes[index], liveFrames);
    items.push(<TransitionSeries.Sequence key={`s${index}`} name={`motion-scene-${index}`}
      offset={from - natural} durationInFrames={durationInFrames}>
      <SceneBackdrop texture={texture} frame={frame} durationInFrames={durationInFrames}
        enterFrames={transition?.frames ?? 0} exitFrames={plan[position + 1]?.transition?.frames ?? 0} />
      <Freeze frame={freezeFrame} active={(frame) => contentFrameAt(frame, liveFrames) < frame}>
        {content}
      </Freeze>
    </TransitionSeries.Sequence>);
    cursor = from + durationInFrames;
  });
  return <TransitionSeries>{items}</TransitionSeries>;
};

export const MotionDirector = ({ theme = 'motion-neutral', scenes = [], audioSrc, draftPreview = false, style }) => {
  const { fps, width, height } = useVideoConfig();
  const frame = useCurrentFrame();
  if (theme !== 'motion-neutral') throw new Error(`Unknown public motion theme: ${theme}`);
  const timedScenes = scenes.map((scene) => ({ scene, ...getMotionTiming(scene, fps),
    audioMode: scene.media?.kind === 'video' ? scene.media.audioMode ?? 'mute' : null,
  }));
  const texture = style?.texture === 'subtle' ? 'subtle' : 'none';
  return <AbsoluteFill style={{ background: motionTheme.background, fontFamily: motionTheme.fontFamily }}>
    <FontStyle />
    {/* Дрейф (и зерно на тёмном фоне) лежат под сценами (раньше в DOM), поэтому контраст текста не падает. */}
    {textureLayers({ texture, background: motionTheme.background })}
    {audioSrc && <Audio src={staticFile(audioSrc)} volume={(frame) => sourceVolumeForFrame({ frame, scenes: timedScenes, fps })} />}
    <TextureContext.Provider value={texture}>
    {hasSceneTransitions(scenes)
      ? renderSceneTransitions({ scenes, fps, width, height, texture, frame })
      : timedScenes.map(({ scene, from, durationInFrames }, index) => (
        <Sequence key={index} from={from} durationInFrames={durationInFrames}>
          {sceneElement(scene, durationInFrames)}
        </Sequence>
      ))}
    </TextureContext.Provider>
    {draftPreview && <div data-draft-preview-watermark="true" style={{ position: 'absolute',
      top: '5%', left: '7%', zIndex: 1000, padding: '10px 18px', borderRadius: 8,
      color: motionTheme.ink, background: motionTheme.panel, fontWeight: 800,
      fontSize: Math.min(width, height) * 0.03, opacity: 0.8,
    }}>ЧЕРНОВИК</div>}
  </AbsoluteFill>;
};
