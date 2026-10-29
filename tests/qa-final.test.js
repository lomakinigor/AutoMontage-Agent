'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  FINAL_CHECKS, MUSIC_SKIP_REASON, findVoicedGaps, finalQaChildArgs, maybeRunFinalQa,
  finalQaTimeoutMs, readExpectedWords, runFinalQa, runFinalQaSync,
} = require('../scripts/qa/final-qa');

const ROOT = path.join(__dirname, '..');
const FRAME = 0.01;
const byId = (gates, id) => gates.find((g) => g.id === id);

function tempDir(t, prefix = 'qa-final-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Уровни звука: внутри слов речь (-20 dBFS), между словами тишина (-80 dBFS),
// loud – промежутки, где между словами слышен звук.
function levelsFor(words, durationSec, loud = []) {
  const levels = new Array(Math.round(durationSec / FRAME)).fill(-80);
  for (const span of [...words.map((w) => ({ fromSec: w.s, toSec: w.e })), ...loud]) {
    for (let i = Math.round(span.fromSec / FRAME); i < Math.round(span.toSec / FRAME) && i < levels.length; i += 1) levels[i] = -20;
  }
  return { frameSec: FRAME, levels };
}

const FINAL_WORDS = [
  { w: 'привет', s: 0, e: 0.5 },
  { w: 'эм', s: 0.6, e: 0.8 },
  { w: 'мир', s: 2.3, e: 2.8 },
];
const EXPECTED = [{ words: [{ w: 'привет', s: 0, e: 0.5 }, { w: 'мир', s: 0.6, e: 1.1 }] }];

function project(t, transcript = EXPECTED) {
  const dir = tempDir(t);
  if (transcript) {
    fs.mkdirSync(path.join(dir, 'transcript'));
    fs.writeFileSync(path.join(dir, 'transcript', 'words.json'), JSON.stringify(transcript));
  }
  fs.mkdirSync(path.join(dir, 'final'));
  const finalPath = path.join(dir, 'final', 'ролик.mp4');
  fs.writeFileSync(finalPath, 'mp4');
  const manifest = { transcript: { words: 'transcript/words.json' } };
  return { dir, finalPath, manifest };
}

function deps(manifest, extra = {}) {
  const calls = { transcribe: [], levels: [] };
  return {
    calls,
    deps: {
      readManifestImpl: () => manifest,
      frameStatsImpl: () => ({ edgeShare: 0.05, meanLuma: 110 }),
      transcribeImpl: (options) => { calls.transcribe.push(options); return [{ words: FINAL_WORDS }]; },
      readLevelsImpl: (file) => { calls.levels.push(file); return levelsFor(FINAL_WORDS, 3); },
      ...extra,
    },
  };
}

const NOW = new Date('2026-10-17T09:08:07.000Z');

test('runFinalQa: пишет qa/final-<stamp>.json и .txt с гейтами F1–F5 и G13–G15', async (t) => {
  const p = project(t);
  const { deps: d, calls } = deps(p.manifest);
  const { report, paths } = await runFinalQa({ projectDir: p.dir, finalPath: p.finalPath, now: NOW }, d);
  assert.equal(report.kind, 'final');
  assert.equal(report.error, null);
  assert.deepEqual(report.gates.map((g) => g.id), ['F1', 'F2', 'F3', 'F4', 'F5', 'G13', 'G14', 'G15']);
  // Без данных рендера (не из build.js) надписи на кадрах не замеряются.
  assert.equal(byId(report.gates, 'G14').status, 'skipped');
  assert.equal(byId(report.gates, 'G15').status, 'skipped');
  assert.equal(byId(report.gates, 'F1').status, 'warn');
  assert.equal(byId(report.gates, 'F2').status, 'pass');
  assert.equal(byId(report.gates, 'F3').status, 'pass');
  assert.equal(byId(report.gates, 'F4').status, 'warn');
  assert.equal(byId(report.gates, 'F5').status, 'pass');
  assert.equal(paths.json, path.join(p.dir, 'qa', 'final-20261017-090807.json'));
  assert.equal(paths.txt, path.join(p.dir, 'qa', 'final-20261017-090807.txt'));
  assert.equal(JSON.parse(fs.readFileSync(paths.json, 'utf8')).kind, 'final');
  assert.match(fs.readFileSync(paths.txt, 'utf8'), /F1 Слова-паразиты/);
  // Модель по умолчанию – как в build.js; расшифровывается именно финал.
  assert.deepEqual(calls.transcribe, [{ videoPath: p.finalPath, model: 'large-v3-turbo' }]);
  assert.deepEqual(report.inputs, [{ role: 'final', path: 'final/ролик.mp4' }, { role: 'transcript', path: 'transcript/words.json' }]);
  assert.deepEqual(FINAL_CHECKS.map((c) => c.id), ['transcript', 'cover', 'text-layout']);
});

test('runFinalQa: write false – отчёт без файлов, модель передаётся в расшифровку', async (t) => {
  const p = project(t);
  const { deps: d, calls } = deps(p.manifest);
  const { paths } = await runFinalQa({ projectDir: p.dir, finalPath: p.finalPath, model: 'small', write: false }, d);
  assert.equal(paths, null);
  assert.equal(fs.existsSync(path.join(p.dir, 'qa')), false);
  assert.equal(calls.transcribe[0].model, 'small');
});

test('без активной расшифровки F2/F3 skipped, паузы и звук между словами проверяются', async (t) => {
  const p = project(t, null);
  const { deps: d } = deps(p.manifest);
  const { report } = await runFinalQa({ projectDir: p.dir, finalPath: p.finalPath, write: false }, d);
  assert.equal(report.error, null);
  assert.equal(byId(report.gates, 'F2').status, 'skipped');
  assert.equal(byId(report.gates, 'F3').status, 'skipped');
  assert.equal(byId(report.gates, 'F4').status, 'warn');
  assert.equal(byId(report.gates, 'F5').status, 'pass');
});

test('readExpectedWords: слова активной расшифровки; нет файла, пусто или битый JSON – null', (t) => {
  const p = project(t);
  assert.deepEqual(readExpectedWords(p.dir, p.manifest), [{ w: 'привет', s: 0, e: 0.5 }, { w: 'мир', s: 0.6, e: 1.1 }]);
  assert.equal(readExpectedWords(p.dir, { transcript: { words: 'transcript/none.json' } }), null);
  assert.equal(readExpectedWords(p.dir, null), null);
  assert.equal(readExpectedWords(null, p.manifest), null);
  fs.writeFileSync(path.join(p.dir, 'transcript', 'words.json'), '[]');
  assert.equal(readExpectedWords(p.dir, p.manifest), null);
  fs.writeFileSync(path.join(p.dir, 'transcript', 'words.json'), '{не json');
  assert.equal(readExpectedWords(p.dir, p.manifest), null);
});

test('слова расшифровки за концом финала не считаются пропавшими', async (t) => {
  // Финал короче исходника (--frames или длительность brief): хвост расшифровки в финал не входит.
  const p = project(t, [{ words: [...EXPECTED[0].words, { w: 'лишний', s: 5, e: 5.4 }, { w: 'хвост', s: 5.5, e: 5.9 }] }]);
  const { deps: d } = deps(p.manifest);
  const { report } = await runFinalQa({ projectDir: p.dir, finalPath: p.finalPath, write: false }, d);
  assert.equal(byId(report.gates, 'F3').status, 'pass');
});

test('hasMusic: F5 skipped с причиной «музыка мешает замеру»', async (t) => {
  const p = project(t);
  const { deps: d } = deps(p.manifest);
  const { report } = await runFinalQa({ projectDir: p.dir, finalPath: p.finalPath, hasMusic: true, write: false }, d);
  const f5 = byId(report.gates, 'F5');
  assert.equal(f5.status, 'skipped');
  assert.equal(MUSIC_SKIP_REASON, 'музыка мешает замеру');
  assert.match(f5.hint, /музыка мешает замеру/);
  assert.equal(byId(report.gates, 'F1').status, 'warn');
});

test('уровни звука не прочитались – F5 skipped с причиной, остальные гейты есть', async (t) => {
  const p = project(t);
  const { deps: d } = deps(p.manifest, { readLevelsImpl: () => { throw new Error('ffmpeg упал на /secret/путь/final.mp4'); } });
  const { report } = await runFinalQa({ projectDir: p.dir, finalPath: p.finalPath, write: false }, d);
  const f5 = byId(report.gates, 'F5');
  assert.equal(f5.status, 'skipped');
  assert.match(f5.hint, /не удалось прочитать звук/);
  assert.doesNotMatch(f5.hint, /secret/);
  assert.equal(report.error, null);
});

test('findVoicedGaps: громкий промежуток 0,4 с между словами – находка; тихий – нет; 0,2 с – нет', () => {
  const words = [
    { w: 'один', s: 0, e: 0.5 },
    { w: 'два', s: 0.9, e: 1.3 }, // громкий промежуток 0,4 с
    { w: 'три', s: 1.7, e: 2.1 }, // тихий промежуток 0,4 с
    { w: 'четыре', s: 2.3, e: 2.7 }, // громкий, но 0,2 с
  ];
  const analysis = { ...levelsFor(words, 3, [{ fromSec: 0.5, toSec: 0.9 }, { fromSec: 2.1, toSec: 2.3 }]), thresholdDb: -50 };
  assert.deepEqual(findVoicedGaps(words, analysis), [{ fromSec: 0.5, toSec: 0.9 }]);
  assert.deepEqual(findVoicedGaps(words, analysis, 0.1), [{ fromSec: 0.5, toSec: 0.9 }, { fromSec: 2.1, toSec: 2.3 }]);
  assert.deepEqual(findVoicedGaps([], analysis), []);
});

test('maybeRunFinalQa: transcribeImpl бросает – не бросает дальше, в лог строка «final QA не выполнен», отчёт с ошибкой', async (t) => {
  const p = project(t);
  const { deps: d } = deps(p.manifest, { transcribeImpl: () => { throw new Error('Python 3 не найден'); } });
  const lines = [];
  await maybeRunFinalQa({ enabled: true, projectDir: p.dir, finalPath: p.finalPath, hasMusic: false, log: (m) => lines.push(m) }, d);
  assert.ok(lines.some((l) => l.startsWith('final QA не выполнен: ') && l.includes('Python 3 не найден')), lines.join('\n'));
  const files = fs.readdirSync(path.join(p.dir, 'qa')).filter((f) => /^final-.*\.json$/.test(f));
  assert.equal(files.length, 1);
  const saved = JSON.parse(fs.readFileSync(path.join(p.dir, 'qa', files[0]), 'utf8'));
  assert.equal(saved.summary.status, 'error');
  assert.match(saved.error, /transcript: Python 3 не найден/);
});

test('maybeRunFinalQa: сбой ещё до проверок (битый project.json) – не бросает, строка в логе', async (t) => {
  const p = project(t);
  const lines = [];
  await maybeRunFinalQa({
    enabled: true, projectDir: p.dir, finalPath: p.finalPath, log: (m) => lines.push(m),
  }, { ...deps(p.manifest).deps, readManifestImpl: () => { throw new Error('project.json не читается'); } });
  assert.ok(lines.some((l) => /^final QA не выполнен: .*project\.json не читается/.test(l)), lines.join('\n'));
});

test('maybeRunFinalQa: печатает отчёт и путь к нему', async (t) => {
  const p = project(t);
  const lines = [];
  await maybeRunFinalQa({ enabled: true, projectDir: p.dir, finalPath: p.finalPath, log: (m) => lines.push(m) }, deps(p.manifest).deps);
  assert.match(lines.join('\n'), /Проверки \(финал\): есть предупреждения/);
  assert.match(lines.join('\n'), /qa\/final-\d{8}-\d{6}\.txt/);
  assert.ok(!lines.some((l) => l.startsWith('final QA не выполнен')));
});

test('maybeRunFinalQa: enabled false – transcribeImpl не вызывается', async (t) => {
  const p = project(t);
  const { deps: d, calls } = deps(p.manifest);
  const lines = [];
  await maybeRunFinalQa({ enabled: false, projectDir: p.dir, finalPath: p.finalPath, log: (m) => lines.push(m) }, d);
  assert.equal(calls.transcribe.length, 0);
  assert.deepEqual(lines, []);
});

test('без проекта отчёт пишется в qa/ рядом с финалом', async (t) => {
  const dir = tempDir(t);
  const finalPath = path.join(dir, 'out.mp4');
  fs.writeFileSync(finalPath, 'mp4');
  const { deps: d } = deps(null, { readManifestImpl: () => { throw new Error('не должен вызываться'); } });
  const { report, paths } = await runFinalQa({ projectDir: null, finalPath, now: NOW }, d);
  assert.equal(report.error, null);
  assert.equal(byId(report.gates, 'F2').status, 'skipped');
  assert.equal(paths.json, path.join(dir, 'qa', 'final-20261017-090807.json'));
});

test('финала нет на диске – отчёт с ошибкой, без расшифровки', async (t) => {
  const p = project(t);
  const { deps: d, calls } = deps(p.manifest);
  const { report, paths } = await runFinalQa({ projectDir: p.dir, finalPath: path.join(p.dir, 'final', 'нет.mp4') }, d);
  assert.equal(calls.transcribe.length, 0);
  assert.match(report.error, /финал не найден: нет\.mp4/);
  assert.ok(fs.existsSync(paths.json));
});

test('finalQaChildArgs и runFinalQaSync: аргументы дочернего процесса, сбой не роняет сборку', () => {
  const script = path.join(ROOT, 'scripts', 'qa', 'final-qa.js');
  assert.deepEqual(finalQaChildArgs({ projectDir: '/p', finalPath: '/p/f.mp4', hasMusic: true, model: 'small' }),
    [script, '--from-build', '/p', '--final', '/p/f.mp4', '--model', 'small', '--music']);
  assert.deepEqual(finalQaChildArgs({ projectDir: null, finalPath: '/o/f.mp4' }),
    [script, '--from-build', '--final', '/o/f.mp4', '--model', 'large-v3-turbo']);

  const calls = [];
  const lines = [];
  assert.equal(runFinalQaSync({ enabled: true, projectDir: '/p', finalPath: '/p/f.mp4', log: (m) => lines.push(m) }, {
    runNodeToolImpl: (...callArgs) => calls.push(callArgs),
  }), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], script);
  assert.deepEqual(calls[0][1], ['--from-build', '/p', '--final', '/p/f.mp4', '--model', 'large-v3-turbo']);
  assert.equal(calls[0][2].stage, 'final QA');
  // Без длительности финала – фиксированные 30 минут на проверку.
  assert.equal(calls[0][2].timeout, 30 * 60 * 1000);
  assert.deepEqual(lines, ['финал собран, идёт проверка (final QA); пропустить – --no-final-qa']);
  lines.length = 0;

  assert.equal(runFinalQaSync({ enabled: true, finalPath: '/o/f.mp4', log: (m) => lines.push(m) }, {
    runNodeToolImpl: () => { throw new Error('spawn node ENOENT'); },
  }), false);
  assert.deepEqual(lines, ['финал собран, идёт проверка (final QA); пропустить – --no-final-qa', 'final QA не выполнен: spawn node ENOENT']);

  // Данные рендера уходят одним --render-json; битые не отменяют остальной QA.
  const render = { entry: 'src/index.js', compositionId: 'Lesson', propsPath: '/p/x.json', publicDir: '/p/pub', fps: 25, width: 1080, height: 1920 };
  assert.deepEqual(finalQaChildArgs({ finalPath: '/o/f.mp4', render }).slice(-2), ['--render-json', JSON.stringify(render)]);
  const withRender = [];
  const renderLines = [];
  assert.equal(runFinalQaSync({ enabled: true, finalPath: '/o/f.mp4', render: { ...render, width: 0 }, log: (m) => renderLines.push(m) }, {
    runNodeToolImpl: (...callArgs) => withRender.push(callArgs),
  }), true);
  assert.equal(withRender[0][1].includes('--render-json'), false);
  assert.match(renderLines[1], /надписи на кадрах не проверить – --render-json: width/);

  assert.equal(runFinalQaSync({ enabled: false, finalPath: '/o/f.mp4', log: (m) => lines.push(m) }, {
    runNodeToolImpl: () => { throw new Error('не должен вызываться'); },
  }), false);
});

