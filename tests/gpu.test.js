const test = require('node:test');
const assert = require('node:assert/strict');
const { gpuMode, layerGpuPlan, describeLayerGpu, LAYER_OFFTHREAD_CACHE_BYTES } = require('../scripts/gpu');

test('gpuMode: пусто и auto – auto, off в любом регистре – off', () => {
  assert.equal(gpuMode({}), 'auto');
  assert.equal(gpuMode({ AUTOMONTAGE_GPU: '' }), 'auto');
  assert.equal(gpuMode({ AUTOMONTAGE_GPU: ' Auto ' }), 'auto');
  assert.equal(gpuMode({ AUTOMONTAGE_GPU: 'OFF' }), 'off');
});

test('gpuMode: неизвестное значение – ошибка с именем переменной', () => {
  for (const value of ['gpu', 'on', '1', 'angle', 'off;rm']) {
    assert.throws(() => gpuMode({ AUTOMONTAGE_GPU: value }), /AUTOMONTAGE_GPU.*auto\|off/);
  }
});

test('layerGpuPlan: angle только на darwin arm64 в режиме auto', () => {
  assert.equal(layerGpuPlan({ env: {}, platform: 'darwin', arch: 'arm64' }).gl, 'angle');
  assert.equal(layerGpuPlan({ env: { AUTOMONTAGE_GPU: 'off' }, platform: 'darwin', arch: 'arm64' }).gl, null);
  for (const [platform, arch] of [['darwin', 'x64'], ['linux', 'x64'], ['linux', 'arm64'], ['win32', 'x64']]) {
    const plan = layerGpuPlan({ env: {}, platform, arch });
    assert.equal(plan.gl, null);
    assert.match(plan.reason, /не проверено/);
  }
  assert.match(layerGpuPlan({ env: { AUTOMONTAGE_GPU: 'off' }, platform: 'darwin', arch: 'arm64' }).reason, /AUTOMONTAGE_GPU=off/);
});

test('LAYER_OFFTHREAD_CACHE_BYTES – 2 ГиБ', () => assert.equal(LAYER_OFFTHREAD_CACHE_BYTES, 2 * 1024 ** 3));

test('describeLayerGpu: текст для doctor по платформам и режимам', () => {
  const mac = describeLayerGpu({ env: {}, platform: 'darwin', arch: 'arm64' });
  assert.equal(mac.level, 'ok');
  assert.match(mac.message, /angle/);
  const off = describeLayerGpu({ env: { AUTOMONTAGE_GPU: 'off' }, platform: 'darwin', arch: 'arm64' });
  assert.equal(off.level, 'ok');
  assert.match(off.message, /AUTOMONTAGE_GPU=off/);
  const linux = describeLayerGpu({ env: {}, platform: 'linux', arch: 'x64' });
  assert.equal(linux.level, 'ok');
  assert.match(linux.message, /CPU/);
});

test('describeLayerGpu: неверное значение не бросает, а даёт warn', () => {
  const bad = describeLayerGpu({ env: { AUTOMONTAGE_GPU: 'gpu' }, platform: 'darwin', arch: 'arm64' });
  assert.equal(bad.level, 'warn');
  assert.match(bad.message, /auto\|off/);
  assert.doesNotMatch(bad.message, /будет использован/);
  assert.match(bad.message, /не запустится/);
});
