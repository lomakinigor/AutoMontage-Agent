# Шаблон motion-пакета AI-промо

Project-local Remotion-пакет на 1080×1920 (вертикаль по умолчанию) или 1920×1080 (горизонталь 16:9), 30 FPS: 3 AI-кадра + 4 собственные сцены с VFX.
Рендерится без звука ровно на `durationInFrames` brief и подключается одной `media`-сценой.

## Копирование

Из корня движка (`vNN` – следующий свободный номер пакета в проекте):

```bash
mkdir -p projects/<id>/motion-vNN
cp -R skills/ai-promo/templates/motion-pack/. projects/<id>/motion-vNN/
mkdir -p projects/<id>/motion-vNN/public/clips
cp projects/<id>/assets/ai/<выбранный клип>.mp4 projects/<id>/motion-vNN/public/clips/shot-01.mp4
cp projects/<id>/input/narration.wav projects/<id>/motion-vNN/public/audio.wav   # только для Studio
```

Пакет работает только на глубине `projects/<id>/motion-vNN/`: импорт шрифтов
`'../../../../src/fonts'` в `src/fx.jsx` и путь к движку в `render.cjs`/`stills.cjs` считаются
от этого места (четыре уровня вверх из `src/` – корень движка). В самом шаблоне этот импорт не
разрешается – это ожидаемо.

## Файлы

| Файл | Что внутри |
|---|---|
| `src/tokens.js` | `TOTAL`, FPS, `ASPECT` и размер, палитра, шрифты, `CHROME_MAX`, safe zone |
| `src/fx.jsx` | Эффекты: Shake, Flash, Shockwave, Sparks, Embers, Letterbox, Flare, Chrome, Slam, BlurPass |
| `src/scenes.jsx` | Сцены: Forge, Shot, Holo, EnergyButton, Phone, Finale |
| `src/index.jsx` | `PLAN` сцен (длительность каждой в кадрах), композиция `Promo`, `defaultProps {withAudio:false}` |
| `render.cjs` | Полный рендер без звука через очередь и проверка кадров |
| `stills.cjs` | Контрольные PNG-кадры |

## Настройка

1. `TOTAL` в `tokens.js` = `output.durationInFrames` scaffold brief проекта. `ASPECT` = `output.aspect`
   brief: `vertical` (1080×1920, safe-зона 260…1500) или `horizontal` (1920×1080, поля 60 сверху и снизу и
   80 по бокам, как `SAFE_16x9` движка). Размер и safe zone считаются из `ASPECT`; сцены шаблона
   нарисованы под вертикаль, для 16:9 перекомпонуй их под широкий кадр.
2. `PLAN` в `index.jsx`: у каждой сцены только `dur` в кадрах. Начало сцены – сумма `dur`
   предыдущих, сумма всех `dur` обязана равняться `TOTAL` (иначе рендер падает с понятной
   ошибкой). Склейки ставь на удары саундтрека, первый большой AI-кадр – на дроп.
   Меняешь длину ролика или сцены – меняй только `dur` в `PLAN`: `Promo` передаёт `dur` в сцену,
   а внутренние удары (`hit`, `capAt`, `capOut`, `stepsAt`, `stepGap`, `press`, `fill`,
   `swapAt`) заданы долями от 0 до 1 длительности сцены и сдвигаются сами. Если удар трека
   внутри сцены должен прийтись на конкретный кадр, задай долю: кадр от начала сцены ÷ `dur`.
   `sparksAt` и `waveAt` – кадры сразу после склейки, от длины не зависят.
3. Все тексты-заглушки («ВАШ ПРОДУКТ», «НАДПИСЬ ОДИН», «СЛОГАН –» …) замени строками из
   согласованной копии. Пустая строка или `null` у необязательных подписей скрывает их.
4. Клип сцены не короче `trim + dur` (+ `OVERLAP`, если включён расфокусный переход).
5. ДНК дизайна меняй в `tokens.js` и сценах: палитра, свет, ритм – свои для каждого ролика.

## Команды

```bash
node projects/<id>/motion-vNN/stills.cjs 84 150 260     # PNG в projects/<id>/motion-vNN/out/stills/
node projects/<id>/motion-vNN/render.cjs                # renders/promo-NN.mp4, без звука
node projects/<id>/motion-vNN/render.cjs --aspect horizontal   # то же, с проверкой формата tokens.js
npx --no-install remotion --env-file=config/remotion-public.env studio projects/<id>/motion-vNN/src/index.jsx \
  --public-dir projects/<id>/motion-vNN/public
```

`--env-file=config/remotion-public.env` обязателен: без него Remotion отдаёт браузеру ключи из
корневого `.env`. `render.cjs` и `stills.cjs` подставляют его сами через `resolveRemotionCommand`.

Studio – для просмотра со звуком (в панели props поставь `withAudio: true`). Рендер пакета
всегда без звука: звук ролика – источник проекта `--music-only`.

## Уроки

- `Chrome` пишет одной строкой: ≤ 112 px при ширине 1080, длинное дели на две надписи.
- Провал в чёрное между сценами читается как обрыв ролика: склейка – вспышкой на ударе или
  перекрытием (`OVERLAP = 10`, `BlurPass`).
- Veo-клипы несут свой звук: `OffthreadVideo` в сценах всегда `muted`.
- Каждый `still` заново собирает бандл: проси сразу несколько кадров одной командой.
- Рендеры – по одному через общую очередь (`automontage queue` показывает, кто занят).
- Не рисуй чужие знаки, логотипы франшиз и фирменные заставки; на экране телефона – только
  реальная запись или экран продукта пользователя.
