const fs = require('node:fs');
const path = require('node:path');

// Наборы кадров критика в qa/ (scripts/layer/sheet.js, scripts/qa/moment-stills.js): папка кадров
// <имя>/, лист <имя>.jpg, телефонный лист <имя>-phone.jpg и индекс <имя>.json. Имя – moments-<sha8>
// (кадры preview) или moments-stills-<sha8> (кадры из композиции). Каждый круг критика пишет новый
// набор, поэтому после записи старые наборы того же вида удаляются: остаются последние keep.
// Отчёты критика qa/critic-NN.* и прочие файлы под шаблон не подходят и не трогаются.
const SET_PATTERNS = {
  preview: /^(moments-[a-f0-9]{8})(\.jpg|-phone\.jpg|\.json)?$/u,
  stills: /^(moments-stills-[a-f0-9]{8})(\.jpg|-phone\.jpg|\.json)?$/u,
};
// Все файлы и папки наборов обоих видов – для automontage clean.
const MOMENT_SET_ENTRY = /^moments-(?:stills-)?[a-f0-9]{8}(?:\.jpg|-phone\.jpg|\.json)?$/u;

function describe(error) {
  return error?.code || error?.message || String(error);
}

// Симлинки пропускаются: ни сама ссылка, ни её цель не удаляются. Папка кадров – только настоящая
// папка без суффикса, файлы – только обычные файлы с суффиксом.
function collectSets(qaDir, pattern, fileSystem) {
  const sets = new Map();
  for (const name of fileSystem.readdirSync(qaDir)) {
    const match = pattern.exec(name);
    if (!match) continue;
    const file = path.join(qaDir, name);
    const stat = fileSystem.lstatSync(file, { throwIfNoEntry: false });
    if (!stat || stat.isSymbolicLink()) continue;
    const [, setName, suffix] = match;
    if (suffix ? !stat.isFile() : !stat.isDirectory()) continue;
    const set = sets.get(setName) || { name: setName, entries: [], indexMtimeMs: null, latestMtimeMs: 0 };
    set.entries.push({ file, directory: !suffix });
    if (suffix === '.json') set.indexMtimeMs = stat.mtimeMs;
    set.latestMtimeMs = Math.max(set.latestMtimeMs, stat.mtimeMs);
    sets.set(setName, set);
  }
  return [...sets.values()];
}

// Свежесть набора – время индекса, как у critic.js; набор без индекса – по самому новому файлу.
function freshness(set) {
  return set.indexMtimeMs ?? set.latestMtimeMs;
}

// current – имя только что записанного набора: он остаётся всегда, даже если у старых индексов
// mtime в будущем (копирование с сохранением времени, рассинхрон часов).
function pruneMomentSets(qaDir, { kind, keep = 2, current = null, fileSystem = fs, warn = console.warn } = {}) {
  const pattern = SET_PATTERNS[kind];
  if (!pattern) throw new Error(`pruneMomentSets: неизвестный kind «${kind}»: stills или preview`);
  const removed = [];
  let sets;
  try {
    sets = collectSets(qaDir, pattern, fileSystem);
  } catch (error) {
    warn(`⚠️ старые наборы кадров в ${qaDir} не удалены: ${describe(error)}`);
    return { removed };
  }
  sets.sort((a, b) => (b.name === current) - (a.name === current)
    || freshness(b) - freshness(a) || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  for (const set of sets.slice(Math.max(0, keep))) {
    for (const entry of set.entries) {
      try {
        // rmSync с recursive не переходит по симлинкам внутри папки кадров – удаляет сами ссылки.
        if (entry.directory) fileSystem.rmSync(entry.file, { recursive: true, force: true });
        else fileSystem.unlinkSync(entry.file);
        removed.push(entry.file);
      } catch (error) {
        warn(`⚠️ старый набор кадров не удалён: ${entry.file}: ${describe(error)}`);
      }
    }
  }
  return { removed };
}

module.exports = { MOMENT_SET_ENTRY, pruneMomentSets };
