const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createOrOpenProject, readProjectManifest, writeProjectManifest } = require('../scripts/project/workspace');
const { validateCriticReport, sceneScore, overallScore, criticDecision, main } = require('../scripts/qa/critic');

const SHA = 'a'.repeat(64);
const OTHER_SHA = 'b'.repeat(64);

function scene(ref, score, fromSec = 0, extra = {}) {
  return {
    ref, fromSec, toSec: fromSec + 2,
    scores: { idea: score, composition: score, motion: score, typography: score, rhythm: score },
    issues: score < 9 ? [{ text: 'слабо', fix: 'усилить' }] : [],
    ...extra,
  };
}
const report = (scores, { round = 1, previewSha256 = SHA } = {}) => ({
  version: 1, round, previewSha256, summary: 'итог',
  scenes: scores.map((s, i) => scene(`s${i + 1}`, s, i * 2)),
});

test('валидный отчёт проходит, оценки считаются с округлением до 0,1', () => {
  const r = report([9, 9]);
  assert.deepEqual(validateCriticReport(r), { ok: true, errors: [] });
  const mixed = scene('m', 8, 0, { scores: { idea: 8, composition: 9, motion: 8, typography: 9, rhythm: 8 } });
  assert.equal(sceneScore(mixed), 8.4);
  assert.equal(overallScore({ scenes: [mixed, scene('n', 9)] }), 8.7);
});

test('оценки 0, 11, 7.5 и пропущенная ось дают ошибки с именем сцены и оси', () => {
  const r = report([9, 9, 9, 9]);
  r.scenes[0].scores.idea = 0;
  r.scenes[1].scores.motion = 11;
  r.scenes[2].scores.typography = 7.5;
  delete r.scenes[3].scores.rhythm;
  const { ok, errors } = validateCriticReport(r);
  assert.equal(ok, false);
  const text = errors.join('\n');
  assert.match(text, /s1.*idea/u);
  assert.match(text, /s2.*motion/u);
  assert.match(text, /s3.*typography/u);
  assert.match(text, /s4.*rhythm/u);
});

test('сцена с оценкой 6 без правок отклоняется, лишние ключи и пустой отчёт тоже', () => {
  const r = report([6, 9]);
  r.scenes[0].issues = [];
  const { ok, errors } = validateCriticReport(r);
  assert.equal(ok, false);
  assert.match(errors.join('\n'), /s1.*правк/u);
  assert.equal(validateCriticReport({ ...report([9]), scenes: [] }).ok, false);
  assert.equal(validateCriticReport(null).ok, false);
  assert.equal(validateCriticReport({ ...report([9]), round: 4 }).ok, false);
});

test('общая 9,2 и все сцены не ниже 7: остановка «цель достигнута»', () => {
  const d = criticDecision([report([9, 9, 9, 10, 9])]);
  assert.equal(d.action, 'stop');
  assert.match(d.reason, /цель достигнута/u);
  assert.equal(d.overall, 9.2);
});

test('общая выше 9, но сцена 6,4: исправлять', () => {
  const r = report([10, 10, 10, 10, 10, 10, 10, 10, 10, 10]);
  r.scenes[0].scores = { idea: 6, composition: 7, motion: 6, typography: 7, rhythm: 6 };
  r.scenes[0].issues = [{ text: 'a', fix: 'b' }];
  const d = criticDecision([r]);
  assert.ok(d.overall >= 9);
  assert.equal(d.action, 'fix');
  assert.deepEqual(d.worst, ['s1']);
});

test('круг 3: остановка', () => {
  const d = criticDecision([report([5, 5], { round: 1 }), report([6, 6], { round: 2 }), report([8, 8], { round: 3 })]);
  assert.equal(d.action, 'stop');
  assert.match(d.reason, /третий круг/u);
});

