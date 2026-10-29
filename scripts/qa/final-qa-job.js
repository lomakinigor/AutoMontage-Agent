#!/usr/bin/env node
// Фоновый final QA продвинутого финала (#110, DECISIONS.md D-051). После «Утверждаю» финал – копия
// просмотренного preview, он готов сразу; повторная расшифровка (F1–F5), обложка (G13) и надписи на кадрах
// (G14, G15) идут потом отдельным процессом в тяжёлом слоте (D-044). Lease проекта задача не берёт: она
// только читает паспорт и финал, а пишет свой отчёт qa/final-*.json|txt и состояние qa/final-qa-job.json.
//
// Состояние читают automontage inbox (строка о проверке финала) и пульт (подпись под плеером). Задача
// привязана к папке рендера и sha256 финала: если за это время появился другой финал, она помечается
// superseded и ничего не проверяет. Ручной automontage qa-final остаётся прежним.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');

const JOB_FILE = 'final-qa-job.json';
const SCRIPT = __filename;
const ROOT = path.join(__dirname, '..', '..');
const TERMINAL = new Set(['done', 'failed', 'superseded']);
const message = (error) => (error && error.message ? error.message : String(error));

function jobPath(projectDir) {
  return path.join(projectDir, 'qa', JOB_FILE);
}

function readJob(projectDir, fileSystem = fs) {
  try {
    const job = JSON.parse(fileSystem.readFileSync(jobPath(projectDir), 'utf8'));
    return job && typeof job === 'object' && !Array.isArray(job) ? job : null;
  } catch (_) {
    return null;
  }
}

function writeJob(projectDir, job, fileSystem = fs) {
  const { projectQaDir } = require('./report');
  const dir = projectQaDir(projectDir, { create: true, fileSystem });
  const target = path.join(dir, JOB_FILE);
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  fileSystem.writeFileSync(temporary, `${JSON.stringify(job, null, 2)}\n`);
  fileSystem.renameSync(temporary, target);
  return job;
}

// Пишет только в свою задачу: если файл уже занят новой задачей (новый финал), запись молча пропускается –
// процесс прежней задачи не может затереть состояние или отчёт нового финала.
function updateJob(projectDir, jobId, patch, fileSystem = fs) {
  const current = readJob(projectDir, fileSystem);
  if (!current || current.jobId !== jobId) return null;
  return writeJob(projectDir, { ...current, ...patch }, fileSystem);
}

