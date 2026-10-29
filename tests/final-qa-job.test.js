// Фоновый final QA продвинутого финала (#110, D-051): задача в тяжёлом слоте, без lease проекта.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createHash } = require('node:crypto');

const {
  acquireProjectMutationLease, approveBrief, createOrOpenProject, publishBriefRevision, readProjectManifest,
} = require('../scripts/project/workspace');
const { planPreview, publishCurrentPreview } = require('../scripts/project/preview-workspace');
const { finalizeApproval } = require('../scripts/project/approve-final');
const {
  acknowledgeFinalQa, finalQaState, readJob, runFinalQaJob, startFinalQaJob,
} = require('../scripts/qa/final-qa-job');
const { buildReport, gate, writeReport } = require('../scripts/qa/report');

const ROOT = path.resolve(__dirname, '..');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fakeSpawn = (calls, pid = 4242) => (command, args, options) => {
  calls.push({ command, args, options });
  const child = new EventEmitter();
  child.pid = pid;
  child.unref = () => { calls.push('unref'); };
  return child;
};

// Ролик с продвинутым финалом: черновик → чистый preview → утверждение → копия в финал.
function promotedProject(t, { projectsDir } = {}) {
  const root = projectsDir || fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-final-qa-job-'));
  if (!projectsDir) t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'speaker.mp4');
  fs.writeFileSync(source, 'source-video');
  const workspace = createOrOpenProject({
    projectDir: path.join(root, '2026.10.18_qa-job'), name: 'QA job', sourcePath: source,
    now: new Date('2026-10-18T10:00:00.000Z'),
  });
  const brief = {
    version: 1, status: 'draft', source: workspace.sourcePath, theme: 'lesson-neutral', title: 'QA',
    output: { aspect: 'source', width: 320, height: 180, fps: 25, durationInFrames: 100 },
    corrections: [], scenes: [{ scene: 'fullscreen', start: 0, end: 4, caption: 'А' }],
  };
  const published = publishBriefRevision(workspace, { brief, markdown: '# QA\n' });
  workspace.manifest = readProjectManifest(workspace.dir);
  const planned = planPreview(workspace, {
    briefPath: published.jsonPath, briefSha256: sha(fs.readFileSync(published.jsonPath)),
    range: { kind: 'full', fromSec: 0, toSec: 4, fromFrame: 0, toFrameExclusive: 100 },
  });
  const staged = path.join(workspace.dir, 'previews', '.staged.mp4');
  fs.writeFileSync(staged, 'clean-preview');
  publishCurrentPreview(workspace, planned, staged, {
    width: 320, height: 180, fps: 25, generatedAt: '2026-10-18T10:05:00.000Z', quality: 'final',
  });
  fs.unlinkSync(staged);
  const approved = approveBrief(workspace, published.jsonPath, { root: ROOT, confirmPreviewViewed: true });
  return { root, workspace, approved };
}

test('approval finalize promotes the preview and queues a detached final QA without waiting for it', (t) => {
  const fixture = promotedProject(t);
  const calls = [];
  const result = finalizeApproval(fixture.workspace, fixture.approved.jsonPath, {
    startQa: (job) => startFinalQaJob(job, { spawnImpl: fakeSpawn(calls) }),
  });
  assert.equal(result.promoted, true);
  assert.equal(result.qa, 'queued');
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.stdio, 'ignore');
  assert.deepEqual(calls[0].args.slice(1), ['--run', fixture.workspace.dir, '--job', readJob(fixture.workspace.dir).jobId]);
  assert.equal(calls[1], 'unref');
  const job = readJob(fixture.workspace.dir);
  assert.equal(job.status, 'queued');
  assert.equal(job.renderDir, 'renders/v01-preview');
  assert.equal(job.finalSha256, sha('clean-preview'));
  assert.equal(job.pid, 4242);
});

