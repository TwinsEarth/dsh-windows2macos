/**
 * 最终机器选择策略（纯函数，独立可测；尚未接线到 dispatch/tools）。
 *
 * 优先级：指令显式点名 > 输入框选中 > 默认本机
 * 规则：
 *  · 点名机器不存在/离线 → MACHINE_UNAVAILABLE，绝不换机；
 *  · 选中机器失效（离线/退编队）→ 自动回默认本机，并返回 SELECTION_FALLBACK_LOCAL；
 *  · 只有 online && inFleet 的机器可被选中（assertSelectable）；
 *  · 选中“全部机器/联合开发” → fleet 模式（显式），不是本机。
 */

export const TARGET_SOURCES = Object.freeze(['explicit', 'selected', 'local', 'fleet']);

function isUsable(machine) {
  return machine !== null && typeof machine === 'object'
    && typeof machine.id === 'string' && machine.id !== ''
    && machine.online === true && machine.inFleet === true;
}

/** 可选择性校验：离线/不在编队的机器不能被写入选择。 */
export function assertSelectable(machine) {
  if (machine === null || typeof machine !== 'object') {
    return { ok: false, code: 'SELECTION_INVALID', detail: { reason: 'not-an-object' } };
  }
  if (typeof machine.id !== 'string' || machine.id === '') {
    return { ok: false, code: 'SELECTION_INVALID', detail: { reason: 'missing-id' } };
  }
  if (machine.online !== true) {
    return { ok: false, code: 'SELECTION_MACHINE_OFFLINE', detail: { machine: machine.id } };
  }
  if (machine.inFleet !== true) {
    return { ok: false, code: 'SELECTION_MACHINE_NOT_IN_FLEET', detail: { machine: machine.id } };
  }
  return { ok: true };
}

/**
 * 解析本次调用的目标。
 * @param {{explicitMachine?: {id,name?,online?,inFleet?}|string|null,
 *          selected?: {mode?: 'machine'|'fleet', machine?: object|null}|null,
 *          localMachine: {id,name?},
 *          fleetMachines?: Array<object>}} input
 * @returns {{ok: true, source: string, machine: object|null, warning?: string}
 *          | {ok: false, code: string, detail: object}}
 */
export function resolveTarget(input) {
  const local = input?.localMachine;
  if (local === null || typeof local !== 'object' || typeof local.id !== 'string' || local.id === '') {
    return { ok: false, code: 'LOCAL_MACHINE_UNKNOWN', detail: {} };
  }
  const fleet = Array.isArray(input?.fleetMachines) ? input.fleetMachines : [];
  const find = (id) => fleet.find((machine) => machine.id === id) ?? null;

  // 1) 显式点名：最高优先；找不到/离线即拒绝，不换机。
  const explicit = input?.explicitMachine;
  if (explicit !== undefined && explicit !== null && explicit !== '') {
    const id = typeof explicit === 'string' ? explicit : explicit.id;
    if (typeof id !== 'string' || id === '') {
      return { ok: false, code: 'MACHINE_UNAVAILABLE', detail: { reason: 'missing-id' } };
    }
    if (id === local.id) return { ok: true, source: 'local', machine: { id: local.id, name: local.name ?? null } };
    const named = find(id);
    if (named === null) return { ok: false, code: 'MACHINE_UNAVAILABLE', detail: { machine: id, reason: 'not-in-fleet' } };
    if (named.online !== true) return { ok: false, code: 'MACHINE_UNAVAILABLE', detail: { machine: id, reason: 'offline' } };
    if (named.inFleet !== true) return { ok: false, code: 'MACHINE_UNAVAILABLE', detail: { machine: id, reason: 'not-in-fleet' } };
    return { ok: true, source: 'explicit', machine: named };
  }

  // 2) 选中项：fleet 模式 → 整编队；machine 模式 → 该机；失效 → TARGET_UNAVAILABLE（不换机）。
  const selected = input?.selected ?? null;
  if (selected !== null && selected.mode === 'fleet') {
    return { ok: true, source: 'fleet', machine: null };
  }
  if (selected !== null && selected.machine !== undefined && selected.machine !== null) {
    const picked = selected.machine;
    if (picked.id === local.id) return { ok: true, source: 'local', machine: { id: local.id, name: local.name ?? null } };
    const current = typeof picked.id === 'string' ? find(picked.id) : null;
    if (isUsable(current)) {
      return { ok: true, source: 'selected', machine: current };
    }
    return { ok: false, code: 'TARGET_UNAVAILABLE', detail: { machine: picked.id ?? null, reason: 'selection-invalid' } };
  }

  // 3) 未选中：指令显式要求“全队/整编队/所有机器” → fleet；否则默认本机。
  const phrase = typeof input?.promptText === 'string' ? input.promptText : '';
  if (/(全队|整编队|所有机器|全部机器)/.test(phrase)) {
    return { ok: true, source: 'fleet', machine: null };
  }
  return { ok: true, source: 'local', machine: { id: local.id, name: local.name ?? null } };
}
