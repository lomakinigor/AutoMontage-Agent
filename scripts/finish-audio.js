// Сдвиг звука рендера Remotion вперёд в finish.js. До 4.0.504 включительно Remotion не помечал
// задержку энкодера AAC (2048 сэмплов при 48 кГц, 42,7 мс), и голос в сыром рендере опаздывал:
// finish срезал 42,5 мс. С 4.0.536 Remotion пишет эту задержку в edit list (Skip Samples 2048),
// декодер сам её убирает и звук сырого рендера уже в синхроне с кадрами. Прежний срез уводил голос
// на 42,5 мс вперёд, а -shortest обрезал хвост видео на 2 кадра. Механизм --audio-advance-ms
// остаётся для ручной компенсации, по умолчанию сдвиг 0.
const REMOTION_AUDIO_ADVANCE_MS = 0;
const LOUDNORM_FILTER = 'loudnorm=I=-14:TP=-1.5:LRA=11';

function buildFinishAudioFilter(audioAdvanceMs = 0) {
  const advance = Number(audioAdvanceMs);
  if (!Number.isFinite(advance) || advance < 0 || advance > 250) {
    throw new Error('--audio-advance-ms должен быть числом от 0 до 250');
  }
  if (advance === 0) return LOUDNORM_FILTER;

  const seconds = (advance / 1000).toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  return `atrim=start=${seconds},asetpts=PTS-STARTPTS,${LOUDNORM_FILTER}`;
}

module.exports = {
  LOUDNORM_FILTER,
  REMOTION_AUDIO_ADVANCE_MS,
  buildFinishAudioFilter,
};
