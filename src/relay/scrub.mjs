/**
 * relay 状态清理（P0）：旧 blob 清除 + ledger 内容投影重建。
 * 只处理已落盘的数据，不联网；dry-run 先报清单，apply 先备份再原子替换。
 */
import {
  copyFileSync, existsSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export const LEDGER_CONTENT_FIELDS = ['stdout_head', 'stdout_tail', 'stderr_head', 'stderr_tail', 'command_argv', 'pipeline_hash_material', 'changed_files'];
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function projectLedgerLine(line) {
  let record;
  try { record = JSON.parse(line); } catch { return { changed: false, line }; }
  const result = record?.result ?? record?.envelope ?? null;
  if (result === null || typeof result !== 'object') return { changed: false, line };
  let changed = false;
  for (const field of LEDGER_CONTENT_FIELDS) {
    if (field in result) { delete result[field]; changed = true; }
  }
  if ('patch_sha256' in result) { result.patch_sha256 = null; changed = true; }
  if ('workspace' in result && typeof result.workspace === 'object' && result.workspace !== null) {
    if ('changed_files' in result.workspace) { delete result.workspace.changed_files; changed = true; }
    if ('patch_sha256' in result.workspace) { result.workspace.patch_sha256 = null; changed = true; }
  }
  return { changed, line: changed ? JSON.stringify(record) : line };
}

/** 清理 ledger：默认 dry-run；apply 时备份 .bak-<ts> 后原子替换。 */
export function scrubLedger(ledgerPath, { dryRun = true, now = Date.now() } = {}) {
  if (!existsSync(ledgerPath)) return { ok: true, exists: false, changed: 0, lines: 0, backup: null };
  const text = readFileSync(ledgerPath, 'utf8');
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  let changed = 0;
  const rewritten = lines.map((line) => {
    const projected = projectLedgerLine(line);
    if (projected.changed) changed += 1;
    return projected.line;
  });
  if (dryRun || changed === 0) return { ok: true, exists: true, changed, lines: lines.length, backup: null, dryRun };
  const backup = ledgerPath + '.bak-' + now;
  copyFileSync(ledgerPath, backup);
  const tmp = ledgerPath + '.tmp-' + process.pid;
  writeFileSync(tmp, rewritten.join('\n') + '\n', 'utf8');
  renameSync(tmp, ledgerPath);
  return { ok: true, exists: true, changed, lines: lines.length, backup, dryRun: false };
}

/** 清点/删除 relay blob 目录（内容寻址文件）。 */
export function scrubBlobs(blobDir, { dryRun = true, now = Date.now() } = {}) {
  if (!existsSync(blobDir)) return { ok: true, exists: false, files: [], bytes: 0, deleted: 0, manifest: null };
  const files = [];
  let bytes = 0;
  for (const name of readdirSync(blobDir)) {
    const path = join(blobDir, name);
    if (!statSync(path).isFile()) continue;
    files.push(name);
    bytes += statSync(path).size;
  }
  const manifest = {
    at: new Date(now).toISOString(),
    files: files.map((name) => ({ name, sha256: sha256(readFileSync(join(blobDir, name))) })),
  };
  if (dryRun) return { ok: true, exists: true, files, bytes, deleted: 0, manifest, dryRun };
  for (const name of files) unlinkSync(join(blobDir, name));
  return { ok: true, exists: true, files, bytes, deleted: files.length, manifest, dryRun: false };
}

/** 验收：扫描目录中是否仍存在内容字段/数据面 marker。 */
export function scanForContent(rootDir, markers = []) {
  const hits = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = statSync(path);
      if (stat.isDirectory()) { walk(path); continue; }
      if (stat.size > 32 * 1024 * 1024) continue;
      const text = readFileSync(path, 'utf8');
      for (const field of LEDGER_CONTENT_FIELDS) {
        if (text.includes('"' + field + '"')) hits.push({ file: path, marker: field });
      }
      for (const marker of markers) {
        if (marker !== '' && text.includes(marker)) hits.push({ file: path, marker });
      }
    }
  };
  if (existsSync(rootDir)) walk(rootDir);
  return { ok: hits.length === 0, hits };
}
