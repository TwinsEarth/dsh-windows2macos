/**
 * The fleet's member list: who is in this fleet, what role they hold, and when they joined.
 *
 * ## Why a role table and not a field on the device
 *
 * A device record is written by pairing and by reconnect; a role is an operator decision that must survive both. Keeping it in
 * its own table also makes the default explicit: an unknown machine is a `worker`, never an `owner`, so a machine cannot gain
 * authority by being re-paired.
 *
 * ## Why the refusals are values
 *
 * `role` is a closed set and the owner may only be changed by the operator token. Both are refused by name, because a member
 * list that silently ignored a role change would be a board that disagrees with the fleet.
 */
export const MEMBER_ROLES = Object.freeze(['owner', 'worker', 'observer']);

export const MEMBERS_REFUSAL = Object.freeze({
  UNKNOWN_MACHINE: 'MEMBERS_UNKNOWN_MACHINE',
  BAD_ROLE: 'MEMBERS_BAD_ROLE',
  LAST_OWNER: 'MEMBERS_LAST_OWNER',
});

/** @param {unknown} role */
export function isMemberRole(role) {
  return typeof role === 'string' && MEMBER_ROLES.includes(role);
}

/**
 * @param {{devices?: Map<string, object>, roles?: Map<string, string>}} input
 * @returns {Array<{machine_id: string, machine_name: string, role: string, joined_at_ms: number|null, online: boolean, last_seen_at_ms: number|null}>}
 */
export function buildMembers({ devices = new Map(), roles = new Map() } = {}) {
  const list = [];
  for (const [machineId, device] of devices.entries()) {
    const role = roles.get(machineId);
    list.push({
      machine_id: machineId,
      machine_name: typeof device?.machine_name === 'string' && device.machine_name !== '' ? device.machine_name : machineId,
      role: isMemberRole(role) ? role : 'worker',
      joined_at_ms: Number.isFinite(device?.paired_at_ms) ? device.paired_at_ms : null,
      online: device?.online === true,
      last_seen_at_ms: Number.isFinite(device?.last_seen_at_ms) ? device.last_seen_at_ms : null,
    });
  }
  list.sort((a, b) => a.machine_id.localeCompare(b.machine_id));
  return list;
}

/**
 * @param {{machineId: string, role: unknown, devices: Map<string, object>, roles: Map<string, string>}} input
 * @returns {{ok: true, member: object} | {ok: false, code: string, detail?: object}}
 */
export function setMemberRole({ machineId, role, devices = new Map(), roles = new Map() } = {}) {
  if (typeof machineId !== 'string' || !devices.has(machineId)) {
    return { ok: false, code: MEMBERS_REFUSAL.UNKNOWN_MACHINE, detail: { machine_id: machineId ?? null } };
  }
  if (!isMemberRole(role)) {
    return { ok: false, code: MEMBERS_REFUSAL.BAD_ROLE, detail: { role: role ?? null, allowed: [...MEMBER_ROLES] } };
  }
  // The fleet must keep at least one owner: demoting the last one would leave nobody able to readmit a machine.
  if (role !== 'owner') {
    const owners = [...roles.entries()].filter(([id, held]) => held === 'owner' && id !== machineId);
    const current = roles.get(machineId);
    if (current === 'owner' && owners.length === 0) {
      return { ok: false, code: MEMBERS_REFUSAL.LAST_OWNER, detail: { machine_id: machineId } };
    }
  }
  roles.set(machineId, role);
  const device = devices.get(machineId);
  return {
    ok: true,
    member: {
      machine_id: machineId,
      machine_name: typeof device?.machine_name === 'string' ? device.machine_name : machineId,
      role,
    },
  };
}