test('a repeated approval finalize does not queue a second final QA', (t) => {
  const fixture = promotedProject(t);
  const calls = [];
  const startQa = (job) => startFinalQaJob(job, { spawnImpl: fakeSpawn(calls) });
  finalizeApproval(fixture.workspace, fixture.approved.jsonPath, { startQa });
  const again = finalizeApproval(fixture.workspace, fixture.approved.jsonPath, { startQa });
  assert.equal(again.already, true);
  assert.equal(calls.filter((call) => call !== 'unref').length, 1);
});

test('a failing promotion never throws out of finalize: approval stands, final goes the render way', (t) => {
  const fixture = promotedProject(t);
  const result = finalizeApproval(fixture.workspace, fixture.approved.jsonPath, {
    promote: () => { throw new Error('disk full'); },
    startQa: () => assert.fail('QA must not start without a final'),
  });
  assert.deepEqual(result, { promoted: false, reason: 'копирование не удалось: disk full' });
});

test('spawn failure marks the job failed so the inbox can ask for a manual qa-final', (t) => {
  const fixture = promotedProject(t);
  finalizeApproval(fixture.workspace, fixture.approved.jsonPath, { startQa: () => null });
  const job = startFinalQaJob({ projectDir: fixture.workspace.dir, renderDir: 'renders/v01-preview', sha256: sha('clean-preview') }, {
    spawnImpl: () => { throw new Error('EAGAIN'); },
  });
  assert.equal(job.status, 'failed');
  assert.match(job.error, /не запустилась: EAGAIN/u);
});

test('background final QA runs in the heavy slot without holding the project lease and records the report', async (t) => {
  const fixture = promotedProject(t);
  finalizeApproval(fixture.workspace, fixture.approved.jsonPath, {
    startQa: (job) => startFinalQaJob(job, { spawnImpl: fakeSpawn([]) }),
  });
  const events = [];
  const job = await runFinalQaJob(fixture.workspace.dir, readJob(fixture.workspace.dir).jobId, {
    acquireSlot: async ({ label }) => { events.push(`slot ${label}`); return { release: () => events.push('release') }; },
    onSlot: () => events.push('watchdog armed'),
    runQa: async ({ projectDir, finalPath, renderDir, brief }) => {
      // Lease проекта свободен: агент или пульт может менять ролик, пока идёт проверка.
      const lease = acquireProjectMutationLease(projectDir);
      lease.release();
      events.push('qa');
      assert.equal(readJob(projectDir).status, 'running');
      assert.equal(path.basename(finalPath), 'qa-job.mp4');
      assert.equal(renderDir, 'renders/v01-preview');
      assert.equal(brief.status, 'approved');
      const report = buildReport({ kind: 'final', profile: null, gates: [gate('F1', 'Слова финала', { status: 'warn', hint: 'пропало слово' })] });
      const written = writeReport(projectDir, 'final-20261018-101000', report);
      return { report, paths: { json: written.jsonPath, txt: written.textPath } };
    },
  });
  // Сторож взводится только после слота: ожидание очереди не считается временем проверки.
  assert.deepEqual(events, ['slot final QA 2026.10.18_qa-job', 'watchdog armed', 'qa', 'release']);
  assert.equal(job.status, 'done', job.error);
  assert.equal(job.verdict, 'warn');
  assert.equal(job.report, 'qa/final-20261018-101000.txt');
});

test('a final replaced before the job runs marks the job superseded and checks nothing', async (t) => {
  const fixture = promotedProject(t);
  finalizeApproval(fixture.workspace, fixture.approved.jsonPath, {
    startQa: (job) => startFinalQaJob(job, { spawnImpl: fakeSpawn([]) }),
  });
  fs.writeFileSync(path.join(fixture.workspace.dir, 'final', 'qa-job.mp4'), 'other-final');
  const job = await runFinalQaJob(fixture.workspace.dir, readJob(fixture.workspace.dir).jobId, {
    acquireSlot: async () => ({ release() {} }),
    runQa: async () => assert.fail('superseded job must not run QA'),
  });
  assert.equal(job.status, 'superseded');
  assert.equal(finalQaState(fixture.workspace.dir, readProjectManifest(fixture.workspace.dir)), null);
});

