// whisper-check.js: рабочая проверка связки faster-whisper + PyAV для doctor.
// Импорта мало: faster-whisper 1.2.1 импортируется и с PyAV 19, но падает на первом
// же файле (`open() got an unexpected keyword argument 'metadata_errors'`). Поэтому
// проба декодирует крошечный WAV из памяти тем же decode_audio, что и транскрипция.

const WHISPER_PROBE_PY = [
  'import io, json, wave',
  'out = {}',
  'try:',
  '    import faster_whisper',
  '    out["fasterWhisper"] = faster_whisper.__version__',
  'except Exception:',
  '    print(json.dumps({"missing": True}))',
  '    raise SystemExit(0)',
  'try:',
  '    import av',
  '    out["av"] = av.__version__',
  'except Exception:',
  '    out["av"] = None',
  'try:',
  '    from faster_whisper.audio import decode_audio',
  '    buf = io.BytesIO()',
  '    with wave.open(buf, "wb") as w:',
  '        w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)',
  '        w.writeframes(b"\\x00\\x00" * 1600)',
  '    buf.seek(0)',
  '    out["decode"] = len(decode_audio(buf)) > 0',
  'except Exception as e:',
  '    out["decode"] = False',
  '    out["error"] = f"{type(e).__name__}: {e}"',
  'print(json.dumps(out))',
].join('\n');

const FIX_HINT = 'Выполни `pip install -r requirements.txt` в окружении движка (.venv): он поставит совместимую версию PyAV';

function evaluateWhisperProbe({ status, stdout }) {
  let data = null;
  try {
    const line = String(stdout || '').trim().split('\n').pop();
    data = JSON.parse(line);
  } catch (_) { data = null; }
  if (status !== 0 || !data) {
    return { level: 'warn', message: `faster-whisper не удалось проверить. ${FIX_HINT}` };
  }
  if (data.missing) {
    return {
      level: 'warn',
      message: 'faster-whisper не установлен: `pip install -r requirements.txt`. Нужен для распознавания речи '
        + '(для монтажа по готовому --scenario с --no-transcribe не требуется)',
    };
  }
  const versions = `faster-whisper ${data.fasterWhisper}, PyAV ${data.av || 'нет'}`;
  if (data.decode === true) return { level: 'ok', message: `${versions}: декодирование звука работает (транскрипция речи)` };
  return {
    level: 'warn',
    message: `${versions}: транскрипция упадёт на первом файле (${data.error || 'decode_audio не вернул звук'}). ${FIX_HINT}`,
  };
}

module.exports = { WHISPER_PROBE_PY, evaluateWhisperProbe };
