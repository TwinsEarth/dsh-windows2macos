/**
 * C2：ArtifactRef 的控制面发布（复用 relay 现有项目决策通道，不新增存储、不传字节）。
 *
 * 发布体 = { title:"artifact.available", kind:"artifact_available", text: JSON(ref) }；
 * relay 只记录这条元数据，字节永远在本机对象库/sink。读取端按 title 过滤并校验 ref。
 * 该通道在 relay 2.0.5 已存在（POST/GET /v1/projects/:id/decisions），无需新路由即可先跑通。
 */
import { verifyRefV2 } from './ferry.mjs';

const TITLE = 'artifact.available';
const KIND = 'artifact_available';

function baseOf(url) {
  if (typeof url !== 'string' || url.trim() === '') return null;
  return url.trim().replace(/\/+$/, '');
}

/**
 * @param {{relayUrl:string, token:string, projectId?:string, ref:object, fetchImpl?:Function, signal?:AbortSignal}} input
 */
export async function publishRef(input) {
  const base = baseOf(input?.relayUrl);
  if (base === null) return { ok: false, code: 'RELAY_URL_REQUIRED' };
  if (typeof input?.token !== 'string' || input.token === '') return { ok: false, code: 'OPERATOR_TOKEN_REQUIRED' };
  const checked = verifyRefV2(input?.ref);
  if (checked.ok !== true) return checked;
  const projectId = typeof input.projectId === 'string' && input.projectId !== '' ? input.projectId : 'default';
  const fetchImpl = typeof input.fetchImpl === 'function' ? input.fetchImpl : globalThis.fetch;
  const body = { title: TITLE, kind: KIND, text: JSON.stringify(checked.ok ? input.ref : null), refs: { rootCid: input.ref.rootCid, originPeer: input.ref.originPeer } };
  let response = null;
  try {
    response = await fetchImpl(base + '/v1/projects/' + encodeURIComponent(projectId) + '/decisions', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + input.token, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      signal: input.signal,
    });
  } catch {
    return { ok: false, code: 'RELAY_UNREACHABLE' };
  }
  let json = null;
  try { json = await response.json(); } catch { json = null; }
  if (response.ok !== true) return { ok: false, code: 'RELAY_REFUSED', detail: { status: response.status, error: json?.error?.code ?? null } };
  if (json?.ok !== true) return { ok: false, code: 'RELAY_REFUSED', detail: { status: response.status } };
  return { ok: true, decision: json.decision ?? null, ref: input.ref };
}

/**
 * @param {{relayUrl:string, token:string, projectId?:string, fetchImpl?:Function, signal?:AbortSignal}} input
 */
export async function listPublishedRefs(input) {
  const base = baseOf(input?.relayUrl);
  if (base === null) return { ok: false, code: 'RELAY_URL_REQUIRED' };
  if (typeof input?.token !== 'string' || input.token === '') return { ok: false, code: 'DEVICE_TOKEN_REQUIRED' };
  const projectId = typeof input.projectId === 'string' && input.projectId !== '' ? input.projectId : 'default';
  const fetchImpl = typeof input.fetchImpl === 'function' ? input.fetchImpl : globalThis.fetch;
  let response = null;
  try {
    response = await fetchImpl(base + '/v1/projects/' + encodeURIComponent(projectId) + '/decisions', { headers: { authorization: 'Bearer ' + input.token, accept: 'application/json' }, signal: input.signal });
  } catch {
    return { ok: false, code: 'RELAY_UNREACHABLE' };
  }
  let json = null;
  try { json = await response.json(); } catch { json = null; }
  if (response.ok !== true) return { ok: false, code: 'RELAY_REFUSED', detail: { status: response.status } };
  const decisions = Array.isArray(json?.decisions) ? json.decisions : [];
  const refs = [];
  for (const decision of decisions) {
    if (decision?.title !== TITLE || decision?.kind !== KIND) continue;
    let ref = null;
    try { ref = JSON.parse(String(decision.text ?? '')); } catch { continue; }
    if (verifyRefV2(ref).ok !== true) continue;
    refs.push(ref);
  }
  return { ok: true, refs };
}
