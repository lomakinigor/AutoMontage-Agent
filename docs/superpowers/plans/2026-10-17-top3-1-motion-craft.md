# ТОП-3 / 1. Справочник ремесла motion-craft – Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Агент перестаёт придумывать тайминги движения заново: один справочник с числами, запретами, правилами графики поверх спикера и правилом «только API установленной версии Remotion», который читают все motion-скиллы.

**Architecture:** Новый документ `skills/reel-turnkey/references/motion-craft.md` рядом с общим `creative-motion.md`. Ссылки на него добавляются туда же, где уже стоит ссылка на `creative-motion.md` (4 SKILL.md, AGENTS.md, сам `creative-motion.md`). Содержимое закрепляет тест по образцу `tests/creative-motion-instructions.test.js`. Код движка не меняется.

**Tech Stack:** Markdown, Node.js 20 `node:test`.

**Spec:** программа доработок (память проекта `engine-upgrade-program`, пункты 14, 15, 23) + решение Дмитрия 2026-10-17 сократить программу до ТОП-3; числа ниже сверены с кодом `src/motion-kit/` и `docs/MOTION-KIT.md` на коммите `0cae9c02`.

## Global Constraints

- Ветка `feat/top3-motion-craft` от `main` в отдельном worktree (`superpowers:using-git-worktrees`): в основной папке проекта параллельно работают сессии монтажа, переключать там ветку нельзя.
- Документы по-русски; вместо длинного тире только «–» (U+2014 запрещён, `scripts/check-release.js:370-378`).
- Никаких личных путей macOS и Linux и путей `projects/20xx` в новых файлах (`check-public-privacy.js:21-24`).
- Все кадровые числа даются при эталоне 25 fps и пересчитываются через `ref25(n, fps)`; в секундах – с запятой.
- Числа, уже зашитые в код, не меняются и не противоречат ему: `EASE.out = bezier(0.16,1,0.3,1)`, пружины `pop {12,200,0.7}`, `fly {16,160,0.8}`, вход `ref25(8)`, выход `ref25(5)`, субтитры `maxWords 4, maxChars 20, minDur 0.45`, событие каждые 1,5–2,2 с, спикер в первые 2 с, вспышка не чаще 1 раза в секунду, донор не дольше 3 с подряд, врезка-перекрытие не короче 0,68 с.
- Если меняется `skills/motion-reel/SKILL.md`, копии в `.agents/skills/` и `.codex/skills/` обновляются байт-в-байт (`tests/creative-motion-instructions.test.js:87-89`).
- Push и PR – только по явному «да» Дмитрия.

## Review Focus

1. Агент открыл только `SKILL.md` скилла lead-magnet (у него нет ссылки на `creative-motion.md`) – ожидается, что motion-craft всё равно доступен: ссылка добавляется и в lead-magnet. Тест в Task 1.
2. Число в справочнике расходится с кодом (например, выход 6 кадров вместо 5) – агент получит противоречие. Тест в Task 1 сверяет ключевые числа с `src/motion-kit/motion.js` и `captions.js`, читая их из кода, а не из копии.
3. Ссылка из SKILL.md ведёт на несуществующий путь (опечатка в `../reel-turnkey/...`) – тест проверяет, что каждая ссылка на motion-craft разрешается в существующий файл.
4. Версия Remotion обновится, а справочник продолжит называть 4.0.504 – правило ссылается на `package-lock.json`, тест сверяет упомянутую версию с установленной.
5. Адаптеры motion-reel разошлись с каноном после правки – существующий тест ловит; в Task 1 он запускается.

---

### Task 1: Справочник motion-craft и подключение его к скиллам

**Files:**
- Create: `skills/reel-turnkey/references/motion-craft.md`
- Modify: `skills/reel-turnkey/references/creative-motion.md` (абзац «Перед раскладкой движений прочитай motion-craft.md» в начале раздела про движение)
- Modify: `skills/ai-promo/SKILL.md:26`, `skills/motion-reel/SKILL.md:21`, `skills/reel-from-donor/SKILL.md:42`, `skills/reel-turnkey/SKILL.md:37`, `skills/lead-magnet/SKILL.md` (рядом с правилами анимации), `AGENTS.md:160`
- Modify: `.agents/skills/motion-reel/SKILL.md`, `.codex/skills/motion-reel/SKILL.md` (копия канона)
- Modify: `CHANGELOG.md` (раздел `[Unreleased]` → `### Добавлено`)
- Test: `tests/motion-craft-instructions.test.js`

**Interfaces:**
- Consumes: ничего.
- Produces: файл `skills/reel-turnkey/references/motion-craft.md` с разделами (заголовки ровно такие): `## Числа движения`, `## Один пик на ролик`, `## Запреты`, `## Графика поверх спикера`, `## Версия Remotion`.

Содержание разделов (числа обязательны дословно):

