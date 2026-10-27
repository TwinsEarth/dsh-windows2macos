/** 机器选择策略 A–G：点名 > 选中 > 本机；失效不换机；显式全队用词 → 编队。 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assertSelectable, resolveTarget } from '../src/plugin/target-policy.mjs';

const A = { id: 'A', name: 'A', online: true, inFleet: true };
const B = { id: 'B', name: 'B', online: true, inFleet: true };
const local = { id: 'local', name: '本机' };
const base = { localMachine: local, fleetMachines: [A, B] };

describe('A–E 选择与优先级', () => {
  it('A 不选、不点名 → 本机', () => {
    const r = resolveTarget(base);
    assert.equal(r.ok, true);
    assert.equal(r.source, 'local');
    assert.equal(r.machine.id, 'local');
  });
  it('B 选中 B、不点名 → B', () => {
    const r = resolveTarget({ ...base, selected: { mode: 'machine', machine: B } });
    assert.equal(r.source, 'selected');
    assert.equal(r.machine.id, 'B');
  });
  it('C 选中 B、点名 A → A（点名优先）', () => {
    const r = resolveTarget({ ...base, selected: { mode: 'machine', machine: B }, explicitMachine: 'A' });
    assert.equal(r.source, 'explicit');
    assert.equal(r.machine.id, 'A');
  });
  it('D 不选、写“全队执行” → 整编队', () => {
    const r = resolveTarget({ ...base, promptText: '全队执行这个任务' });
    assert.equal(r.source, 'fleet');
    assert.equal(r.machine, null);
  });
  it('E0 选中本机 → 本机执行', () => {
    const r = resolveTarget({ ...base, selected: { mode: 'machine', machine: local } });
    assert.equal(r.source, 'local');
    assert.equal(r.machine.id, 'local');
  });
  it('E 选中联合舰队 → 整编队（后续本地规划/分派）', () => {
    const r = resolveTarget({ ...base, selected: { mode: 'fleet' } });
    assert.equal(r.source, 'fleet');
    assert.equal(r.machine, null);
  });
});

describe('F–G 失效不换机', () => {
  it('F 选中机器离线 → TARGET_UNAVAILABLE，不换机', () => {
    const offline = { ...B, online: false };
    const r = resolveTarget({ ...base, selected: { mode: 'machine', machine: B }, fleetMachines: [A, offline] });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'TARGET_UNAVAILABLE');
  });
  it('F2 选中机器退编队 → TARGET_UNAVAILABLE', () => {
    const gone = { ...B, inFleet: false };
    const r = resolveTarget({ ...base, selected: { mode: 'machine', machine: B }, fleetMachines: [A, gone] });
    assert.equal(r.code, 'TARGET_UNAVAILABLE');
  });
  it('G 点名离线机器 → MACHINE_UNAVAILABLE，不换机', () => {
    const r = resolveTarget({ ...base, explicitMachine: 'B', fleetMachines: [A, { ...B, online: false }] });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'MACHINE_UNAVAILABLE');
  });
  it('G2 点名不在编队 → MACHINE_UNAVAILABLE', () => {
    const r = resolveTarget({ ...base, explicitMachine: 'Z' });
    assert.equal(r.code, 'MACHINE_UNAVAILABLE');
  });
});

describe('可选择性约束', () => {
  it('离线/退编队的机器不可被选中', () => {
    assert.equal(assertSelectable({ ...B, online: false }).code, 'SELECTION_MACHINE_OFFLINE');
    assert.equal(assertSelectable({ ...B, inFleet: false }).code, 'SELECTION_MACHINE_NOT_IN_FLEET');
    assert.deepEqual(assertSelectable(B), { ok: true });
  });
});