test('рост меньше 0,3 (7,0 → 7,1): остановка «оценка перестала расти»; рост 0,6 допустим', () => {
  const withScores = (rep, scores) => {
    rep.scenes.forEach((s, i) => { s.scores = { ...scores[i] }; s.issues = [{ text: 'a', fix: 'b' }]; });
    return rep;
  };
  const flat = (v) => ({ idea: v, composition: v, motion: v, typography: v, rhythm: v });
  const first = report([7, 7]);
  const slow = withScores(report([7, 7], { round: 2 }), [{ ...flat(7), rhythm: 8 }, flat(7)]);
  const stop = criticDecision([first, slow]);
  assert.equal(stop.overall, 7.1);
  assert.equal(stop.action, 'stop');
  assert.match(stop.reason, /перестала расти/u);
  const fast = withScores(report([7, 7], { round: 2 }), [{ ...flat(7), idea: 8, motion: 8, rhythm: 8 }, { ...flat(7), idea: 8, motion: 8, rhythm: 8 }]);
  assert.equal(overallScore(fast), 7.6);
  assert.equal(criticDecision([first, fast]).action, 'fix');
});

test('worst: три наименьшие сцены, при равенстве более ранняя; сцены от 9 не кандидаты', () => {
  const d = criticDecision([report([6, 8, 6, 5, 6, 9])]);
  assert.equal(d.action, 'fix');
  assert.deepEqual(d.worst, ['s4', 's1', 's3']);
});

test('worst: меньше трёх сцен и дубли ref не роняют решение', () => {
  assert.deepEqual(criticDecision([report([6, 8])]).worst, ['s1', 's2']);
  const r = report([6, 6, 9]);
  r.scenes[1].ref = 's1';
  assert.deepEqual(criticDecision([r]).worst, ['s1']);
});

test('граница: рост ровно 0,3 допустим, 7,0 → 7,2 – остановка «оценка перестала расти»', () => {
  const flat = (v) => ({ idea: v, composition: v, motion: v, typography: v, rhythm: v });
  const withScores = (rep, list) => {
    rep.scenes.forEach((s, i) => { s.scores = { ...list[i] }; s.issues = [{ text: 'a', fix: 'b' }]; });
    return rep;
  };
  const first = report([7, 7]);
  // 7,0 → 7,3: сцены 7,6 и 7,0 дают среднее 7,3
  const exact = withScores(report([7, 7], { round: 2 }), [{ idea: 9, composition: 9, motion: 8, typography: 7, rhythm: 5 }, flat(7)]);
  assert.equal(sceneScore(exact.scenes[0]), 7.6);
  assert.equal(overallScore(exact), 7.3);
  assert.equal(criticDecision([first, exact]).action, 'fix');
  // 7,0 → 7,2: сцены 7,4 и 7,0
  const slow = withScores(report([7, 7], { round: 2 }), [{ idea: 8, composition: 8, motion: 8, typography: 7, rhythm: 6 }, flat(7)]);
  assert.equal(overallScore(slow), 7.2);
  const d = criticDecision([first, slow]);
  assert.equal(d.action, 'stop');
  assert.match(d.reason, /перестала расти/u);
});

test('граница: общая ровно 9,0 и сцена ровно 7,0 – остановка «цель достигнута»', () => {
  const three = report([10, 10, 7]);
  assert.equal(overallScore(three), 9);
  const d = criticDecision([three]);
  assert.equal(d.action, 'stop');
  assert.match(d.reason, /цель достигнута/u);
});

test('overall считается от целых десятых: (8,4 + 8,6) / 2 = 8,5', () => {
  const a = scene('a', 8, 0, { scores: { idea: 8, composition: 9, motion: 8, typography: 9, rhythm: 8 } });
  const b = scene('b', 8, 2, { scores: { idea: 9, composition: 9, motion: 9, typography: 8, rhythm: 8 } });
  assert.equal(sceneScore(a), 8.4);
  assert.equal(sceneScore(b), 8.6);
  assert.equal(overallScore({ scenes: [a, b] }), 8.5);
});