- `## Числа движения` – таблица: вход 8 кадров (0,32 с) с `EASE.out` или пружиной `fly`; выход 5 кадров (0,2 с) с `Easing.in`; появление прозрачности у `pop` – 3 кадра; шаг появления слов внутри фразы 2–3 кадра (0,08–0,12 с); шаг между пунктами списка 4–6 кадров (0,16–0,24 с); текстовый блок держится не меньше 1,2 с и не меньше 0,3 с на каждое слово сверх четырёх; визуальное событие каждые 1,5–2,2 с; врезка-перекрытие не короче 0,68 с; вспышка не чаще 1 раза в секунду.
- `## Один пик на ролик` – самый сильный приём (punch камеры + ударный звук + крупный текст одновременно) ровно один раз за ролик, на главной мысли, не в первые 2 с; остальные акценты заметно слабее.
- `## Запреты` – больше двух движущихся текстовых блоков одновременно; текст исчезает раньше 1,2 с; одно и то же движение больше трёх раз подряд; bounce и elastic на тексте; линейная скорость (`linear`) на входе; анимация каждого слова субтитров; мигание одним кадром.
- `## Графика поверх спикера` – можно: `stock`, `screen`, `scene` с `cover: true`; карточка сбоку без пересечения с лицом, стороны чередуются; нельзя: перекрывать спикера в первые 2 с; закрывать лицо подписью; донор дольше 3 с подряд; в последней трети ролика лицо чаще графики. Со ссылкой на `docs/editing-rules.md` и `docs/MOTION-KIT.md` как на источник.
- `## Версия Remotion` – использовать только API той версии, что указана в `package-lock.json` (сейчас 4.0.504); перед новым API проверить его в `node_modules/remotion` этой версии; примеры из более новой документации не копировать; обновлять Remotion внутри работы над роликом нельзя.

- [ ] **Step 1: Write the failing test** `tests/motion-craft-instructions.test.js`:

```js
test('motion-craft: разделы на месте', () => {
  for (const h of ['## Числа движения', '## Один пик на ролик', '## Запреты', '## Графика поверх спикера', '## Версия Remotion'])
    assert.ok(doc.includes(h), h);
});
test('motion-craft: числа совпадают с кодом motion-kit', () => {
  // читает src/motion-kit/motion.js и captions.js регуляркой: вход 8, выход 5, pop opacity 3, minDur 0.45
  assert.match(doc, /8 кадров \(0,32 с\)/); assert.match(doc, /5 кадров \(0,2 с\)/);
  assert.match(doc, /2–3 кадра \(0,08–0,12 с\)/); assert.match(doc, /не меньше 1,2 с/);
  assert.match(doc, /1,5–2,2 с/); assert.match(doc, /0,68 с/);
});
test('motion-craft: версия Remotion = установленная', () => {
  const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
  assert.ok(doc.includes(lock.packages['node_modules/remotion'].version));
});
test('motion-craft: на него ссылаются все motion-скиллы и AGENTS.md, ссылки живые', () => {
  // для каждого из 6 файлов + creative-motion.md: найти [..](...motion-craft.md), path.resolve от файла, fs.existsSync === true
});
test('motion-craft: без длинного тире и личных путей', () => {
  assert.ok(!doc.includes('\u2014')); assert.doesNotMatch(doc, /\/Users\/|\/home\/|projects\/20\d\d/);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test tests/motion-craft-instructions.test.js`
Expected: FAIL – `ENOENT ... motion-craft.md`.

- [ ] **Step 3: Write `motion-craft.md` and add the links** in the 7 files listed above, по образцу ссылки `Прочитай [`reel-turnkey/references/motion-craft.md`](../reel-turnkey/references/motion-craft.md).`; скопировать канон motion-reel в оба адаптера.

- [ ] **Step 4: Run the new and the neighbouring doc tests**

Run: `node --test tests/motion-craft-instructions.test.js tests/creative-motion-instructions.test.js tests/ai-promo-skill.test.js tests/reel-from-donor-skill.test.js tests/lead-magnet-skill.test.js tests/motion-kit-docs.test.js && node scripts/check-release.js`
Expected: все PASS, check-release без ошибок про тире и пути.

- [ ] **Step 5: Commit**

```bash
git add skills/ AGENTS.md .agents/skills/motion-reel .codex/skills/motion-reel CHANGELOG.md tests/motion-craft-instructions.test.js
git commit -m "docs: справочник motion-craft для motion-скиллов"
```

### Task 2: Проверка на живом ролике (Mac)

**Files:** нет изменений в коде.

- [ ] **Step 1:** После мержа (только по «да» Дмитрия) обновить копию на Mac: `git pull --ff-only` в `~/Documents/Projects/AutoMontage-Agent`.
- [ ] **Step 2:** Попросить агента разложить движения для одного короткого готового ТЗ (например, `ava-03`) и сверить выдачу с таблицей: вход 8, выход 5, один пик, нет запрещённых приёмов. Результат – короткий отчёт Дмитрию, без рендера финала.
