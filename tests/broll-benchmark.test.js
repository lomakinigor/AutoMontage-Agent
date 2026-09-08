'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const script = path.resolve(__dirname, '../scripts/broll/benchmark-openclip.py');
const python = ['python3', 'python'].find((name) =>
  spawnSync(name, ['-S', '-c', 'import sys; assert sys.version_info >= (3, 9)'],
    { encoding: 'utf8', timeout: 5000 }).status === 0);
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'broll-benchmark-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const labels = { relevantThreshold: 2, grades: { sample: { A: 0, B: 0, C: 1, D: 2, E: 3, F: 2, G: 3 } } };
  const blindMap = { sample: Object.fromEntries('ABCDEFG'.split('').map((tag) => [tag, tag.toLowerCase()])) };
  const candidates = 'abcdefg'.split('').map((id, index) => ({
    id, providerRank: index + 1, file: `images/${id}.img`, sha256: sha('fixture'), bytes: 7,
  }));
  const corpus = { schemaVersion: 1, provider: 'openverse', queries: [{
    id: 'sample', ru: 'люди работают', en: 'people working', candidates,
  }] };
  const scores = { schemaVersion: 1, queries: [{ id: 'sample', candidates: candidates.map((c, index) => ({
    id: c.id, scoreRu: (index + 1) / 10, scoreEn: (index + 1) / 10,
  })) }] };
  const files = {};
  function write(name, value) {
    files[name] = path.join(root, `${name}.json`);
    fs.writeFileSync(files[name], JSON.stringify(value));
    return sha(fs.readFileSync(files[name]));
  }
  function publish() {
    const labelsSha256 = write('labels', labels);
    const blindMapSha256 = write('blind-map', blindMap);
    corpus.bindings = { labelsSha256, blindMapSha256 };
    const corpusSha256 = write('corpus', corpus);
    scores.inputHashes = { corpusSha256, labelsSha256, blindMapSha256 };
    write('scores', scores);
  }
  function run(extra = [], overrides = {}) {
    return spawnSync(python, ['-S', script, '--corpus', files.corpus,
      '--labels', files.labels, '--blind-map', files['blind-map'],
      '--output', path.join(root, 'result.json'), ...extra],
    { encoding: 'utf8', timeout: 10000, ...overrides });
  }
  publish();
  return { root, files, corpus, labels, blindMap, scores, publish, run };
}

test('optional benchmark metrics replay needs no site packages and recomputes real ranks', { skip: !python }, (t) => {
  const f = fixture(t);
  const r = f.run(['--metrics-only', '--scores', f.files.scores]);
  assert.equal(r.status, 0, r.stderr);
  const result = JSON.parse(fs.readFileSync(path.join(f.root, 'result.json'), 'utf8'));
  assert.equal(result.mode, 'metrics-only');
  assert.deepEqual(result.queries[0].siglipRu.ids, ['g', 'f', 'e', 'd', 'c']);
  assert.equal(result.macroMetrics.providerOrder.meanRelevanceAt5, 1.2);
  assert.equal(result.macroMetrics.providerOrder.precisionAt5, 0.4);
  assert.equal(result.macroMetrics.siglipRu.meanRelevanceAt5, 2.2);
  assert.equal(result.macroMetrics.siglipRu.precisionAt5, 0.8);
  assert.equal(result.macroMetrics.siglipRu.top1Relevance, 3);
});

test('ties retain provider order and published output cannot silently be overwritten', { skip: !python }, (t) => {
  const f = fixture(t);
  f.scores.queries[0].candidates.forEach((c) => { c.scoreRu = 0.5; c.scoreEn = 0.5; });
  f.publish();
  const args = ['--metrics-only', '--scores', f.files.scores];
  assert.equal(f.run(args).status, 0);
  const output = path.join(f.root, 'result.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(output)).queries[0].siglipRu.ids, ['a', 'b', 'c', 'd', 'e']);
  const before = fs.readFileSync(output);
  const r = f.run(args);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /output already exists/i);
  assert.deepEqual(fs.readFileSync(output), before);
});

for (const [name, mutate, pattern] of [
  ['empty corpus', (f) => { f.corpus.queries = []; }, /queries must contain/],
  ['boolean grade', (f) => { f.labels.grades.sample.A = true; }, /grade must be an integer/],
  ['missing label', (f) => { delete f.labels.grades.sample.A; }, /labels and blind map/],
  ['extra blind tag alias with a divergent grade', (f) => {
    f.blindMap.sample.EXTRA_DUPLICATE = 'a';
    f.labels.grades.sample.EXTRA_DUPLICATE = 3;
  }, /blind map must cover every usable candidate exactly once/],
  ['duplicate candidate', (f) => { f.corpus.queries[0].candidates[1].id = 'a'; }, /duplicate candidate/],
  ['path traversal', (f) => { f.corpus.queries[0].candidates[0].file = '../outside.img'; }, /relative image path/],
  ['duplicate score', (f) => { f.scores.queries[0].candidates[1].id = 'a'; }, /score candidates/],
  ['non-finite score', (f) => { f.scores.queries[0].candidates[0].scoreRu = 'NaN'; }, /finite cosine/],
]) {
  test(`benchmark rejects ${name} before optional imports`, { skip: !python }, (t) => {
    const f = fixture(t); mutate(f); f.publish();
    const r = f.run(['--metrics-only', '--scores', f.files.scores]);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, pattern);
    assert.equal(fs.existsSync(path.join(f.root, 'result.json')), false);
  });
}

