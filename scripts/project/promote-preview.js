// Продвижение чистого preview в финал (#110, DECISIONS.md D-051). После утверждения brief тот самый полный
// чистый preview, который смотрел автор, копируется в renders/vNN-preview/final.mp4 и final/<slug>.mp4, а в
// паспорте появляется завершённый render с briefPath утверждённого JSON. Рендера нет: props чистого preview
// побитно равны props финала (tests/clean-preview.test.js), и кадры уже собраны в качестве финала.
//
// Продвигается только то, что точно совпадает с утверждённым: preview полный, чистый (quality "final"),
// собран для этого черновика (sha256 байтов черновика) и текущего исходника (sha256), в размер и FPS
// утверждённого вывода, а байты файла на диске равны записанному sha256. Иначе – отказ без изменений:
// финал собирает агент рендером, как раньше (фрагмент, 4K, устаревший preview, старый путь build.js).
//
// Копия, а не ссылка на previews/: automontage clean удаляет previews/, финал от этого не страдает.
// Сбой копирования не оставляет полуфинала: папка рендера удаляется, прежний final возвращается.
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const { readProjectManifest, resolveProjectPath, withProjectMutation } = require('./workspace');

const RENDER_LABEL = 'preview';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const toPosix = (value) => value.split(path.sep).join('/');

function hashRegularFile(fileSystem, filename) {
  const before = fileSystem.lstatSync(filename);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('promotion input must be a regular file');
  const descriptor = fileSystem.openSync(filename, fileSystem.constants.O_RDONLY | (fileSystem.constants.O_NOFOLLOW || 0));
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let read;
    do {
      read = fileSystem.readSync(descriptor, buffer, 0, buffer.length, null);
      if (read > 0) hash.update(buffer.subarray(0, read));
    } while (read > 0);
  } finally {
    fileSystem.closeSync(descriptor);
  }
  return hash.digest('hex');
}

// Копия с fsync. FICLONE на APFS/btrfs делает копию мгновенной и без лишнего места, иначе – обычная копия.
function copyDurable(fileSystem, source, destination) {
  fileSystem.copyFileSync(source, destination, fileSystem.constants.COPYFILE_EXCL | (fileSystem.constants.COPYFILE_FICLONE || 0));
  const descriptor = fileSystem.openSync(destination, 'r+');
  try { fileSystem.fsyncSync(descriptor); } finally { fileSystem.closeSync(descriptor); }
}

