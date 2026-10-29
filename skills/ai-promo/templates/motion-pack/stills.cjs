#!/usr/bin/env node
// Контрольные кадры пакета: node projects/<id>/motion-vNN/stills.cjs [кадр ...] (из корня движка).
// Без аргументов – 6 кадров равномерно по TOTAL. PNG пишутся в projects/<id>/motion-vNN/out/stills/frame-NNNN.png.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PACK = __dirname;
const ROOT = path.resolve(PACK, '..', '..', '..');
const { resolveRemotionCommand } = require(path.join(ROOT, 'scripts', 'env'));
const { acquireHeavySlot } = require(path.join(ROOT, 'scripts', 'heavy-queue'));

function readTotal() {
  const { transformSync } = require(require.resolve('esbuild', { paths: [ROOT] }));
  const source = fs.readFileSync(path.join(PACK, 'src', 'tokens.js'), 'utf8');
  const module = { exports: {} };
  new Function('module', 'exports', transformSync(source, { loader: 'js', format: 'cjs' }).code)(module, module.exports);
  return module.exports.TOTAL;
}

async function main() {
  const total = readTotal();
  const asked = process.argv.slice(2).map(Number);
  if (asked.some((n) => !Number.isInteger(n) || n < 0 || n >= total)) {
    throw new Error(`кадры – целые числа от 0 до ${total - 1}`);
  }
  const frames = asked.length ? asked : Array.from({ length: 6 }, (_, i) => Math.min(total - 1, Math.round((i + 0.5) * total / 6)));
  const outDir = path.join(PACK, 'out', 'stills');
  fs.mkdirSync(outDir, { recursive: true });
  const remotion = resolveRemotionCommand(ROOT);
  const slot = await acquireHeavySlot({ label: `ai-promo stills ${path.basename(path.dirname(PACK))}/${path.basename(PACK)}` });
  try {
    for (const frame of frames) {
      const file = path.join(outDir, `frame-${String(frame).padStart(4, '0')}.png`);
      const result = spawnSync(remotion.command, [...remotion.argsPrefix, 'still', path.join(PACK, 'src', 'index.jsx'), 'Promo', file,
        `--frame=${frame}`, '--public-dir', path.join(PACK, 'public'), '--props', JSON.stringify({ withAudio: false }),
        '--log=error', '--overwrite'], { cwd: ROOT, stdio: 'inherit' });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`still кадра ${frame} завершился с кодом ${result.status}`);
      console.log(`✅ ${path.relative(ROOT, file)}`);
    }
  } finally {
    slot.release();
  }
}

main().catch((error) => { console.error(`❌ контрольные кадры: ${error.message}`); process.exitCode = 1; });
