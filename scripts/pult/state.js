const fs = require('node:fs');
const path = require('node:path');

const { acquireProjectMutationLease } = require('../project/workspace');
const { ensureDirectory, readJsonIfExists, writeJsonAtomic } = require('./files');
const { SAFE_NAME, isSafeName } = require('./names');

const CARD_ID = new RegExp(`^(folder|group):${SAFE_NAME}$`, 'u');
// Путь утверждённого brief внутри папки ролика – как его пишет движок (brief/vNN-approved.<kind>.json).
// Ничего, кроме одного файла в brief/: решение «финал не нужен» адресует ровно одну версию.
const BRIEF_PATH = /^brief\/(?!\.)[^/\\\u0000-\u001F\u007F]{1,200}\.json$/u;

// Сколько запись ждёт замок, пока его держит другой живой процесс (сервер пульта или
// `automontage inbox --decline-final`). Каждый держит замок миллисекунды.
const LOCK_WAIT_MS = 3000;
const LOCK_RETRY_MS = 20;
const ENGINE_MANIFEST_CONFLICT = 'PROJECT_MANIFEST_CONFLICT';
const UNREADABLE_MESSAGE = 'Файл состояния пульта projects/.pult/state.json не читается – запись отменена, '
  + 'чтобы не стереть архив и решения о финале. Попросите агента проверить этот файл.';

function statePath(projectsDir) {
  return path.join(projectsDir, '.pult', 'state.json');
}

function stateError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function emptyState() {
  return { version: 1, archived: [], finalDeclined: [] };
}

function isDeclinedEntry(item) {
  return Boolean(item) && typeof item === 'object' && !Array.isArray(item)
    && isSafeName(item.folder)
    && isDeclinableBriefPath(item.briefPath)
    && typeof item.declinedAt === 'string';
}

function normalizeState(value) {
  return {
    version: 1,
    archived: value.archived.filter((id) => typeof id === 'string' && CARD_ID.test(id)),
    finalDeclined: Array.isArray(value.finalDeclined)
      ? value.finalDeclined.filter(isDeclinedEntry).map((item) => ({
        folder: item.folder,
        briefPath: item.briefPath,
        declinedAt: item.declinedAt,
      }))
      : [],
  };
}

function hasValidShape(value) {
  return Boolean(value) && typeof value === 'object' && value.version === 1 && Array.isArray(value.archived)
    && (value.finalDeclined === undefined || Array.isArray(value.finalDeclined));
}

// Это собственные флаги пульта, не пользовательские данные: любая порча файла –
// пустые списки, а не отказ всей панели (сервер читает состояние на каждый GET /api/cards).
// Файл прежнего формата (только archived) читается как есть: finalDeclined тогда пуст.
// Порча одного списка не стирает другой: битый finalDeclined – пустой, archived остаётся.
function readPultState(projectsDir) {
  let value;
  try {
    value = readJsonIfExists(statePath(projectsDir), '.pult/state.json');
  } catch (_) {
    return emptyState();
  }
  if (value === undefined) return emptyState();
  if (!value || value.version !== 1 || !Array.isArray(value.archived)) return emptyState();
  return normalizeState(value);
}

// Чтение для записи – строгое: отсутствующий файл – пустое состояние, а нечитаемый или
// неожиданной формы – отказ. Иначе следующая запись затёрла бы архив и решения о финале
// пустыми списками (терпимое readPultState годится только для показа).
function readPultStateForWrite(projectsDir) {
  let value;
  try {
    value = readJsonIfExists(statePath(projectsDir), '.pult/state.json');
  } catch (_) {
    throw stateError('PULT_STATE_UNREADABLE', UNREADABLE_MESSAGE);
  }
  if (value === undefined) return emptyState();
  if (!hasValidShape(value)) throw stateError('PULT_STATE_UNREADABLE', UNREADABLE_MESSAGE);
  return normalizeState(value);
}

