/**
 * relay P0 投影：写入磁盘/ledger/报表前的唯一投影点。
 * V5/V6/V7：去 stdout/stderr 头尾、argv→hash、路径→count+hash。
 * V8：报表去 stdout_head，blob_sha256 恒 null。
 * V12：blob 端点统一拒绝。
 */
import { createHash } from 'node:crypto';

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const CONTENT_FIELDS = ['stdout_head', 'stdout_tail', 'stderr_head', 'stderr_tail', 'command_argv', 'pipeline_hash_material'];

function projectPaths(list) {
  if (!Array.isArray(list)) return { count: 0, paths_sha256: sha256('') };
  const normalized = list.map((entry) => String(entry).replace(/\\/g, '/')).sort();
  return { count: normalized.length, paths_sha256: sha256(normalized.join('\n')) };
}

/**
 * 投影结果信封（原地副本，不改入参）。
 * @returns {{projected: object, dropped: string[], argv_hash: string|null}}
 */
export function projectResultEnvelope(envelope) {
  if (envelope === null || typeof envelope !== 'object') return { projected: envelope, dropped: [], argv_hash: null };
  const projected = JSON.parse(JSON.stringify(envelope));
  const dropped = [];
  let argvHash = null;
  for (const field of CONTENT_FIELDS) {
    if (field in projected) {
      if (field === 'command_argv') argvHash = sha256(JSON.stringify(projected[field]));
      delete projected[field];
      dropped.push(field);
    }
  }
  if (argvHash !== null) projected.command_argv_sha256 = argvHash;
  if ('blob_sha256' in projected) { projected.blob_sha256 = null; dropped.push('blob_sha256'); }
  if ('output_mode' in projected) { delete projected.output_mode; dropped.push('output_mode'); }
  if (projected.workspace !== null && typeof projected.workspace === 'object') {
    if ('patch_sha256' in projected.workspace) projected.workspace.patch_sha256 = null;
    if ('changed_files' in projected.workspace) {
      projected.workspace.files = projectPaths(projected.workspace.changed_files);
      delete projected.workspace.changed_files;
      dropped.push('workspace.changed_files');
    }
  }
  if ('changed_files' in projected) {
    projected.files = projectPaths(projected.changed_files);
    delete projected.changed_files;
    dropped.push('changed_files');
  }
  // V7：其余本地派生路径字段同样只保留 count + paths_sha256
  for (const field of ['untracked', 'untracked_files', 'diff_numstat', 'renames', 'deleted_files', 'deleted']) {
    if (field in projected) {
      projected[field + '_paths'] = projectPaths(Array.isArray(projected[field]) ? projected[field] : []);
      delete projected[field];
      dropped.push(field);
    }
  }
  return { projected, dropped, argv_hash: argvHash };
}

/** 投影 ledger 行（result.stored 等）：只保留元数据。 */
export function projectLedgerLine(line) {
  let record;
  try { record = JSON.parse(line); } catch { return { changed: false, line }; }
  const target = record?.result ?? record?.envelope;
  if (target === null || typeof target !== 'object') return { changed: false, line };
  const { projected, dropped } = projectResultEnvelope(target);
  if (dropped.length === 0) return { changed: false, line };
  if (record.result !== undefined) record.result = projected; else record.envelope = projected;
  record.projection = { dropped, at: new Date().toISOString() };
  return { changed: true, line: JSON.stringify(record) };
}

/** V8：报表聚合投影。 */
export function stripReportAggregate(aggregate) {
  if (aggregate === null || typeof aggregate !== 'object') return aggregate;
  const out = JSON.parse(JSON.stringify(aggregate));
  const machines = Array.isArray(out.machines) ? out.machines : [];
  for (const machine of machines) {
    if ('stdout_head' in machine) delete machine.stdout_head;
    if ('blob_sha256' in machine) machine.blob_sha256 = null;
  }
  if ('stdout_head' in out) delete out.stdout_head;
  if ('blob_sha256' in out) out.blob_sha256 = null;
  return out;
}

/** V12：blob 端点统一拒绝。 */
export function blobRefusal(method) {
  return {
    status: 403,
    body: { ok: false, code: 'DATA_PLANE_REFUSED', detail: { method, reason: 'relay never stores data-plane objects' } },
  };
}