function removeIfPresent(fileSystem, target) {
  try { fileSystem.unlinkSync(target); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
}

// Утверждённый brief без полей, которые добавляет само утверждение, равен черновику: preview черновика
// показывает ровно то, что соберёт финал утверждённой версии.
function comparableBrief(brief) {
  const { status, approval, brollApproval, brollReviewPolicy, ...rest } = brief;
  return {
    ...rest,
    scenes: Array.isArray(rest.scenes) ? rest.scenes.map(({ brollIntent, ...scene }) => scene) : rest.scenes,
  };
}

// Почему preview нельзя продвинуть, или null. Только чтение: паспорт, черновик, исходник, байты preview.
function promotionProblem(projectDir, manifest, approvedRelative, fileSystem, expectedPreviewSha256) {
  const approvedEntry = manifest.briefs.find((brief) => brief.jsonPath === approvedRelative);
  if (!approvedEntry || approvedEntry.status !== 'approved' || manifest.currentBrief !== approvedRelative) {
    return 'нужен текущий утверждённый brief';
  }
  const preview = manifest.currentPreview;
  if (!preview) return 'preview нет';
  // Пульт и Review передают sha256 того preview, который человек смотрел при утверждении.
  if (expectedPreviewSha256 !== undefined && preview.sha256 !== expectedPreviewSha256) return 'preview изменился после утверждения';
  if (preview.quality !== 'final') return 'preview собран в черновом качестве (фрагмент, 4K или до #110) – финал собирается рендером';
  if (preview.kind !== 'full') return 'preview не полный ролик';
  const draftEntry = manifest.briefs.find((brief) => brief.jsonPath === preview.briefPath);
  if (!draftEntry || draftEntry.status !== 'draft' || draftEntry.revision !== approvedEntry.revision
    || draftEntry.kind !== approvedEntry.kind) {
    return 'preview относится к другому черновику';
  }
  const draftPath = resolveProjectPath(projectDir, draftEntry.jsonPath, { fileSystem, mustExist: true, type: 'file' });
  const approvedPath = resolveProjectPath(projectDir, approvedRelative, { fileSystem, mustExist: true, type: 'file' });
  const draftBytes = fileSystem.readFileSync(draftPath);
  if (!preview.briefSha256 || sha256(draftBytes) !== preview.briefSha256) return 'preview относится к другому черновику';
  const draft = JSON.parse(draftBytes.toString('utf8'));
  const approved = JSON.parse(fileSystem.readFileSync(approvedPath, 'utf8'));
  if (JSON.stringify(comparableBrief(draft)) !== JSON.stringify(comparableBrief(approved))) {
    return 'утверждённый brief отличается от черновика preview';
  }
  const output = approved.output;
  if (preview.fromSec !== 0 || preview.toSec !== output.durationInFrames / output.fps) return 'preview не полный ролик';
  if (preview.width !== output.width || preview.height !== output.height || Math.abs(preview.fps - output.fps) > 1e-6) {
    return 'размер или FPS preview не совпадают с утверждённым выводом';
  }
  const sourcePath = resolveProjectPath(projectDir, manifest.source.localPath, { fileSystem, mustExist: true, type: 'file' });
  if (!preview.sourceSha256 || hashRegularFile(fileSystem, sourcePath) !== preview.sourceSha256) {
    return 'исходник изменился после preview';
  }
  const previewPath = resolveProjectPath(projectDir, preview.filePath, { fileSystem, mustExist: true, type: 'file' });
  if (hashRegularFile(fileSystem, previewPath) !== preview.sha256) return 'байты preview на диске не совпадают с паспортом';
  return null;
}

// Финал этой версии уже продвинут из того же preview: повтор утверждения ничего не меняет.
function alreadyPromoted(projectDir, manifest, approvedRelative, fileSystem) {
  const latest = manifest.renders.find((render) => render.dir === manifest.latestRender);
  if (!latest || latest.status !== 'complete' || latest.source !== 'preview' || latest.briefPath !== approvedRelative) return null;
  if (!manifest.currentPreview || latest.sha256 !== manifest.currentPreview.sha256) return null;
  const finalPath = resolveProjectPath(projectDir, manifest.final, { fileSystem, mustExist: false, type: 'file' });
  if (!fileSystem.existsSync(finalPath)) return null;
  return { finalPath, renderDir: latest.dir, sha256: latest.sha256 };
}

// Возвращает { promoted: true, finalPath, renderDir, sha256, already } или { promoted: false, reason }.
// Отказ по условиям – не ошибка: утверждение уже состоялось, финал соберёт агент рендером. Сбой ввода-вывода
// посреди копирования – исключение после отката.
function promoteApprovedPreview(workspace, approvedJsonPath, {
  fileSystem = fs,
  temporaryId = randomUUID,
  now = () => new Date(),
  expectedPreviewSha256,
} = {}) {
  const projectDir = workspace.dir;
  const current = { ...workspace, manifest: readProjectManifest(projectDir) };
  const approvedRelative = toPosix(path.relative(projectDir, path.resolve(approvedJsonPath)));
  return withProjectMutation(current, (transaction) => {
    const manifest = transaction.manifest;
    const done = alreadyPromoted(projectDir, manifest, approvedRelative, fileSystem);
    if (done) return { promoted: true, already: true, ...done };
    const problem = promotionProblem(projectDir, manifest, approvedRelative, fileSystem, expectedPreviewSha256);
    if (problem) return { promoted: false, reason: problem };

    const preview = manifest.currentPreview;
    const version = manifest.renders.reduce((highest, render) => Math.max(highest, Number(render.version) || 0), 0) + 1;
    const renderRelative = path.posix.join('renders', `v${String(version).padStart(2, '0')}-${RENDER_LABEL}`);
    resolveProjectPath(projectDir, 'renders', { fileSystem, mustExist: true, type: 'directory' });
    const renderDir = resolveProjectPath(projectDir, renderRelative, { fileSystem, mustExist: false, type: 'directory' });
    const renderFinal = path.join(renderDir, 'final.mp4');
    const previewPath = resolveProjectPath(projectDir, preview.filePath, { fileSystem, mustExist: true, type: 'file' });
    const finalPath = resolveProjectPath(projectDir, manifest.final, { fileSystem, mustExist: false, type: 'file' });
    const token = String(temporaryId()).replace(/[^A-Za-z0-9_-]/gu, '');
    const finalTemp = path.join(path.dirname(finalPath), `.${path.basename(finalPath)}.promote-${token}`);
    const finalBackup = path.join(path.dirname(finalPath), `.${path.basename(finalPath)}.previous-${token}`);
    let createdRenderDir = false;
    let backedUp = false;
    let replaced = false;
    let committed = false;
    try {
      fileSystem.mkdirSync(renderDir);
      createdRenderDir = true;
      copyDurable(fileSystem, previewPath, renderFinal);
      if (hashRegularFile(fileSystem, renderFinal) !== preview.sha256) throw new Error('копия финала не совпала с preview по sha256');
      fileSystem.mkdirSync(path.dirname(finalPath), { recursive: true });
      copyDurable(fileSystem, renderFinal, finalTemp);
      if (hashRegularFile(fileSystem, finalTemp) !== preview.sha256) throw new Error('копия финала не совпала с preview по sha256');
      if (fileSystem.existsSync(finalPath)) {
        fileSystem.linkSync(finalPath, finalBackup);
        backedUp = true;
      }
      fileSystem.renameSync(finalTemp, finalPath);
      replaced = true;
      const nextManifest = structuredClone(manifest);
      const entry = {
        version, label: RENDER_LABEL, dir: renderRelative, briefPath: approvedRelative,
        status: 'complete', source: 'preview', sha256: preview.sha256,
      };
      nextManifest.renders.push(entry);
      nextManifest.latestRender = renderRelative;
      nextManifest.updatedAt = now().toISOString();
      workspace.manifest = transaction.commitManifest(nextManifest, { purpose: 'promote-preview-manifest' });
      committed = true;
    } catch (error) {
      try {
        removeIfPresent(fileSystem, finalTemp);
        if (replaced) {
          if (backedUp) { fileSystem.renameSync(finalBackup, finalPath); backedUp = false; } else removeIfPresent(fileSystem, finalPath);
        }
        if (createdRenderDir) fileSystem.rmSync(renderDir, { recursive: true, force: true });
      } catch (rollbackError) {
        error.rollbackError = rollbackError;
      }
      throw error;
    } finally {
      // Резервную копию прежнего финала удаляем, только когда она точно не нужна: всё записано или прежний
      // финал не трогали. Если возврат не удался, копия остаётся рядом – это единственные байты прежнего финала.
      if (backedUp && committed) { try { removeIfPresent(fileSystem, finalBackup); } catch (_) { /* финал и паспорт уже записаны */ } }
      else if (backedUp && !replaced) removeIfPresent(fileSystem, finalBackup);
    }
    return { promoted: true, already: false, finalPath, renderDir: renderRelative, sha256: preview.sha256 };
  }, { fileSystem, temporaryId });
}

module.exports = { promoteApprovedPreview, promotionProblem };
