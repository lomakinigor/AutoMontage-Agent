// Переходы между сценами motion-reel. Поле transition у сцены ТЗ описывает вход в эту сцену из
// предыдущей. Содержимое сцены видно ровно в своём start (синхрон с дикторским текстом не
// меняется), а предыдущая сцена тянется до start следующей (в том числе через паузу) и дальше на
// хвост перехода: TransitionSeries накладывает последние кадры предыдущей сцены на первые кадры
// следующей, поэтому видимый таймлайн и общая длительность композиции остаются прежними.
// fade, slide и wipe начинаются в start и длятся frames кадров. push идёт по центру границы:
// lead = floor(frames/2) кадров до start, tail = frames - lead после, склейка push – кадр start.
// Всё, что сцена показывает после своей живой части (lead + номинальная длина по ТЗ), – стоп-кадр
// её последнего живого кадра: видео не продолжается, анимации не идут, звук не звучит.
// Чистые функции; рендер – в src/MotionDirector.jsx.
import { createElement } from 'react';
import { linearTiming } from '@remotion/transitions';
import { fade } from '@remotion/transitions/fade';
import { slide } from '@remotion/transitions/slide';
import { wipe } from '@remotion/transitions/wipe';
import { pushCut } from '@remotion/transitions/push-cut';
import { ref25 } from '../motion-kit/time.js';

// Тот же список и те же пределы проверяет scripts/motion/brief.js (CommonJS-валидатор ТЗ).
export const TRANSITION_TYPES = ['cut', 'fade', 'slide', 'wipe', 'push'];
export const DEFAULT_TRANSITION_FRAMES_25 = 10;
export const DEFAULT_TRANSITION_DIRECTION = 'left';
const DIRECTED = new Set(['slide', 'wipe']);

// direction в ТЗ – куда движется кадр: left значит, что новая сцена въезжает справа налево,
// как свайп ленты. У Remotion направление задаётся стороной входа (from-*).
const FROM_SIDE = { left: 'from-right', right: 'from-left', up: 'from-bottom', down: 'from-top' };

export const getSceneTiming = (scene, fps) => {
  const from = Math.round(scene.start * fps);
  return { from, durationInFrames: Math.max(1, Math.round(scene.end * fps) - from) };
};

// null для cut и отсутствующего поля; иначе тип, длительность в кадрах FPS ролика и направление.
export const resolveTransition = (transition, fps) => {
  if (!transition || transition.type === 'cut') return null;
  return {
    type: transition.type,
    frames: ref25(transition.frames ?? DEFAULT_TRANSITION_FRAMES_25, fps),
    direction: DIRECTED.has(transition.type) ? transition.direction ?? DEFAULT_TRANSITION_DIRECTION : null,
  };
};

export const hasSceneTransitions = (scenes = []) => scenes.some((scene, index) => (
  index > 0 && scene?.transition && scene.transition.type !== 'cut'
));

// Сколько кадров перехода приходится до start сцены: у push – половина, у остальных – ноль.
export const transitionLead = (transition) => (
  transition?.type === 'push' ? Math.floor(transition.frames / 2) : 0
);

// Живая часть содержимого и кадр, который держится после неё (стоп-кадр хвоста).
export const sceneHold = ({ lead = 0, nominal }) => {
  const liveFrames = Math.max(1, lead + nominal);
  return { liveFrames, freezeFrame: liveFrames - 1 };
};

// Локальный кадр содержимого, который реально виден в кадре sequence localFrame.
export const contentFrameAt = (localFrame, liveFrames) => Math.min(localFrame, liveFrames - 1);

// from и durationInFrames – кадры TransitionSeries.Sequence. Сцена начинается за lead кадров до
// своего start (lead ненулевой только у push) и тянется до начала следующей сцены (через паузу,
// если она есть) плюс перекрытие перехода. Без перехода у следующей – прежние границы из ТЗ.
// У первой сцены переход не учитывается: входить ей не из чего (валидатор такое ТЗ отклоняет).
export const planSceneTransitions = (scenes = [], fps) => {
  const base = scenes.map((scene, index) => ({
    index, ...getSceneTiming(scene, fps),
    transition: index > 0 ? resolveTransition(scene.transition, fps) : null,
  }));
  return base.map((item, index) => {
    const from = item.from - transitionLead(item.transition);
    const next = base[index + 1];
    const end = next?.transition
      ? next.from - transitionLead(next.transition) + next.transition.frames
      : item.from + item.durationInFrames;
    return { ...item, from, durationInFrames: end - from };
  });
};

// Кадры sequence, где сцена участвует в переходе: TransitionSeries показывает входящую сцену с
// презентацией в её первых enterFrames кадрах (кадры перехода в неё), уходящую – в последних
// exitFrames кадрах (кадры перехода в следующую). Вне них сцена не трансформирована.
export const backdropVisible = (localFrame, { enterFrames = 0, exitFrames = 0, durationInFrames }) => (
  localFrame < enterFrames || localFrame >= durationInFrames - exitFrames
);

// pushCut держит уходящую сцену непрозрачной до конца перехода и рассчитывает, что входящая её
// закроет. Сцены прозрачные по краям и между элементами, поэтому без этого видна двойная
// экспозиция. Обёртка гасит уходящую сцену с прогресса cutProgress: склейка чистая.
export const pushExitHidden = (progress, cutProgress) => progress >= cutProgress;

const cleanPushCut = (props) => {
  const base = pushCut(props);
  const Base = base.component;
  const CleanPushCut = (componentProps) => {
    const { presentationDirection, presentationProgress, passedProps } = componentProps;
    const cut = passedProps.cutProgress;
    const hide = presentationDirection === 'exiting' && pushExitHidden(presentationProgress, cut);
    return createElement(Base, hide
      ? { ...componentProps, passedProps: { ...passedProps, outerExitStyle: { ...passedProps.outerExitStyle, opacity: 0 } } }
      : componentProps);
  };
  return { ...base, component: CleanPushCut };
};

// Второй аргумент {width, height} – размер кадра; нынешним презентациям он не нужен (slide, wipe и
// pushCut работают в процентах кадра), но остаётся в контракте для презентаций с точкой привязки.
export const presentationFor = (transition, size = {}) => {
  const timing = linearTiming({ durationInFrames: transition.frames });
  const side = FROM_SIDE[transition.direction ?? DEFAULT_TRANSITION_DIRECTION];
  if (transition.type === 'fade') return { presentation: fade(), timing };
  if (transition.type === 'slide') return { presentation: slide({ direction: side }), timing };
  if (transition.type === 'wipe') return { presentation: wipe({ direction: side }), timing };
  if (transition.type === 'push') {
    // pushCut – жёсткая склейка с коротким наездом (punch-in) на обеих сценах и вспышкой на месте
    // склейки. Входящая сцена видна с прогресса cutProgress. Линейный прогресс frame/frames и
    // cutProgress между кадрами lead-1 и lead дают склейку ровно на кадре lead, то есть в start
    // сцены по ТЗ (lead кадров перехода идут до start). После склейки уходящая сцена скрыта.
    const lead = transitionLead(transition);
    return {
      presentation: cleanPushCut({ cutProgress: Math.max(0.5, lead - 0.5) / transition.frames }),
      timing,
    };
  }
  throw new Error(`Unknown motion transition: ${transition.type}`);
};