test('finalQaTimeoutMs: не меньше 10 минут, иначе 3 × длительность; без длительности – 30 минут', () => {
  assert.equal(finalQaTimeoutMs(20), 10 * 60 * 1000);
  assert.equal(finalQaTimeoutMs(400), 1200 * 1000);
  assert.equal(finalQaTimeoutMs(undefined), 30 * 60 * 1000);
  assert.equal(finalQaTimeoutMs(0), 30 * 60 * 1000);
  assert.equal(finalQaTimeoutMs(Number.NaN), 30 * 60 * 1000);
});

test('runFinalQaSync: зависший QA убивается по таймауту, сборка продолжается', () => {
  const { runNodeTool } = require('../scripts/process');
  const spawned = [];
  const lines = [];
  const ok = runFinalQaSync({ enabled: true, finalPath: '/o/f.mp4', durationSec: 400, log: (m) => lines.push(m) }, {
    runNodeToolImpl: (script, args, options) => runNodeTool(script, args, {
      ...options,
      spawnSyncImpl: (command, argv, spawnOptions) => {
        spawned.push(spawnOptions);
        const error = Object.assign(new Error(`spawnSync ${command} ETIMEDOUT`), { code: 'ETIMEDOUT' });
        return { error, signal: 'SIGKILL', status: null, stdout: null, stderr: null };
      },
    }),
  });
  assert.equal(ok, false);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].timeout, 1200 * 1000);
  assert.equal(spawned[0].killSignal, 'SIGKILL');
  assert.deepEqual(lines, [
    'финал собран, идёт проверка (final QA); пропустить – --no-final-qa',
    'final QA не выполнен: проверка не уложилась в 20 мин и остановлена',
  ]);
});

