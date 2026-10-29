// Шаг после успешного approveBrief (#110, DECISIONS.md D-051): продвинуть просмотренный чистый preview в
// финал и поставить фоновый final QA. Общий для пульта, Review и scripts/project/approve-brief.js.
// Никогда не бросает: утверждение уже записано. Отказ или сбой продвижения оставляют обычный путь –
// строка «Утверждено» во входящих, финал собирает агент рендером.
const { promoteApprovedPreview } = require('./promote-preview');

const message = (error) => (error && error.message ? error.message : String(error));

function finalizeApproval(workspace, approvedJsonPath, {
  promote = promoteApprovedPreview,
  startQa = (job) => require('../qa/final-qa-job').startFinalQaJob(job),
  expectedPreviewSha256,
} = {}) {
  let result;
  try {
    result = promote(workspace, approvedJsonPath, expectedPreviewSha256 === undefined ? {} : { expectedPreviewSha256 });
  } catch (error) {
    // Паспорт сейчас пишет другой процесс (агент): это не сбой копирования, финал соберёт агент.
    if (error?.code === 'PROJECT_MANIFEST_CONFLICT') return { promoted: false, reason: 'паспорт ролика занят другой записью' };
    return { promoted: false, reason: `копирование не удалось: ${message(error)}` };
  }
  if (!result.promoted || result.already) return result;
  try {
    const job = startQa({ projectDir: workspace.dir, renderDir: result.renderDir, sha256: result.sha256 });
    return { ...result, qa: job?.status || null };
  } catch (error) {
    return { ...result, qa: 'failed', qaError: message(error) };
  }
}

module.exports = { finalizeApproval };
