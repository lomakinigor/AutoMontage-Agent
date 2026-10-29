// Режим GPU для layer render (D-052). Headless Chrome без флага --gl рисует
// программно (SwiftShader); на Apple Silicon --gl=angle (Metal) считает слой
// примерно вдвое быстрее при SSIM >= 0.99. Здесь только решение, без запуска.

const GPU_ENV = 'AUTOMONTAGE_GPU';
// Кэш видео-кадров Remotion для слоя: 2 ГиБ.
const LAYER_OFFTHREAD_CACHE_BYTES = 2 * 1024 ** 3;

function gpuMode(env = process.env) {
  const raw = env[GPU_ENV];
  const value = raw === undefined ? '' : String(raw).trim().toLowerCase();
  if (value === '' || value === 'auto') return 'auto';
  if (value === 'off') return 'off';
  throw new Error(`${GPU_ENV}: допустимы значения auto|off`);
}

function layerGpuPlan({ env = process.env, platform = process.platform, arch = process.arch } = {}) {
  if (gpuMode(env) === 'off') {
    return { gl: null, reason: `выключено ${GPU_ENV}=off` };
  }
  if (platform === 'darwin' && arch === 'arm64') {
    return { gl: 'angle', reason: 'Apple Silicon: Chrome рисует через ANGLE (Metal)' };
  }
  return { gl: null, reason: 'ускорение на этой платформе не проверено (#93)' };
}

// Строка для doctor: какой режим выберет layer render и почему. Не бросает.
// Живую пробу браузера не делаем: `remotion gpu` в Remotion 4.0.536 падает
// на chrome://gpu (net::ERR_FAILED), поэтому судим по платформе и env.
function describeLayerGpu({ env = process.env, platform = process.platform, arch = process.arch } = {}) {
  let plan;
  try {
    plan = layerGpuPlan({ env, platform, arch });
  } catch (err) {
    return { level: 'warn', message: `Рендер слоя: ${err.message}; layer render не запустится – исправь значение (auto|off) или убери переменную` };
  }
  if (plan.gl) return { level: 'ok', message: `Рендер слоя: GPU (${plan.gl}) – ${plan.reason}` };
  return { level: 'ok', message: `Рендер слоя: CPU – ${plan.reason}` };
}

module.exports = { GPU_ENV, LAYER_OFFTHREAD_CACHE_BYTES, gpuMode, layerGpuPlan, describeLayerGpu };
