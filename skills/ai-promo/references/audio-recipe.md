# Саундтрек для `--music-only`

Готовый файл этого рецепта – источник ролика: `automontage motion <soundtrack> --project
"<Название>" --music-only`. Он же мастер-аудио: в brief блок `music` запрещён, всё сводится здесь.
Рабочая папка – `tmp/ai-promo/<slug>/` в корне движка (не попадает в Git).

## 1. Трек

- Только лицензированный трек из собственной библиотеки пользователя, который ещё не звучал
  в его роликах. Права на площадку и рекламу проверь по лицензии. Источник и лицензию трека
  держи в заметке рабочей папки и перенеси в `projects/<id>/assets/ai/provenance.json`, как
  только проект создан (шаг 3 навыка): до этого проекта ещё нет.
- Без вокала: надписи и удары читаются лучше.

## 2. Сегмент по громкости

Посчитай RMS по секундам и найди дроп – резкий рост громкости после тихого вступления:

```bash
ffmpeg -hide_banner -i track.wav -af "asetnsamples=n=48000,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=rms.txt" -f null -
grep -o "RMS_level=.*" rms.txt | nl | sort -t= -k2 -n -r | head
```

Выбери начало так, чтобы дроп пришёлся на первый большой AI-кадр раскадровки (например,
кадр 90 = 3,0 с): `start = t_drop − 3.0`. Длина сегмента – длина ролика, кратная 0,1 с.

```bash
ffmpeg -hide_banner -ss <start> -t 23.0 -i track.wav \
  -af "afade=t=in:d=0.05,afade=t=out:st=21.5:d=1.5" -ar 48000 -ac 2 music.wav
```

## 3. Саб-бумы на ударах

Синтез: синус, частота которого падает со ~122 Гц до 32 Гц, с затуханием.

```bash
ffmpeg -hide_banner -f lavfi -i "aevalsrc=0.9*sin(2*PI*(32*t+(90/4)*(1-exp(-4*t))))*exp(-2.2*t):s=48000:d=2.5" -ac 2 boom.wav
ffmpeg -hide_banner -f lavfi -i "anoisesrc=color=brown:amplitude=0.6:r=48000:d=0.6" \
  -af "lowpass=f=900,afade=t=out:st=0:d=0.6" -ac 2 burst.wav
```

Бум + короткий взрыв коричневого шума ставь на дроп и 2–3 главных удара (вспышки пакета).

## 4. Вжухи

Вжухи и импакты бери из локальной библиотеки звуков: `AUTOMONTAGE_SFX_DIR` или папка по
умолчанию `projects/.library/sfx/`. Библиотека в Git не попадает. Вжух начинай за 0,3–0,5 с
до склейки, чтобы пик пришёлся на кадр склейки.

## 5. Премикс

Задержки в миллисекундах = кадр × 1000 / 30.

```bash
ffmpeg -hide_banner -i music.wav -i boom.wav -i burst.wav -i whoosh.wav -filter_complex \
 "[1]adelay=3000|3000,volume=0.9[b];[2]adelay=3000|3000,volume=0.5[n];[3]adelay=2600|2600,volume=0.7[w];\
  [0][b][n][w]amix=inputs=4:normalize=0:duration=first,alimiter=limit=0.89[m]" \
 -map "[m]" -ar 48000 -ac 2 premix.wav
```

## 6. Громкость и длина

Два прохода loudnorm на −14 LUFS и true peak −1,5 dBTP, затем обрезка ровно до целых кадров:

```bash
ffmpeg -hide_banner -i premix.wav -af loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json -f null - 2>&1 | tail -12
# подставь measured_* из вывода:
ffmpeg -hide_banner -i premix.wav -af "loudnorm=I=-14:TP=-1.5:LRA=11:measured_I=<I>:measured_TP=<TP>:measured_LRA=<LRA>:measured_thresh=<thresh>:offset=<offset>:linear=true,aresample=48000,atrim=end_sample=<frames*1600>" -ar 48000 -ac 2 soundtrack.wav
```

`end_sample` = кадры × 48000 / 30 = кадры × 1600. `aresample=48000` до `atrim` обязателен:
loudnorm внутри работает на 192 кГц, и без пересэмплирования `atrim` отсчитывает сэмплы
192 кГц и обрезает трек в 4 раза короче. Проверь:

```bash
ffprobe -v error -show_entries stream=sample_rate,channels,duration_ts -of json soundtrack.wav
ffmpeg -hide_banner -i soundtrack.wav -af ebur128=peak=true -f null - 2>&1 | tail -12
```

`duration_ts` = кадры × 1600, интегральная громкость −14 ± 1 LUFS, пик ≤ −1,5 dBTP. Для
прослушивания в Remotion Studio скопируй файл в `motion-vNN/public/audio.wav`; в рендер пакета
звук не попадает (`withAudio=false`).