test('fromSec и toSec: NaN и строка – ошибка; лишняя ось в scores – ошибка', () => {
  const r = report([9, 9, 9]);
  r.scenes[0].fromSec = NaN;
  r.scenes[1].toSec = '2';
  r.scenes[2].scores.extra = 9;
  const text = validateCriticReport(r).errors.join('\n');
  assert.match(text, /s1.*fromSec/u);
  assert.match(text, /s2.*toSec/u);
  assert.match(text, /s3.*extra/u);
});

// Минимальный проект без ffmpeg: project.json с currentPreview и пустыми файлами, на которые он ссылается.
function scaffold(t, sha = SHA) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'critic-project-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source.mp4');
  fs.writeFileSync(source, 'fake');
  const projectDir = path.join(root, 'projects', 'critic-fixture');
  const workspace = createOrOpenProject({ projectDir, name: 'critic fixture', sourcePath: source });
  fs.mkdirSync(path.join(projectDir, 'previews'), { recursive: true });
  fs.mkdirSync(path.join(projectDir, 'brief'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'previews', 'preview.mp4'), '');
  fs.writeFileSync(path.join(projectDir, 'brief', 'v01-draft.lesson.json'), '{}');
  setSha(projectDir, workspace.manifest, sha);
  return projectDir;
}

function setSha(projectDir, manifest, sha) {
  const next = {
    ...manifest,
    currentPreview: {
      filePath: 'previews/preview.mp4', briefPath: 'brief/v01-draft.lesson.json', kind: 'full', fromSec: 0, toSec: 2,
      width: 540, height: 960, fps: 25, generatedAt: new Date().toISOString(), sha256: sha,
    },
  };
  writeProjectManifest(projectDir, next, { expectedManifest: manifest });
}

// Каждый круг критика перерендеривает preview: тест имитирует это сменой sha в project.json.
function rerender(projectDir, sha) {
  setSha(projectDir, readProjectManifest(projectDir), sha);
}

