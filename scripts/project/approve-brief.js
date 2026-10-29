#!/usr/bin/env node
const path = require('node:path');

const {
  approveBrief,
  createOrOpenProject,
} = require('./workspace');
const { finalizeApproval } = require('./approve-final');
const { printCleanupHint } = require('./clean');

const args = process.argv.slice(2);
const confirmPreviewViewed = args.includes('--confirm-preview-viewed');
const [projectDirInput, draftInput] = args.filter(value => value !== '--confirm-preview-viewed');
const repositoryRoot = path.resolve(__dirname, '../..');
if (!projectDirInput || !draftInput) {
  console.error('Использование: node scripts/project/approve-brief.js <project-dir> <draft-json> [--confirm-preview-viewed] (kind читается из project.json)');
  process.exit(1);
}

try {
  const project = createOrOpenProject({ projectDir: projectDirInput });
  const draftPath = path.isAbsolute(draftInput)
    ? draftInput
    : path.join(project.dir, draftInput);
  const approved = approveBrief(project, draftPath, { root: repositoryRoot, confirmPreviewViewed });
  console.log(`approved: ${approved.jsonPath}`);
  if (approved.markdownPath) console.log(`markdown: ${approved.markdownPath}`);
  // Чистый полный preview этой версии становится финалом копированием, final QA – в фоне (#110, D-051).
  const final = finalizeApproval(project, approved.jsonPath);
  if (final.promoted) {
    console.log(`final: ${final.finalPath} (копия просмотренного preview, без рендера)`);
    if (!final.already) console.log('final QA идёт в фоне – отчёт придёт во входящие (automontage inbox)');
    // #113: финал готов – сколько места освободит чистка этого ролика (без удаления).
    printCleanupHint(project.dir);
  } else {
    console.log(`финал соберёт рендер: ${final.reason}`);
  }
} catch (error) {
  console.error(`Не удалось утвердить brief: ${error.message}`);
  process.exit(1);
}