test('an exception inside the job is recorded as failed and still releases the heavy slot', async (t) => {
  const fixture = promotedProject(t);
  finalizeApproval(fixture.workspace, fixture.approved.jsonPath, {
    startQa: (job) => startFinalQaJob(job, { spawnImpl: fakeSpawn([]) }),
  });
  let released = false;
  const job = await runFinalQaJob(fixture.workspace.dir, readJob(fixture.workspace.dir).jobId, {
    acquireSlot: async () => ({ release() { released = true; } }),
    runQa: async () => { throw new Error('whisper crashed'); },
  });
  assert.equal(released, true);
  assert.equal(job.status, 'failed');
  assert.match(job.error, /whisper crashed/u);
});

test('finalQaState follows the current final only, reports a dead worker and hides acknowledged jobs', (t) => {
  const fixture = promotedProject(t);
  finalizeApproval(fixture.workspace, fixture.approved.jsonPath, {
    startQa: (job) => startFinalQaJob(job, { spawnImpl: fakeSpawn([]) }),
  });
  const manifest = readProjectManifest(fixture.workspace.dir);
  assert.equal(finalQaState(fixture.workspace.dir, manifest, { alive: () => true }).status, 'queued');
  const dead = finalQaState(fixture.workspace.dir, manifest, { alive: () => false });
  assert.equal(dead.status, 'failed');
  assert.match(dead.error, /прервана/u);
  assert.equal(finalQaState(fixture.workspace.dir, { ...manifest, latestRender: 'renders/v09-other' }), null);
  const file = path.join(fixture.workspace.dir, 'qa', 'final-qa-job.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), status: 'done', verdict: 'pass' }));
  acknowledgeFinalQa(fixture.workspace.dir);
  assert.equal(finalQaState(fixture.workspace.dir, manifest), null);
});

test('inbox shows the background final QA of the current final and hides it after --ack-final-qa', async (t) => {
  const { buildInbox, formatInbox, main } = require('../scripts/pult/inbox');
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-final-qa-inbox-'));
  t.after(() => fs.rmSync(projectsDir, { recursive: true, force: true }));
  const fixture = promotedProject(t, { projectsDir });
  finalizeApproval(fixture.workspace, fixture.approved.jsonPath, {
    startQa: (job) => startFinalQaJob(job, { spawnImpl: fakeSpawn([], process.pid) }),
  });
  const text = () => formatInbox(buildInbox({ projectsDir }), { projectsDir, cwd: projectsDir });
  assert.doesNotMatch(text(), /Утверждено/u);
  assert.match(text(), /Проверка финала идёт в фоне/u);

  await runFinalQaJob(fixture.workspace.dir, readJob(fixture.workspace.dir).jobId, {
    acquireSlot: async () => ({ release() {} }),
    runQa: async ({ projectDir }) => {
      const report = buildReport({ kind: 'final', profile: null, gates: [gate('F2', 'Лишние слова', { status: 'warn', hint: 'обрывок' })] });
      const written = writeReport(projectDir, 'final-20261018-102000', report);
      return { report, paths: { json: written.jsonPath, txt: written.textPath } };
    },
  });
  assert.match(text(), /Проверка финала: есть предупреждения – `qa\/final-20261018-102000\.txt`/u);
  assert.match(text(), /automontage inbox --ack-final-qa 2026\.10\.18_qa-job/u);

  const printed = [];
  assert.equal(main(['--projects-dir', projectsDir, '--ack-final-qa', '2026.10.18_qa-job'], { write: (line) => printed.push(line) }), 0);
  assert.match(printed.join('\n'), /Проверка финала отмечена/u);
  assert.equal(text(), 'Во входящих пульта пусто.');
});

test('inbox asks for a manual qa-final when the background check failed', async (t) => {
  const { buildInbox, formatInbox } = require('../scripts/pult/inbox');
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-final-qa-inbox-'));
  t.after(() => fs.rmSync(projectsDir, { recursive: true, force: true }));
  const fixture = promotedProject(t, { projectsDir });
  finalizeApproval(fixture.workspace, fixture.approved.jsonPath, {
    startQa: (job) => startFinalQaJob(job, { spawnImpl: () => { throw new Error('EAGAIN'); } }),
  });
  const text = formatInbox(buildInbox({ projectsDir }), { projectsDir, cwd: projectsDir });
  assert.match(text, /Проверка финала не выполнена \(не запустилась: EAGAIN\)\. Запусти вручную: `automontage qa-final 2026\.10\.18_qa-job`/u);
});

test('a stale job of a previous final never overwrites the state of the new final', async (t) => {
  const fixture = promotedProject(t);
  finalizeApproval(fixture.workspace, fixture.approved.jsonPath, {
    startQa: (job) => startFinalQaJob(job, { spawnImpl: fakeSpawn([]), jobId: 'old-job' }),
  });
  // Пока старая задача ждёт слот, ставится новая (новый финал): файл состояния теперь её.
  let releaseOld;
  const oldSlot = new Promise((resolve) => { releaseOld = resolve; });
  const stale = runFinalQaJob(fixture.workspace.dir, 'old-job', {
    acquireSlot: async () => { await oldSlot; return { release() {} }; },
    runQa: async () => assert.fail('the stale job must not run QA'),
  });
  startFinalQaJob({ projectDir: fixture.workspace.dir, renderDir: 'renders/v01-preview', sha256: sha('clean-preview') }, {
    spawnImpl: fakeSpawn([]), jobId: 'new-job',
  });
  await runFinalQaJob(fixture.workspace.dir, 'new-job', {
    acquireSlot: async () => ({ release() {} }),
    runQa: async ({ projectDir }) => {
      const report = buildReport({ kind: 'final', profile: null, gates: [gate('F1', 'Слова', { status: 'pass' })] });
      const written = writeReport(projectDir, 'final-20261018-103000', report);
      return { report, paths: { json: written.jsonPath, txt: written.textPath } };
    },
  });
  releaseOld();
  await stale;
  const job = readJob(fixture.workspace.dir);
  assert.equal(job.jobId, 'new-job');
  assert.equal(job.status, 'done');
  assert.equal(job.report, 'qa/final-20261018-103000.txt');
});

test('a finished check whose report has an error is not shown as mere warnings', async (t) => {
  const { buildInbox, formatInbox } = require('../scripts/pult/inbox');
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-final-qa-inbox-'));
  t.after(() => fs.rmSync(projectsDir, { recursive: true, force: true }));
  const fixture = promotedProject(t, { projectsDir });
  finalizeApproval(fixture.workspace, fixture.approved.jsonPath, {
    startQa: (job) => startFinalQaJob(job, { spawnImpl: fakeSpawn([]) }),
  });
  await runFinalQaJob(fixture.workspace.dir, readJob(fixture.workspace.dir).jobId, {
    acquireSlot: async () => ({ release() {} }),
    runQa: async ({ projectDir }) => {
      const report = buildReport({ kind: 'final', profile: null, gates: [], error: 'transcript: Whisper не запустился' });
      const written = writeReport(projectDir, 'final-20261018-104000', report);
      return { report, paths: { json: written.jsonPath, txt: written.textPath } };
    },
  });
  const text = formatInbox(buildInbox({ projectsDir }), { projectsDir, cwd: projectsDir });
  assert.match(text, /Проверка финала завершилась с ошибкой \(transcript: Whisper не запустился\)/u);
  assert.doesNotMatch(text, /есть предупреждения/u);
  const { scanProjects } = require('../scripts/pult/catalog');
  const entry = scanProjects({ projectsDir }).entries.find((item) => item.folder === '2026.10.18_qa-job');
  assert.deepEqual(entry.finalQa, { state: 'failed' });
});