function hashFile(filename) {
  const hash = createHash('sha256');
  const descriptor = fs.openSync(filename, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let read;
    while ((read = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, read));
  } finally { fs.closeSync(descriptor); }
  return hash.digest('hex');
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

// Ставит задачу в очередь и запускает отдельный процесс, который переживёт пульт, Review или CLI.
// Сбой запуска – состояние failed: входящие подскажут запустить automontage qa-final вручную.
function startFinalQaJob({ projectDir, renderDir, sha256 }, {
  spawnImpl = spawn, now = () => new Date(), fileSystem = fs, jobId = randomUUID(),
} = {}) {
  const queued = writeJob(projectDir, {
    version: 1, jobId, status: 'queued', renderDir, finalSha256: sha256, queuedAt: now().toISOString(),
  }, fileSystem);
  try {
    const child = spawnImpl(process.execPath, [SCRIPT, '--run', projectDir, '--job', jobId], {
      cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true,
    });
    child.on?.('error', (error) => {
      try { updateJob(projectDir, jobId, { status: 'failed', error: `не запустилась: ${message(error)}`, finishedAt: now().toISOString() }, fileSystem); } catch (_) { /* лог ниже */ }
    });
    child.unref?.();
    // pid пишется только пока задача ещё в очереди: не возвращаем «queued» поверх уже начатой проверки.
    const current = readJob(projectDir, fileSystem);
    if (current?.jobId === jobId && current.status === 'queued') return updateJob(projectDir, jobId, { pid: child.pid ?? null }, fileSystem);
    return current;
  } catch (error) {
    return writeJob(projectDir, { ...queued, status: 'failed', error: `не запустилась: ${message(error)}`, finishedAt: now().toISOString() }, fileSystem);
  }
}

// Данные рендера для G14/G15: та же композиция и props, что у финала, и временный public-бандл утверждённых
// медиа. Для motion-reel и при любой ошибке сборки – null с причиной: G14/G15 будут skipped с этим текстом.
function prepareRenderData({ projectDir, manifest, renderDir, brief }) {
  if (manifest.projectKind === 'motion-reel') return { render: null, reason: 'motion-reel: надписи на кадрах проверяет барьер preview' };
  const { resolveProjectPath } = require('../project/workspace');
  const { prepareLessonRender } = require('../lesson/workflow');
  const { prepareRenderMediaBundle } = require('../render-media-bundle');
  const { loadExtTheme } = require('../load-ext-theme');
  const sourceVideo = resolveProjectPath(projectDir, manifest.source.localPath, { mustExist: true, type: 'file' });
  const prepared = prepareLessonRender({ brief, theme: loadExtTheme(brief.theme) || brief.theme, sourceVideo });
  const lease = prepareRenderMediaBundle({
    root: ROOT, workspace: { dir: projectDir, manifest }, props: prepared.props,
    approvedBrief: prepared.approvedMedia.brief, sourcePath: prepared.approvedMedia.sourcePath,
    sourceAlias: prepared.approvedMedia.sourceAlias, namespace: `${manifest.slug}-final-qa`,
  });
  const propsPath = path.join(projectDir, ...renderDir.split('/'), 'props.json');
  fs.writeFileSync(propsPath, `${JSON.stringify(lease.props, null, 2)}\n`);
  return {
    render: {
      entry: 'src/index.js', compositionId: prepared.composition, propsPath, publicDir: lease.publicDirectory,
      fps: prepared.props.fps, width: prepared.props.width, height: prepared.props.height,
    },
    cleanup: () => lease.cleanup(),
  };
}

// Уборка временного public-бандла текущей проверки: её зовёт и сторож перед остановкой процесса.
let activeCleanup = null;

async function defaultRunQa({ projectDir, manifest, finalPath, renderDir, brief }) {
  const { FINAL_CHECKS, runFinalQa } = require('./final-qa');
  let data;
  try {
    data = prepareRenderData({ projectDir, manifest, renderDir, brief });
  } catch (error) {
    const { hidePaths } = require('./report');
    data = { render: null, reason: `не удалось подготовить кадры: ${hidePaths(message(error), projectDir)}` };
  }
  activeCleanup = data.cleanup || null;
  // Ролик без речи (audioRole: music): Whisper на музыке выдумал бы слова – F1–F5 не запускаются.
  const checks = brief.audioRole === 'music' ? FINAL_CHECKS.filter((check) => check.id !== 'transcript') : FINAL_CHECKS;
  try {
    return await runFinalQa({ projectDir, finalPath, hasMusic: Boolean(brief.music), render: data.render, skipTextReason: data.reason, checks });
  } finally {
    activeCleanup = null;
    data.cleanup?.();
  }
}

// Сама задача. jobId – своя задача из файла состояния (иначе выход без записи). deps: acquireSlot, runQa,
// now, onSlot (сторож взводится только после получения слота: ожидание очереди – не время проверки).
async function runFinalQaJob(projectDir, jobId, deps = {}) {
  const now = deps.now || (() => new Date());
  const own = () => { const current = readJob(projectDir); return current && current.jobId === jobId ? current : null; };
  const updateJobOwn = (patch) => updateJob(projectDir, jobId, patch);
  let job = own();
  if (!job || TERMINAL.has(job.status)) return job;
  const { acquireHeavySlot, heavyQueueConfig } = require('../heavy-queue');
  const slot = await (deps.acquireSlot || acquireHeavySlot)({
    label: `final QA ${path.basename(projectDir)}`, config: heavyQueueConfig(), log: () => {},
  });
  try {
    // За время очереди могла появиться новая задача (новый финал): тогда эта ничего не делает.
    job = own();
    if (!job || TERMINAL.has(job.status)) return job;
    deps.onSlot?.();
    const { readProjectManifest, resolveProjectPath } = require('../project/workspace');
    const manifest = readProjectManifest(projectDir);
    const finalPath = resolveProjectPath(projectDir, manifest.final, { mustExist: false, type: 'file' });
    if (manifest.latestRender !== job.renderDir || !fs.existsSync(finalPath) || hashFile(finalPath) !== job.finalSha256) {
      return updateJobOwn({ status: 'superseded', finishedAt: now().toISOString() });
    }
    updateJobOwn({ status: 'running', pid: process.pid, startedAt: now().toISOString() });
    const latest = manifest.renders.find((render) => render.dir === manifest.latestRender);
    const briefPath = resolveProjectPath(projectDir, latest.briefPath, { mustExist: true, type: 'file' });
    const brief = JSON.parse(fs.readFileSync(briefPath, 'utf8'));
    const { report, paths } = await (deps.runQa || defaultRunQa)({ projectDir, manifest, finalPath, renderDir: job.renderDir, brief });
    const relative = (file) => (file ? path.relative(projectDir, file).split(path.sep).join('/') : null);
    return updateJobOwn({
      status: 'done', finishedAt: now().toISOString(), verdict: report.summary.status,
      warnings: report.summary.warn ?? 0, report: relative(paths?.txt), error: report.error || null,
    });
  } catch (error) {
    const { hidePaths } = require('./report');
    return updateJobOwn({ status: 'failed', finishedAt: now().toISOString(), error: hidePaths(message(error), projectDir) });
  } finally {
    slot.release();
  }
}

// Состояние проверки текущего финала для входящих и пульта, или null: задачи нет, она про прежний финал,
// уже отмечена агентом или заменена новым финалом. Упавший процесс без записи – failed «прервана».
function finalQaState(projectDir, manifest, { fileSystem = fs, alive = processAlive } = {}) {
  const job = readJob(projectDir, fileSystem);
  if (!job || !manifest || job.renderDir !== manifest.latestRender || job.acknowledgedAt || job.status === 'superseded') return null;
  if ((job.status === 'running' || job.status === 'queued') && job.pid && !alive(job.pid)) {
    return { ...job, status: 'failed', error: job.error || 'проверка прервана' };
  }
  return job;
}

function acknowledgeFinalQa(projectDir, { now = () => new Date(), fileSystem = fs } = {}) {
  // Запись без jobId-проверки допустима: отметка относится к задаче, которая сейчас в файле.
  const job = readJob(projectDir, fileSystem);
  if (!job) throw new Error('у ролика нет фоновой проверки финала');
  if (!TERMINAL.has(job.status) && processAlive(job.pid)) throw new Error('проверка финала ещё идёт – дождись отчёта');
  return writeJob(projectDir, { ...job, acknowledgedAt: now().toISOString() }, fileSystem);
}

if (require.main === module) {
  const [flag, projectDir, jobFlag, jobId] = process.argv.slice(2);
  if (flag !== '--run' || !projectDir || jobFlag !== '--job' || !jobId) {
    console.error('внутренняя команда: node scripts/qa/final-qa-job.js --run <папка ролика> --job <id>');
    process.exitCode = 2;
  } else {
    const dir = path.resolve(projectDir);
    // Сторож: зависшая проверка не должна держать тяжёлый слот вечно (как предел дочернего QA в build.js).
    const { finalQaTimeoutMs } = require('./final-qa');
    let durationSec = null;
    try {
      const { readProjectManifest } = require('../project/workspace');
      const manifest = readProjectManifest(dir);
      const preview = manifest.currentPreview;
      durationSec = preview ? preview.toSec - preview.fromSec : null;
    } catch (_) { /* предел по умолчанию */ }
    // Сторож взводится после получения слота. По таймауту – уборка временного бандла, запись своей задачи и
    // остановка всей группы процессов задачи (она запущена detached): Whisper и Chrome не переживут слот.
    let timer = null;
    const onSlot = () => {
      timer = setTimeout(() => {
        try { activeCleanup?.(); } catch (_) { /* останавливаемся всё равно */ }
        try { updateJob(dir, jobId, { status: 'failed', finishedAt: new Date().toISOString(), error: 'проверка не уложилась в отведённое время и остановлена' }); } catch (_) { /* останавливаемся всё равно */ }
        try { if (process.platform !== 'win32') process.kill(-process.pid, 'SIGKILL'); } catch (_) { /* нет группы */ }
        process.exit(1);
      }, finalQaTimeoutMs(durationSec));
      timer.unref();
    };
    runFinalQaJob(dir, jobId, { onSlot }).then(() => clearTimeout(timer), () => { process.exitCode = 1; });
  }
}

module.exports = {
  JOB_FILE, acknowledgeFinalQa, finalQaState, jobPath, readJob, runFinalQaJob, startFinalQaJob,
};