function runCli(projectDir, rep) {
  const file = path.join(projectDir, `in-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(rep));
  const out = []; const err = [];
  return main(['--project-dir', projectDir, '--report', file], { log: (m) => out.push(m), error: (m) => err.push(m) })
    .then((code) => ({ code, out: out.join('\n'), err: err.join('\n') }));
}

const readSaved = (projectDir, name) => JSON.parse(fs.readFileSync(path.join(projectDir, 'qa', name), 'utf8'));

test('CLI: чужой sha даёт код 2, ничего не сохраняет и не печатает решения', async (t) => {
  const projectDir = scaffold(t);
  const res = await runCli(projectDir, report([6, 6], { previewSha256: OTHER_SHA }));
  assert.equal(res.code, 2);
  assert.match(res.err, /другому preview/u);
  assert.equal(fs.existsSync(path.join(projectDir, 'qa')), false);
  assert.doesNotMatch(res.out, /Решение/u);
});

test('CLI: невалидный отчёт даёт код 2 со списком проблем', async (t) => {
  const projectDir = scaffold(t);
  const bad = report([9, 9]);
  bad.scenes[1].scores.rhythm = 11;
  const res = await runCli(projectDir, bad);
  assert.equal(res.code, 2);
  assert.match(res.err, /s2.*rhythm/u);
  assert.equal(fs.existsSync(path.join(projectDir, 'qa')), false);
});

test('CLI: два вызова подряд дают critic-01 и critic-02 и печатают решение', async (t) => {
  const projectDir = scaffold(t);
  const first = await runCli(projectDir, report([6, 7, 9]));
  assert.equal(first.code, 0);
  assert.match(first.out, /исправ/iu);
  assert.ok(fs.existsSync(path.join(projectDir, 'qa', 'critic-01.json')));
  assert.ok(fs.existsSync(path.join(projectDir, 'qa', 'critic-01.txt')));
  rerender(projectDir, OTHER_SHA);
  const second = await runCli(projectDir, report([8, 8, 9], { round: 1, previewSha256: OTHER_SHA }));
  assert.equal(second.code, 0);
  assert.match(second.err, /круг/u);
  const saved = readSaved(projectDir, 'critic-02.json');
  assert.equal(saved.report.round, 2);
  assert.equal(saved.decision.action, 'fix');
  assert.match(fs.readFileSync(path.join(projectDir, 'qa', 'critic-02.txt'), 'utf8'), /s1/u);
});

test('CLI: цепочка кругов идёт через смену sha preview; третий круг останавливает, после стопа круг 1 в новом файле', async (t) => {
  const projectDir = scaffold(t, 'a'.repeat(64));
  const shas = ['b', 'c', 'd'].map((c) => c.repeat(64));
  const r1 = await runCli(projectDir, report([6, 7, 9], { round: 1, previewSha256: SHA }));
  assert.equal(r1.code, 0);
  rerender(projectDir, shas[0]);
  const r2 = await runCli(projectDir, report([7, 8, 9], { round: 2, previewSha256: shas[0] }));
  assert.equal(r2.code, 0);
  assert.equal(r2.err, '');
  const second = readSaved(projectDir, 'critic-02.json');
  assert.equal(second.report.round, 2);
  assert.equal(second.decision.action, 'fix');
  assert.match(second.decision.reason, /общая оценка 8/u);
  rerender(projectDir, shas[1]);
  const r3 = await runCli(projectDir, report([8, 8, 9], { round: 3, previewSha256: shas[1] }));
  assert.equal(r3.code, 0);
  const third = readSaved(projectDir, 'critic-03.json');
  assert.equal(third.report.round, 3);
  assert.equal(third.decision.action, 'stop');
  assert.match(third.decision.reason, /третий круг/u);
  rerender(projectDir, shas[2]);
  const r4 = await runCli(projectDir, report([6, 7, 9], { round: 1, previewSha256: shas[2] }));
  assert.equal(r4.code, 0);
  assert.equal(r4.err, '');
  const fourth = readSaved(projectDir, 'critic-04.json');
  assert.equal(fourth.report.round, 1);
  assert.equal(fourth.decision.action, 'fix');
  assert.equal(readSaved(projectDir, 'critic-03.json').decision.action, 'stop');
});

test('CLI: повторный отчёт к тому же preview отклоняется, ничего не сохраняется', async (t) => {
  const projectDir = scaffold(t);
  assert.equal((await runCli(projectDir, report([6, 7, 9]))).code, 0);
  const again = await runCli(projectDir, report([8, 8, 9], { round: 2 }));
  assert.equal(again.code, 2);
  assert.match(again.err, /уже сохранён \(critic-01\).*перерендерьте/u);
  assert.equal(fs.existsSync(path.join(projectDir, 'qa', 'critic-02.json')), false);
  rerender(projectDir, OTHER_SHA);
  assert.equal((await runCli(projectDir, report([8, 8, 9], { round: 2, previewSha256: OTHER_SHA }))).code, 0);
});

test('CLI: нечитаемый critic-NN.json даёт предупреждение с именем файла и не затирается', async (t) => {
  const projectDir = scaffold(t);
  fs.mkdirSync(path.join(projectDir, 'qa'));
  fs.writeFileSync(path.join(projectDir, 'qa', 'critic-01.json'), '{сломано');
  const res = await runCli(projectDir, report([6, 7, 9]));
  assert.equal(res.code, 0);
  assert.match(res.err, /critic-01\.json/u);
  assert.equal(fs.readFileSync(path.join(projectDir, 'qa', 'critic-01.json'), 'utf8'), '{сломано');
  assert.equal(readSaved(projectDir, 'critic-02.json').report.round, 1);
});

test('CLI: номер файла – максимальный существующий плюс один, пропуски не заполняются', async (t) => {
  const projectDir = scaffold(t);
  const first = await runCli(projectDir, report([6, 7, 9]));
  assert.equal(first.code, 0);
  fs.renameSync(path.join(projectDir, 'qa', 'critic-01.json'), path.join(projectDir, 'qa', 'critic-05.json'));
  rerender(projectDir, OTHER_SHA);
  const second = await runCli(projectDir, report([7, 8, 9], { round: 2, previewSha256: OTHER_SHA }));
  assert.equal(second.code, 0);
  assert.ok(fs.existsSync(path.join(projectDir, 'qa', 'critic-06.json')));
  assert.equal(readSaved(projectDir, 'critic-06.json').report.round, 2);
});

// Индекс кадров из композиции, как его пишет layer sheet --mode moments --source stills.
function writeStillsIndex(projectDir, sha, mtimeSec, identity = { kind: 'layer', layer: 'motion-v01' }) {
  const dir = path.join(projectDir, 'qa');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `moments-stills-${sha.slice(0, 8)}.json`);
  fs.writeFileSync(file, JSON.stringify({ version: 1, source: 'stills', inputsSha256: sha, ...identity, moments: [] }));
  if (mtimeSec !== undefined) fs.utimesSync(file, mtimeSec, mtimeSec);
  return file;
}

// Слой motion-v01 без layer new: layer.json и src/ – всё, по чему критик пересчитывает отпечаток кадров.
function writeLayer(projectDir, plan = 'export const plan = 1;\n') {
  const src = path.join(projectDir, 'motion-v01', 'src');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'motion-v01', 'layer.json'), JSON.stringify({ version: 1, source: { localPath: 'x', sha256: 'e'.repeat(64) } }));
  fs.writeFileSync(path.join(src, 'plan.js'), plan);
  return currentLayerSha(projectDir);
}

function currentLayerSha(projectDir) {
  const { inputsSha256 } = require('../scripts/qa/moment-stills');
  const { layerSrcSha256 } = require('../scripts/layer/common');
  const layerDir = path.join(projectDir, 'motion-v01');
  return inputsSha256({ kind: 'layer', planPath: path.join(layerDir, 'src', 'plan.js'), inputProps: {}, sourceSha256: 'e'.repeat(64), srcSha256: layerSrcSha256(layerDir) });
}

const stillsReport = (scores, sha, extra = {}) => {
  const r = report(scores, extra);
  delete r.previewSha256;
  return { ...r, subject: 'stills', subjectSha256: sha };
};

test('схема: subject и subjectSha256 вместо обязательного previewSha256, previewSha256 – синоним preview', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'schema', 'critic-report.schema.json'), 'utf8'));
  assert.ok(!schema.required.includes('previewSha256'));
  assert.deepEqual(schema.properties.subject.enum, ['preview', 'stills']);
  assert.equal(schema.properties.subjectSha256.pattern, '^[a-f0-9]{64}$');
  assert.equal(schema.properties.previewSha256.pattern, '^[a-f0-9]{64}$');
  assert.ok(Array.isArray(schema.oneOf) && schema.oneOf.length === 2);
});

test('валидация: subject stills с sha проходит; без sha, чужой subject и оба поля сразу – ошибки', () => {
  assert.deepEqual(validateCriticReport(stillsReport([9], SHA)), { ok: true, errors: [] });
  assert.deepEqual(validateCriticReport({ ...stillsReport([9], SHA), subject: 'preview' }), { ok: true, errors: [] });
  assert.match(validateCriticReport(stillsReport([9], 'x')).errors.join('\n'), /subjectSha256/u);
  assert.match(validateCriticReport({ ...stillsReport([9], SHA), subject: 'video' }).errors.join('\n'), /subject/u);
  assert.match(validateCriticReport({ ...stillsReport([9], SHA), previewSha256: SHA }).errors.join('\n'), /previewSha256/u);
  const none = report([9]);
  delete none.previewSha256;
  assert.equal(validateCriticReport(none).ok, false);
});

test('CLI: отчёт к кадрам stills с sha последнего индекса принимается без preview', async (t) => {
  const projectDir = scaffold(t);
  const manifest = readProjectManifest(projectDir);
  writeProjectManifest(projectDir, { ...manifest, currentPreview: null }, { expectedManifest: manifest });
  const sha = writeLayer(projectDir);
  writeStillsIndex(projectDir, sha);
  const res = await runCli(projectDir, stillsReport([6, 7, 9], sha));
  assert.equal(res.code, 0, res.err);
  const saved = readSaved(projectDir, 'critic-01.json');
  assert.equal(saved.report.subject, 'stills');
  assert.equal(saved.report.subjectSha256, sha);
  assert.equal(saved.decision.action, 'fix');
});

test('CLI: план поменяли и кадры перерисованы – отчёт к старому inputsSha256 даёт код 2', async (t) => {
  const projectDir = scaffold(t);
  const now = Date.now() / 1000;
  const oldSha = writeLayer(projectDir, 'export const plan = 1;\n');
  writeStillsIndex(projectDir, oldSha, now - 100);
  const newSha = writeLayer(projectDir, 'export const plan = 2;\n');
  writeStillsIndex(projectDir, newSha, now);
  const res = await runCli(projectDir, stillsReport([6, 7, 9], oldSha));
  assert.equal(res.code, 2);
  assert.match(res.err, /устаревшим кадрам/u);
  assert.equal(fs.existsSync(path.join(projectDir, 'qa', 'critic-01.json')), false);
  const ok = await runCli(projectDir, stillsReport([6, 7, 9], newSha));
  assert.equal(ok.code, 0, ok.err);
});

test('CLI: кадров stills нет – код 2 с подсказкой layer sheet', async (t) => {
  const projectDir = scaffold(t);
  const res = await runCli(projectDir, stillsReport([6, 7, 9], OTHER_SHA));
  assert.equal(res.code, 2);
  assert.match(res.err, /layer sheet --mode moments/u);
});

test('CLI: повторный отчёт к тем же кадрам stills отклоняется', async (t) => {
  const projectDir = scaffold(t);
  const sha = writeLayer(projectDir);
  writeStillsIndex(projectDir, sha);
  assert.equal((await runCli(projectDir, stillsReport([6, 7, 9], sha))).code, 0);
  const again = await runCli(projectDir, stillsReport([8, 8, 9], sha, { round: 2 }));
  assert.equal(again.code, 2);
  assert.match(again.err, /уже сохранён \(critic-01\)/u);
});

test('CLI: subject preview с subjectSha256 сверяется с текущим preview, как старый previewSha256', async (t) => {
  const projectDir = scaffold(t);
  const r = report([6, 7, 9]);
  delete r.previewSha256;
  const bad = await runCli(projectDir, { ...r, subject: 'preview', subjectSha256: OTHER_SHA });
  assert.equal(bad.code, 2);
  assert.match(bad.err, /другому preview/u);
  const ok = await runCli(projectDir, { ...r, subject: 'preview', subjectSha256: SHA });
  assert.equal(ok.code, 0, ok.err);
  // Старый формат к тому же preview – тот же предмет: повтор отклоняется.
  const legacy = await runCli(projectDir, report([8, 8, 9], { round: 2 }));
  assert.equal(legacy.code, 2);
  assert.match(legacy.err, /уже сохранён/u);
});

test('CLI: план слоя изменён после кадров, кадры не перерисованы – код 2 «перерисуй кадры»', async (t) => {
  const projectDir = scaffold(t);
  const sha = writeLayer(projectDir, 'export const plan = 1;\n');
  writeStillsIndex(projectDir, sha);
  fs.writeFileSync(path.join(projectDir, 'motion-v01', 'src', 'plan.js'), 'export const plan = 2;\n');
  const res = await runCli(projectDir, stillsReport([6, 7, 9], sha));
  assert.equal(res.code, 2);
  assert.match(res.err, /перерисуй кадры: automontage layer sheet --mode moments/u);
  assert.equal(fs.existsSync(path.join(projectDir, 'qa', 'critic-01.json')), false);
});

test('CLI: правка компонента вне plan.js меняет отпечаток кадров, новый отчёт принимается', async (t) => {
  const projectDir = scaffold(t);
  const first = writeLayer(projectDir);
  writeStillsIndex(projectDir, first);
  assert.equal((await runCli(projectDir, stillsReport([6, 7, 9], first))).code, 0);
  fs.mkdirSync(path.join(projectDir, 'motion-v01', 'src', 'components'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'motion-v01', 'src', 'components', 'Title.jsx'), 'export const Title = () => null;\n');
  // Без перерисовки кадров старый отчёт устарел.
  const stale = await runCli(projectDir, stillsReport([7, 8, 9], first, { round: 2 }));
  assert.equal(stale.code, 2);
  assert.match(stale.err, /перерисуй кадры/u);
  const second = currentLayerSha(projectDir);
  assert.notEqual(second, first, 'правка компонента меняет inputsSha256');
  writeStillsIndex(projectDir, second, Date.now() / 1000 + 10);
  const res = await runCli(projectDir, stillsReport([7, 8, 9], second, { round: 2 }));
  assert.equal(res.code, 0, res.err);
  assert.equal(readSaved(projectDir, 'critic-02.json').report.round, 2);
});

test('CLI: motion-reel – индекс stills сверяется с sha файла текущего ТЗ', async (t) => {
  const { fixture } = require('./helpers/motion-workflow-fixture.cjs');
  const { workspace } = fixture(t);
  const projectDir = workspace.dir;
  const briefPath = path.join(projectDir, readProjectManifest(projectDir).currentBrief);
  const original = fs.readFileSync(briefPath);
  const briefSha256 = require('node:crypto').createHash('sha256').update(original).digest('hex');
  writeStillsIndex(projectDir, OTHER_SHA, undefined, { kind: 'motion-reel', briefSha256 });
  fs.writeFileSync(briefPath, Buffer.concat([original, Buffer.from('\n')]));
  const stale = await runCli(projectDir, stillsReport([6, 7, 9], OTHER_SHA));
  assert.equal(stale.code, 2);
  assert.match(stale.err, /ТЗ менялось после кадров.*перерисуй кадры/u);
  fs.writeFileSync(briefPath, original);
  const ok = await runCli(projectDir, stillsReport([6, 7, 9], OTHER_SHA));
  assert.equal(ok.code, 0, ok.err);
});

test('CLI: индекс stills старого формата без kind – код 2 «перерисуй кадры»', async (t) => {
  const projectDir = scaffold(t);
  writeStillsIndex(projectDir, OTHER_SHA, undefined, {});
  const res = await runCli(projectDir, stillsReport([6, 7, 9], OTHER_SHA));
  assert.equal(res.code, 2);
  assert.match(res.err, /перерисуй кадры/u);
});

test('CLI: круги stills и preview – отдельные цепочки; preview после двух кругов stills – круг 1', async (t) => {
  const projectDir = scaffold(t);
  const first = writeLayer(projectDir, 'export const plan = 1;\n');
  writeStillsIndex(projectDir, first);
  assert.equal((await runCli(projectDir, stillsReport([6, 7, 9], first))).code, 0);
  const second = writeLayer(projectDir, 'export const plan = 2;\n');
  writeStillsIndex(projectDir, second, Date.now() / 1000 + 10);
  assert.equal((await runCli(projectDir, stillsReport([7, 8, 9], second, { round: 2 }))).code, 0);
  assert.equal(readSaved(projectDir, 'critic-02.json').report.round, 2);
  const preview = await runCli(projectDir, report([6, 7, 9], { round: 1 }));
  assert.equal(preview.code, 0, preview.err);
  assert.equal(preview.err, '');
  const saved = readSaved(projectDir, 'critic-03.json');
  assert.equal(saved.report.round, 1);
  assert.equal(saved.decision.action, 'fix');
  // И обратно: следующий круг stills продолжает свою цепочку – круг 3, третий круг останавливает.
  const third = writeLayer(projectDir, 'export const plan = 3;\n');
  writeStillsIndex(projectDir, third, Date.now() / 1000 + 20);
  assert.equal((await runCli(projectDir, stillsReport([8, 9, 9], third, { round: 3 }))).code, 0);
  const stills3 = readSaved(projectDir, 'critic-04.json');
  assert.equal(stills3.report.round, 3);
  assert.match(stills3.decision.reason, /третий круг/u);
});
