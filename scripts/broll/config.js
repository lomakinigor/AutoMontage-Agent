'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { failure } = require('./remote');
function loadBrollConfig({ env = process.env, root } = {}) {
  let apiKey =
    typeof env.PEXELS_API_KEY === 'string' ? env.PEXELS_API_KEY.trim() : '';
  if (!apiKey && root) {
    try {
      const filename = path.join(root, '.env');
      if (fs.statSync(filename).size > 65536)
        throw failure('BROLL_CONFIG_INVALID');
      const text = fs.readFileSync(filename, 'utf8');
      for (const line of text.split(/\r?\n/)) {
        const match = line.match(
          /^\s*(?:export\s+)?PEXELS_API_KEY\s*=\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^#\r\n]*))\s*(?:#.*)?$/,
        );
        if (match) apiKey = (match[1] ?? match[2] ?? match[3]).trim();
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw failure('BROLL_CONFIG_INVALID');
    }
  }
  if (!apiKey) throw failure('BROLL_KEY_MISSING');
  if (apiKey.length > 512 || /[\x00-\x20\x7f]/.test(apiKey))
    throw failure('BROLL_CONFIG_INVALID');
  return { provider: 'pexels', apiKey };
}
module.exports = { loadBrollConfig };
