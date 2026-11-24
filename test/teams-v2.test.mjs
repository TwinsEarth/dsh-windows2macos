/**
 * Teams V2: the five pillars are testable local behavior, not slideware.
 *
 * These tests deliberately exercise the failure paths: a done step without verification, a locked
 * replan target, a regressing prompt candidate, a rejected executor context, and a missing
 * process trace. The happy path is necessary but not sufficient.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildTools, TOOL_NAMES } from '../src/plugin/teams-plugin.mjs';
import { createTeamsV2Service } from '../src/plugin/teams/v2-service.mjs';
import {
  createBuiltinExecutor,
  listFrameworks,
  registerFrameworkAdapter,
  resetFrameworkAdaptersForTests,
  selectFramework,
} from '../src/plugin/teams/frameworks.mjs';

const tempState = () => mkdtempSync(join(tmpdir(), 'w2m-teams-v2-'));
const json = (value) => (typeof value === 'string' ? JSON.parse(value) : value);
const NOW = Date.parse('2026-11-24T00:00:00.000Z');

function passVerification(score = 1) {
  return {
    mode: 'score',
    verdict: 'pass',
    score,
    threshold: 0.8,
    checks: [{ id: 'exists', status: 'pass', weight: 1, critical: true }],
    findings: [],
    context_isolated: true,
  };
}

describe('Teams V2 framework boundary', () => {
  it('declares only builtin as runnable and makes fallback visible', () => {
    const catalog = listFrameworks();
    assert.equal(catalog.length, 4);
    assert.equal(catalog.find((entry) => entry.name === 'builtin').runnable, true);
    for (const name of ['langgraph', 'crewai', 'autogen']) {
      const entry = catalog.find((item) => item.name === name);
      assert.equal(entry.runnable, false);
      assert.equal(entry.reason, 'adapter-not-installed');
    }
    const choice = selectFramework({ requested: 'crewai', task_type: 'role-play' });
    assert.equal(choice.requested, 'crewai');
    assert.equal(choice.selected, 'crewai');
    assert.equal(choice.effective, 'builtin');
    assert.equal(choice.runnable, false);
    assert.equal(choice.reason, 'adapter-not-installed');
  });

  it('executes through the native builtin adapter and can register an external adapter', async () => {
    const executor = createBuiltinExecutor({
      collect: async ({ step }) => ({ collected: step.step_id }),
    });
    const run = await executor.run({ step_id: 'a', task_type: 'collect' });
    assert.equal(run.ok, true);
    assert.equal(run.framework, 'builtin');
    assert.deepEqual(run.output, { collected: 'a' });
    const missing = await executor.run({ step_id: 'b', task_type: 'review' });
    assert.equal(missing.ok, false);
    assert.equal(missing.code, 'TEAM_V2_FRAMEWORK_UNAVAILABLE');

    try {
      const registered = registerFrameworkAdapter('crewai', { run: async () => ({ ok: true }) });
      assert.equal(registered.ok, true);
      assert.equal(selectFramework({ requested: 'crewai' }).effective, 'crewai');
      assert.equal(listFrameworks().find((entry) => entry.name === 'crewai').runnable, true);
    } finally {
      resetFrameworkAdaptersForTests();
    }
    assert.equal(selectFramework({ requested: 'crewai' }).effective, 'builtin');
  });

  it('rejects an unknown framework instead of silently selecting builtin', () => {
    const service = createTeamsV2Service({ stateDir: tempState() });
    const result = service.frameworks({ op: 'select', requested: 'not-a-framework' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'TEAM_V2_FRAMEWORK_INVALID');
  });
});

describe('Teams V2 dynamic orchestration', () => {
  it('creates a ready frontier, gates dependencies, and refuses done without verification', () => {
    const service = createTeamsV2Service({ stateDir: tempState(), now: () => NOW });
    const created = service.createPlan({
      goal: 'ship a tested ledger',
      steps: [
        { step_id: 'a', title: 'collect evidence', agent: 'executor' },
        { step_id: 'b', title: 'review evidence', agent: 'reviewer', depends_on: ['a'] },
      ],
    });
    assert.equal(created.ok, true);
    assert.deepEqual(created.summary.ready, ['a']);

    const early = service.step({ plan_id: created.plan.plan_id, step_id: 'b', status: 'running' });
    assert.equal(early.ok, false);
    assert.equal(early.code, 'TEAM_V2_DEPENDENCY_MISSING');

    const running = service.step({ plan_id: created.plan.plan_id, step_id: 'a', status: 'running' });
    assert.equal(running.ok, true);
    const noVerification = service.step({
      plan_id: created.plan.plan_id,
      step_id: 'a',
      status: 'done',
      result: { summary: 'evidence collected' },
      evidence: ['log:a'],
    });
    assert.equal(noVerification.ok, false);
    assert.equal(noVerification.code, 'TEAM_V2_VERIFICATION_REQUIRED');
    const unisolated = service.step({
      plan_id: created.plan.plan_id,
      step_id: 'a',
      status: 'done',
      result: { summary: 'claims pass' },
      evidence: ['log:a'],
      verification: { verdict: 'pass', score: 1, checks: [] },
    });
    assert.equal(unisolated.ok, false);
    assert.equal(unisolated.code, 'TEAM_V2_CONTEXT_NOT_ISOLATED');

    const done = service.step({
      plan_id: created.plan.plan_id,
      step_id: 'a',
      status: 'done',
      result: { summary: 'evidence collected' },
      evidence: ['log:a'],
      verification: passVerification(),
    });
    assert.equal(done.ok, true);
    assert.equal(done.step.status, 'done');
    assert.deepEqual(done.summary.ready, ['b']);
    assert.equal(done.summary.status, 'active');
  });

  it('replans pending work with a reason and locks completed or running steps', () => {
    const service = createTeamsV2Service({ stateDir: tempState(), now: () => NOW });
    const created = service.createPlan({
      goal: 'replan safely',
      steps: [
        { step_id: 'a', title: 'build', agent: 'executor' },
        { step_id: 'b', title: 'review', agent: 'reviewer', depends_on: ['a'] },
      ],
    });
    const id = created.plan.plan_id;
    const noReason = service.replan({
      plan_id: id,
      add: [{ step_id: 'c', title: 'audit', agent: 'auditor' }],
    });
    assert.equal(noReason.code, 'TEAM_V2_REPLAN_REASON_REQUIRED');

    const orphan = service.replan({ plan_id: id, reason: 'remove build', remove: ['a'] });
    assert.equal(orphan.code, 'TEAM_V2_REPLAN_DEPENDENT_EXISTS');

    const running = service.step({ plan_id: id, step_id: 'a', status: 'running' });
    assert.equal(running.ok, true);
    const locked = service.replan({
      plan_id: id,
      reason: 'rename running',
      update: [{ step_id: 'a', title: 'new title' }],
    });
    assert.equal(locked.code, 'TEAM_V2_REPLAN_TARGET_LOCKED');

    const added = service.replan({
      plan_id: id,
      reason: 'add a critic',
      add: [{ step_id: 'c', title: 'critique', agent: 'critic', depends_on: ['b'] }],
    });
    assert.equal(added.ok, true);
    assert.equal(added.summary.steps, 3);
    assert.equal(added.plan.version, 2);
  });
});

describe('Teams V2 adversarial verification', () => {
  it('supports score, reflexion, debate and process with explicit isolation', () => {
    const service = createTeamsV2Service({ stateDir: tempState() });
    assert.equal(
      service.verify({ mode: 'score', checks: [{ id: 'build', status: 'pass', critical: true }] }).verdict,
      'pass',
    );
    assert.equal(
      service.verify({ mode: 'score', checks: [{ id: 'build', status: 'fail', critical: true }] }).verdict,
      'fail',
    );
    const reflexion = service.verify({
      mode: 'reflexion',
      checks: [{ id: 'tests', status: 'fail', weight: 1 }],
    });
    assert.equal(reflexion.next_action, 'retry');
    assert.match(reflexion.lesson, /retry after/);
    assert.equal(
      service.verify({
        mode: 'debate',
        support: [{ id: 'claim', status: 'pass', critical: true }],
        challenge: [{ id: 'counter', status: 'fail', critical: false }],
      }).verdict,
      'pass',
    );
    assert.equal(
      service.verify({
        mode: 'debate',
        support: [{ id: 'claim', status: 'pass', critical: true }],
        challenge: [{ id: 'counter', status: 'pass', critical: true }],
      }).verdict,
      'escalate',
    );
    const process = service.verify({
      mode: 'process',
      step_trace: [
        { step_id: 'a', status: 'done', evidence: ['log:a'] },
        { step_id: 'b', status: 'done', depends_on: ['a'], evidence: ['log:b'] },
      ],
    });
    assert.equal(process.verdict, 'pass');
    assert.equal(
      service.verify({
        mode: 'process',
        step_trace: [{ step_id: 'a', status: 'done', evidence: [] }],
      }).verdict,
      'fail',
    );
    const leak = service.verify({ mode: 'score', checks: [], executor_context: 'secret' });
    assert.equal(leak.ok, false);
    assert.equal(leak.code, 'TEAM_V2_CONTEXT_NOT_ISOLATED');
  });
});

describe('Teams V2 cost ledger', () => {
  it('places cache before route and records a real hit/miss split', () => {
    const service = createTeamsV2Service({ stateDir: tempState(), now: () => NOW });
    const quote = service.cost({ op: 'quote', requests: 100 });
    assert.equal(quote.order[0], 'cache');
    assert.equal(quote.order[1], 'route');
    assert.equal(quote.assumption_based, true);
    assert.ok(quote.cache_lever > 9);

    const created = service.createPlan({ goal: 'cost', steps: [{ step_id: 'a', title: 'work' }] });
    const recorded = service.cost({
      op: 'record',
      plan_id: created.plan.plan_id,
      step_id: 'a',
      cache: 'miss',
      model: 'large',
      input_tokens: 1_000,
      output_tokens: 0,
    });
    assert.equal(recorded.ok, true);
    assert.equal(recorded.record.cost_units, 6);
    const hit = service.cost({ op: 'record', plan_id: created.plan.plan_id, step_id: 'a', cache: 'hit' });
    assert.equal(hit.ok, true);
    assert.equal(hit.record.cost_units, 0);
    const report = service.cost({ op: 'report', plan_id: created.plan.plan_id });
    assert.equal(report.summary.cache_hits, 1);
    assert.equal(report.summary.cache_misses, 1);
    assert.equal(report.summary.cache_hit_rate, 0.5);
  });
});

describe('Teams V2 evolution', () => {
  it('promotes a non-regressing prompt, rejects a regression, and rolls back', () => {
    const service = createTeamsV2Service({ stateDir: tempState(), now: () => NOW });
    const first = service.evolve({
      op: 'candidate',
      agent_id: 'reviewer',
      prompt: 'check evidence first',
      metrics: { pass_rate: 0.8 },
    });
    assert.equal(first.ok, true);
    const promoted = service.evolve({
      op: 'promote',
      agent_id: 'reviewer',
      candidate_id: first.candidate.candidate_id,
    });
    assert.equal(promoted.ok, true);
    assert.equal(promoted.version.version_id, 'v1');

    const regression = service.evolve({
      op: 'candidate',
      agent_id: 'reviewer',
      prompt: 'skip evidence',
      metrics: { pass_rate: 0.7 },
    });
    const rejected = service.evolve({
      op: 'promote',
      agent_id: 'reviewer',
      candidate_id: regression.candidate.candidate_id,
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.code, 'TEAM_V2_EVOLUTION_VERSION_INELIGIBLE');

    const second = service.evolve({
      op: 'candidate',
      agent_id: 'reviewer',
      prompt: 'check evidence and provenance',
      metrics: { pass_rate: 0.9 },
    });
    const v2 = service.evolve({
      op: 'promote',
      agent_id: 'reviewer',
      candidate_id: second.candidate.candidate_id,
    });
    assert.equal(v2.ok, true);
    const rolled = service.evolve({ op: 'rollback', agent_id: 'reviewer', version_id: 'v1' });
    assert.equal(rolled.ok, true);
    assert.equal(rolled.baseline.restored_from, 'v1');

    const stop = service.evolve({
      op: 'stop-check',
      agent_id: 'reviewer',
      max_iterations: 1,
      quality_threshold: 0.9,
      patience: 2,
    });
    assert.equal(stop.ok, true);
    assert.equal(stop.should_stop, true);
    assert.ok(stop.reasons.includes('iteration-limit'));
  });
});

describe('Teams V2 tool surface', () => {
  it('adds exactly five tools without a V2 service and eight with one', () => {
    const service = { config: { project_id: 'default' } };
    const legacy = buildTools({ service, defineTool: (definition) => definition });
    assert.equal(legacy.length, 3);
    const v2 = createTeamsV2Service({ stateDir: tempState() });
    const full = buildTools({ service, defineTool: (definition) => definition, v2 });
    assert.deepEqual(
      full.map((definition) => definition.name),
      [...TOOL_NAMES],
    );
    assert.equal(full.length, 8);
  });

  it('executes the five V2 tools through their JSON string boundary', async () => {
    const service = { config: { project_id: 'default' } };
    const v2 = createTeamsV2Service({ stateDir: tempState(), now: () => NOW });
    const definitions = buildTools({ service, defineTool: (definition) => definition, v2 });
    const byName = new Map(definitions.map((definition) => [definition.name, definition]));
    const created = json(
      await byName.get('w2m_team_orchestrate').execute({
        action: 'create',
        goal: 'tool smoke',
        steps: [{ step_id: 'a', title: 'run', agent: 'executor' }],
      }),
    );
    assert.equal(created.ok, true);
    const verify = json(
      await byName.get('w2m_team_verify').execute({
        mode: 'score',
        checks: [{ id: 'exists', status: 'pass', critical: true }],
      }),
    );
    assert.equal(verify.verdict, 'pass');
    const cost = json(await byName.get('w2m_team_cost').execute({ op: 'quote' }));
    assert.equal(cost.order[0], 'cache');
    const frameworks = json(
      await byName
        .get('w2m_team_frameworks')
        .execute({ op: 'select', requested: 'autogen', task_type: 'debate' }),
    );
    assert.equal(frameworks.effective, 'builtin');
    const evolve = json(
      await byName.get('w2m_team_evolve').execute({
        op: 'candidate',
        agent_id: 'reviewer',
        prompt: 'check twice',
        metrics: { pass_rate: 0.85 },
      }),
    );
    assert.equal(evolve.ok, true);
  });

  it('persists a plan across two service instances', () => {
    const state = tempState();
    const first = createTeamsV2Service({ stateDir: state, now: () => NOW });
    const created = first.createPlan({ goal: 'persist', steps: [{ step_id: 'a', title: 'write' }] });
    assert.equal(created.ok, true);
    const second = createTeamsV2Service({ stateDir: state, now: () => NOW });
    assert.equal(second.planStatus(created.plan.plan_id).ok, true);
    assert.equal(second.planStatus('missing-plan').code, 'TEAM_V2_PLAN_NOT_FOUND');
  });
});