test('corpus/label binding and replay input hashes reject changed evidence', { skip: !python }, (t) => {
  const f = fixture(t);
  fs.appendFileSync(f.files.labels, '\n');
  const r = f.run(['--metrics-only', '--scores', f.files.scores]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /label.*hash mismatch/i);
  f.publish();
  f.scores.inputHashes.corpusSha256 = '0'.repeat(64);
  fs.writeFileSync(f.files.scores, JSON.stringify(f.scores));
  const changed = f.run(['--metrics-only', '--scores', f.files.scores]);
  assert.equal(changed.status, 2);
  assert.match(changed.stderr, /score input hash mismatch/i);
});

test('image bytes are checked before importing torch; no placeholder fallback', { skip: !python }, (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, 'images'));
  fs.writeFileSync(path.join(f.root, 'images/a.img'), 'changed');
  const r = f.run(['--images-root', f.root, '--model', f.root, '--model-manifest', f.files.corpus]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /image hash mismatch/i);
});

test('missing optional packages give an actionable error without downloads', { skip: !python }, (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, 'images'));
  'abcdefg'.split('').forEach((id) => fs.writeFileSync(path.join(f.root, `images/${id}.img`), 'fixture'));
  const model = path.join(f.root, 'model');
  fs.mkdirSync(model);
  const entries = [
    'open_clip_config.json', 'open_clip_model.safetensors', 'README.md',
    'special_tokens_map.json', 'tokenizer.json', 'tokenizer_config.json',
  ].map((file) => {
    const contents = file === 'open_clip_config.json'
      ? JSON.stringify({ model_cfg: { vision_cfg: { timm_model_pretrained: false }, text_cfg: {} } })
      : 'fixture';
    fs.writeFileSync(path.join(model, file), contents);
    return { file, bytes: Buffer.byteLength(contents), sha256: sha(contents) };
  });
  const manifest = path.join(f.root, 'model-manifest.json');
  fs.writeFileSync(manifest, JSON.stringify({ modelId: 'fixture/model', revision: 'a'.repeat(40), license: 'MIT', files: entries }));
  const r = f.run(['--images-root', f.root, '--model', model, '--model-manifest', manifest]);
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /Optional dependencies unavailable/);
  assert.match(r.stderr, /no packages were installed/);
  assert.doesNotMatch(r.stderr, /Traceback/);
  assert.equal(fs.existsSync(path.join(f.root, 'result.json')), false);
});

test('an image symlink cannot escape the chosen corpus directory', { skip: !python || process.platform === 'win32' }, (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, 'images'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'broll-benchmark-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'a.img'), 'fixture');
  fs.symlinkSync(path.join(outside, 'a.img'), path.join(f.root, 'images/a.img'));
  const r = f.run(['--images-root', f.root, '--model', f.root, '--model-manifest', f.files.corpus]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /escapes its root/);
});

test('RSS conversion uses Darwin bytes, Linux KiB and unavailable elsewhere', { skip: !python }, () => {
  const code = "import runpy,json,sys; m=runpy.run_path(sys.argv[1]); f=m['rss_to_bytes']; print(json.dumps([f(123,'darwin'),f(123,'linux'),f(123,'win32')]))";
  const r = spawnSync(python, ['-S', '-c', code, script], { encoding: 'utf8', timeout: 10000 });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), [123, 125952, null]);
});

test('published snapshot reproduces all original measured metrics without torch or image bytes', { skip: !python }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'broll-benchmark-snapshot-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.resolve(__dirname, '../examples/broll-benchmark');
  const output = path.join(root, 'replay.json');
  const r = spawnSync(python, ['-S', script, '--corpus', path.join(data, 'corpus.json'),
    '--labels', path.join(data, 'labels.json'), '--blind-map', path.join(data, 'blind-map.json'),
    '--metrics-only', '--scores', path.join(data, 'scores.json'), '--output', output],
  { encoding: 'utf8', timeout: 10000 });
  assert.equal(r.status, 0, r.stderr);
  const replay = JSON.parse(fs.readFileSync(output));
  const original = JSON.parse(fs.readFileSync(path.join(data, 'original-results.json')));
  assert.deepEqual(replay.macroMetrics, original.macroMetrics);
  assert.deepEqual(replay.queries.map((q) => q.candidateCount), [12, 12, 12, 12, 9]);
  assert.deepEqual(replay.queries.map((q) => q.excludedCount), [0, 0, 0, 0, 3]);
  for (const [index, query] of replay.queries.entries()) {
    for (const method of ['providerOrder', 'siglipRu', 'siglipEn', 'siglipBilingualMean']) {
      assert.deepEqual(query[method], original.queries[index][method]);
    }
  }
});