// Настоящий путь супервизора тяжёлой очереди: таймаут -> launchError ETIMEDOUT -> строка в логе.
// Дочерний QA запускает «Chrome» отдельной группой процессов (detached, как Remotion): kill(-pgid)
// супервизора её не достаёт, на macOS нет setpriv. Сирота держала бы слот до AUTOMONTAGE_HEAVY_WAIT_MS.
test('runFinalQaSync: таймаут под тяжёлым слотом добивает отдельные группы из тикетов и освобождает слот', { skip: process.platform === 'win32' }, async (t) => {
  const { runNodeTool } = require('../scripts/process');
  const { tryAcquireHeavySlot, listHeavySlots, heavyQueueConfig } = require('../scripts/heavy-queue');
  // Хуки after идут по порядку регистрации: сначала добиваем «Chrome» по pid из файла, потом
  // удаляем временную папку (tempDir здесь не подходит – его хук отработал бы раньше).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-final-heavy-'));
  const marker = path.join(dir, 'detached.pid');
  t.after(() => {
    try { process.kill(Number(fs.readFileSync(marker, 'utf8')), 'SIGKILL'); } catch (_) { /* уже нет */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const hang = path.join(dir, 'hang.js');
  fs.writeFileSync(hang, [
    "const { spawn } = require('node:child_process');",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });",
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(child.pid));`,
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  const alive = (pid) => {
    try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
  };

  const config = heavyQueueConfig();
  const slot = tryAcquireHeavySlot({ label: 'final QA timeout', config });
  assert.ok(slot);
  const lines = [];
  let ok;
  try {
    ok = runFinalQaSync({ enabled: true, finalPath: path.join(dir, 'f.mp4'), durationSec: 400, log: (m) => lines.push(m) }, {
      runNodeToolImpl: (_script, _args, options) => runNodeTool(hang, [], { ...options, timeout: 1500 }),
    });
  } finally {
    slot.release();
  }
  assert.equal(ok, false);
  assert.equal(lines[1], 'final QA не выполнен: проверка не уложилась в 20 мин и остановлена');
  const pid = Number(fs.readFileSync(marker, 'utf8'));
  const end = Date.now() + 3000;
  while (alive(pid) && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(alive(pid), false, 'отдельная группа дочернего QA должна быть убита');
  assert.equal(listHeavySlots(config)[0].busy, false);
  const next = tryAcquireHeavySlot({ label: 'следующая сборка', config });
  assert.ok(next, 'слот должен быть свободен для следующей сборки');
  next.release();
});

test('final-qa.js --from-build: внутренняя ошибка – код 0, отчёт с ошибкой рядом с финалом', (t) => {
  const dir = tempDir(t);
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'qa', 'final-qa.js'), '--from-build', '--final', path.join(dir, 'missing.mp4')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /final QA не выполнен: .*финал не найден/);
  const files = fs.readdirSync(path.join(dir, 'qa'));
  assert.ok(files.some((f) => /^final-\d{8}-\d{6}\.json$/.test(f)), files.join(','));
});

test('final-qa.js без --from-build: ошибка отчёта – код 2', (t) => {
  const p = project(t);
  fs.writeFileSync(path.join(p.dir, 'project.json'), '{}');
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'qa', 'final-qa.js'), p.dir, '--final', path.join(p.dir, 'final', 'нет.mp4')], { encoding: 'utf8' });
  assert.equal(result.status, 2, result.stdout + result.stderr);
});

test('cli qa-final без projectDir – код 2 и подсказка', () => {
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'cli.js'), 'qa-final'], { encoding: 'utf8' });
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /automontage qa-final <папка ролика>/);
});

test('cli --help упоминает qa-final', () => {
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'cli.js'), '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /automontage qa-final <папка>/);
  assert.match(result.stdout, /--no-final-qa/);
});

// build.js целиком с заглушкой процессов (как в lesson-build.test.js): финальный QA зовётся
// отдельным node-процессом с путём финала, а --no-final-qa его выключает.
function runLessonBuild(t, extraArgs) {
  return runStubbedBuild(t, (id) => ['examples/demo-source.mp4', '--template', 'lesson',
    '--brief', 'examples/lesson-neutral-approved.json', '--frames', '25', '--id', id, ...extraArgs]);
}

function runStubbedBuild(t, buildArgs) {
  const dir = tempDir(t, 'qa-final-build-');
  const hook = path.join(dir, 'hook.js');
  const calls = path.join(dir, 'calls.jsonl');
  const heavy = path.join(dir, 'heavy');
  const id = `qa-final-${process.pid}-${Date.now()}`;
  t.after(() => {
    const out = path.join(ROOT, 'out');
    for (const name of fs.existsSync(out) ? fs.readdirSync(out) : []) {
      if (name.startsWith(`${id}.`) || name.startsWith(`${id}_`)) fs.rmSync(path.join(out, name), { recursive: true, force: true });
    }
  });
  fs.writeFileSync(hook, [
    "const childProcess = require('node:child_process');",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const execution = require(path.join(process.cwd(), 'scripts/heavy-execution'));",
    'execution.managedInvocation = (command, args, options) => ({ command, args, options });',
    'const realSpawnSync = childProcess.spawnSync;',
    "const PURE_NODE = new Set(['build-captions.js', 'quality-gate.js', 'dynamic-gate.js']);",
    'childProcess.spawnSync = (command, args, options) => {',
    "  fs.appendFileSync(process.env.AUTOMONTAGE_QA_FINAL_CAPTURE, JSON.stringify({ command, args }) + '\\n');",
    '  // Чистые Node-скрипты Dynamic (субтитры, гейты листа) работают по-настоящему: build.js читает их файлы.',
    '  if (command === process.execPath && PURE_NODE.has(path.basename(String(args[0])))) return realSpawnSync(command, args, options);',
    "  if (args.length === 1 && args[0] === '--version') return { status: 0, stdout: 'Python 3.12.0', stderr: '' };",
    "  if (command === 'ffprobe') return { status: 0, stdout: JSON.stringify({ streams: [{ codec_type: 'video', width: 1080, height: 1920, r_frame_rate: '25/1' }], format: { duration: '20' } }) };",
    "  if (path.basename(String(args[0])) === 'final-qa.js') return { status: 1, stdout: '', stderr: 'boom' };",
    "  return { status: 0, stdout: '' };",
    '};',
    '',
  ].join('\n'));
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts/build.js'), ...buildArgs(id)], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, AUTOMONTAGE_HEAVY_DIR: heavy, AUTOMONTAGE_QA_FINAL_CAPTURE: calls, NODE_OPTIONS: `--require=${hook}` },
  });
  const invocations = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  return { result, invocations, final: path.join(ROOT, 'out', `${id}.mp4`) };
}

test('build.js lesson: финальный QA – отдельный процесс; его сбой не роняет сборку', (t) => {
  const { result, invocations, final } = runLessonBuild(t, []);
  assert.equal(result.status, 0, result.stderr);
  const qa = invocations.filter((c) => path.basename(String(c.args[0])) === 'final-qa.js');
  assert.equal(qa.length, 1);
  assert.deepEqual(qa[0].args.slice(1, 6), ['--from-build', '--final', final, '--model', 'large-v3-turbo']);
  // Данные рендера для G14/G15: та же композиция, props и public lease, что у рендера урока.
  assert.equal(qa[0].args[6], '--render-json');
  const render = JSON.parse(qa[0].args[7]);
  const lessonRender = invocations.find((c) => c.args.includes('render') && c.args.includes('--public-dir'));
  assert.ok(lessonRender, JSON.stringify(invocations.map((c) => c.args.slice(0, 3))));
  const argAfter = (flag) => lessonRender.args[lessonRender.args.indexOf(flag) + 1];
  assert.equal(render.entry, 'src/index.js');
  assert.ok(lessonRender.args.includes(render.compositionId), render.compositionId);
  assert.equal(render.propsPath, argAfter('--props'));
  assert.equal(render.publicDir, argAfter('--public-dir'));
  assert.deepEqual([render.width, render.height], [1080, 1920]);
  assert.ok(render.fps > 0);
  assert.match(result.stdout, /финал собран, идёт проверка \(final QA\); пропустить – --no-final-qa/);
  assert.match(result.stdout, /final QA не выполнен: /);
  assert.match(result.stdout, /готово по утверждённому ТЗ/);
});

test('build.js lesson --no-final-qa: финальный QA не запускается', (t) => {
  const { result, invocations } = runLessonBuild(t, ['--no-final-qa']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(invocations.filter((c) => path.basename(String(c.args[0])) === 'final-qa.js').length, 0);
});

test('build.js Dynamic: финальный QA с композицией Dynamic и public/ корня движка', (t) => {
  const { result, invocations, final } = runStubbedBuild(t, (id) => ['examples/demo-source.mp4',
    '--scenario', 'examples/scenario-demo.json', '--no-transcribe', '--frames', '25', '--id', id]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const qa = invocations.filter((c) => path.basename(String(c.args[0])) === 'final-qa.js');
  assert.equal(qa.length, 1, JSON.stringify(invocations.map((c) => c.args.slice(0, 2))));
  assert.deepEqual(qa[0].args.slice(1, 6), ['--from-build', '--final', final, '--model', 'large-v3-turbo']);
  assert.equal(qa[0].args[6], '--render-json');
  const render = JSON.parse(qa[0].args[7]);
  assert.equal(render.entry, 'src/index.js');
  assert.equal(render.compositionId, 'Dynamic');
  assert.equal(render.publicDir, path.join(ROOT, 'public'));
  const dynamicRender = invocations.find((c) => c.args.includes('render') && c.args.includes('Dynamic'));
  assert.ok(dynamicRender, JSON.stringify(invocations.map((c) => c.args.slice(0, 3))));
  assert.equal(render.propsPath, dynamicRender.args[dynamicRender.args.indexOf('--props') + 1]);
  assert.deepEqual([render.width, render.height, render.fps], [1080, 1920, 25]);
  assert.match(result.stdout, /финал собран, идёт проверка \(final QA\); пропустить – --no-final-qa/);
});