// Сервер пульта и CLI пишут state.json из разных процессов: каждое изменение – read-modify-write
// под межпроцессным замком. Замок – тот же lease, что у паспортов роликов
// (acquireProjectMutationLease в scripts/project/workspace.js), только в папке projects/.pult:
// создание через link, владелец с pid и hostname, брошенный замок умершего процесса снимается.
// Живой владелец держит его миллисекунды – ждём до lockWaitMs, потом отказ PULT_STATE_BUSY.
function updatePultState(projectsDir, change, { lockWaitMs = LOCK_WAIT_MS } = {}) {
  const pultDir = path.join(projectsDir, '.pult');
  ensureDirectory(pultDir);
  const deadline = Date.now() + lockWaitMs;
  let lease = null;
  while (!lease) {
    try {
      lease = acquireProjectMutationLease(pultDir);
    } catch (error) {
      if (!error || error.code !== ENGINE_MANIFEST_CONFLICT) throw error;
      if (Date.now() >= deadline) {
        throw stateError('PULT_STATE_BUSY', 'Состояние пульта сейчас занято другой записью – попробуйте ещё раз');
      }
      sleepSync(LOCK_RETRY_MS);
    }
  }
  try {
    const state = readPultStateForWrite(projectsDir);
    const next = change(state);
    if (next && next !== state) writeJsonAtomic(statePath(projectsDir), next);
    return next || state;
  } finally {
    lease.release();
  }
}

// Ключ решения «финал не нужен»: папка ролика и точный путь утверждённого brief.
function declinedKey(folder, briefPath) {
  return `${folder}\0${briefPath}`;
}

function declinedSet(state) {
  return new Set(state.finalDeclined.map((item) => declinedKey(item.folder, item.briefPath)));
}

// Снимать пометку, когда файла состояния ещё нет, нечего: ничего не пишем и не создаём .pult.
function stateFileMissing(projectsDir) {
  try {
    fs.lstatSync(statePath(projectsDir));
    return false;
  } catch (error) {
    return Boolean(error && error.code === 'ENOENT');
  }
}

// Архив – только пометка «не показывать» в projects/.pult. Папки роликов не меняются.
function setArchived(projectsDir, cardId, archived, options = {}) {
  if (typeof cardId !== 'string' || !CARD_ID.test(cardId)) throw new Error('неверный id карточки');
  if (!archived && stateFileMissing(projectsDir)) return emptyState();
  return updatePultState(projectsDir, (state) => {
    if (Boolean(archived) === state.archived.includes(cardId)) return state;
    const next = { ...state, archived: state.archived.filter((id) => id !== cardId) };
    if (archived) next.archived.push(cardId);
    return next;
  }, options);
}

// «Финал не нужен» (DECISIONS.md D-050) – решение пользователя об одной утверждённой версии.
// Привязано к точному пути утверждённого brief: новое утверждение того же ролика пишет новый
// brief/vNN-approved.*.json, и строка «Утверждено» во входящих возвращается сама. Паспорт
// ролика (project.json) не трогаем – это флаг пульта, как и архив. Повторный вызов с тем же
// значением ничего не пишет.
function setFinalDeclined(projectsDir, { folder, briefPath } = {}, declined, { now = () => new Date(), lockWaitMs } = {}) {
  if (!isSafeName(folder)) throw new Error('неверная папка ролика');
  if (!isDeclinableBriefPath(briefPath)) throw new Error('неверный путь brief');
  if (!declined && stateFileMissing(projectsDir)) return emptyState();
  const key = declinedKey(folder, briefPath);
  return updatePultState(projectsDir, (state) => {
    const present = state.finalDeclined.some((item) => declinedKey(item.folder, item.briefPath) === key);
    if (Boolean(declined) === present) return state;
    const next = {
      ...state,
      finalDeclined: state.finalDeclined.filter((item) => declinedKey(item.folder, item.briefPath) !== key),
    };
    if (declined) next.finalDeclined.push({ folder, briefPath, declinedAt: now().toISOString() });
    return next;
  }, lockWaitMs === undefined ? {} : { lockWaitMs });
}

// Решение «финал не нужен» можно записать только для пути, который пройдёт проверку файла
// состояния: сервер и CLI сверяются с этим же правилом до показа кнопки и до записи.
function isDeclinableBriefPath(briefPath) {
  return typeof briefPath === 'string' && BRIEF_PATH.test(briefPath);
}

module.exports = {
  BRIEF_PATH,
  CARD_ID,
  declinedKey,
  declinedSet,
  isDeclinableBriefPath,
  readPultState,
  setArchived,
  setFinalDeclined,
};
