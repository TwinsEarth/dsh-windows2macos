/**
 * 联合开发闭环（纯函数 + 注入传输）：collect → merge → verify。
 * 数据字节只经直连 fetchFn；relay 只出现在控制面（dispatch.mjs）。
 */

/** 收集：按 ref 直连拉取，校验 sha256；缺失/不匹配即记为问题。 */
export async function collectArtifacts({ refs, fetchFn, crypto }) {
  const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
  const artifacts = [];
  const problems = [];
  for (const ref of refs) {
    if (ref === null || typeof ref !== 'object' || typeof ref.machine !== 'string') {
      problems.push({ machine: ref?.machine ?? null, file: ref?.file ?? null, reason: 'REF_INVALID' });
      continue;
    }
    let bytes;
    try {
      bytes = await fetchFn(ref);
    } catch (error) {
      problems.push({ machine: ref.machine, file: ref.file ?? null, reason: 'FETCH_FAILED', detail: String(error).slice(0, 80) });
      continue;
    }
    if (bytes === undefined || bytes === null) {
      problems.push({ machine: ref.machine, file: ref.file ?? null, reason: 'REF_MISSING' });
      continue;
    }
    const hash = digest(Buffer.from(bytes));
    if (ref.sha256 !== hash) {
      problems.push({ machine: ref.machine, file: ref.file ?? null, reason: 'HASH_MISMATCH', expected: ref.sha256, actual: hash });
      continue;
    }
    artifacts.push({ machine: ref.machine, file: ref.file, path: ref.path ?? ref.file, bytes: Buffer.from(bytes), sha256: hash });
  }
  return { ok: problems.length === 0, artifacts, problems };
}

/** 合并：按 (path) 检测同文件双改冲突；冲突时 head 不动，返回冲突明细。 */
export function mergeArtifacts({ artifacts }) {
  const byPath = new Map();
  const conflicts = [];
  for (const artifact of artifacts) {
    const path = artifact.path ?? artifact.file;
    const key = String(path).toLowerCase();
    const existing = byPath.get(key);
    if (existing === undefined) {
      byPath.set(key, { path, machines: [artifact.machine], bytes: artifact.bytes, sha256: artifact.sha256 });
      continue;
    }
    if (existing.sha256 === artifact.sha256) {
      if (!existing.machines.includes(artifact.machine)) existing.machines.push(artifact.machine);
      continue;
    }
    conflicts.push({ path, machines: [...new Set([...existing.machines, artifact.machine])], reason: 'CONTENT_CONFLICT', left: existing.sha256, right: artifact.sha256 });
  }
  if (conflicts.length > 0) return { ok: false, code: 'MERGE_CONFLICT', conflicts, files: [] };
  const files = [...byPath.values()].map((entry) => ({ path: entry.path, sha256: entry.sha256, bytes: entry.bytes, machines: entry.machines }));
  return { ok: true, files, conflicts: [] };
}

/** 复核：对合并结果逐机比对期望文件；只回结论与差异摘要。 */
export function verifyReview({ merged, expectations }) {
  const present = new Map(merged.files.map((file) => [String(file.path).toLowerCase(), file.sha256]));
  const results = [];
  for (const expectation of expectations) {
    const actual = present.get(String(expectation.file).toLowerCase()) ?? null;
    const pass = actual !== null && (expectation.sha256 === undefined || actual === expectation.sha256);
    results.push(pass
      ? { machine: expectation.machine, file: expectation.file, status: 'PASS' }
      : { machine: expectation.machine, file: expectation.file, status: 'FAIL', reason: actual === null ? 'FILE_MISSING' : 'HASH_MISMATCH', expected: expectation.sha256 ?? null, actual });
  }
  const failed = results.filter((entry) => entry.status === 'FAIL');
  return { ok: failed.length === 0, verdict: failed.length === 0 ? 'PASS' : 'FAIL', results, failed };
}
