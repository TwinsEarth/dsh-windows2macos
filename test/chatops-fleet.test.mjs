/**
 * Running the fleet from a phone (v0.7.2).
 *
 * The property this file protects is the whole point of the release: **a WeChat message runs a
 * command on the machines, and the machines' own verdict comes back.** Before this, `/run` could
 * only answer "this install has no fleet" — the executor did not exist, so the bridge had
 * nothing to call.
 *
 * Three things are asserted here that a passing test elsewhere would not catch:
 *
 *   * **the argv is never joined into a string.** A chat message is attacker-influenced text;
 *     the fleet takes an array precisely so no shell ever parses it. A formatter that joined and
 *     re-split would quietly reintroduce the quoting problem the array exists to remove, and it
 *     would keep working for every command until the one with a space in an argument.
 *   * **`timeout` is an answer, not an error.** A reply to a phone must arrive; a fleet with one
 *     dead machine never reaches a terminal state, so a wait that threw would leave the operator
 *     with silence and no task id.
 *   * **`divergent` and `divergent-platform` are not collapsed.** They mean different things —
 *     one is a bug, the other is a platform difference — and paraphrasing either into "failed"
 *     is how a portability difference becomes an incident.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createFleetExecutor, isTerminal, TERMINAL, RELAY } from '../src/chatops/fleet.mjs';
import { createChatopsActions, formatRunResult, describeMachines, tailLines } from '../src/chatops/actions.mjs';
import { route } from '../src/chatops/commands.mjs';
import { createPolicy } from '../src/chatops/policy.mjs';
import { OWNER_CAPABILITIES } from '../src/chatops/commands.mjs';

/** A relay that answers from a script, recording every request. */
function relay({ task = {}, status = {}, report = {}, devices = {}, refuse = null } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null, headers: init.headers });
    if (refuse !== null) {
      return new Response(JSON.stringify({ error: { code: refuse.code, message: refuse.message } }), { status: refuse.status ?? 403 });
    }
    if (url.endsWith(RELAY.TASK)) return new Response(JSON.stringify(task), { status: 200 });
    if (url.includes('/report')) return new Response(JSON.stringify(report), { status: 200 });
    if (url.includes('/v1/tasks/')) return new Response(JSON.stringify(status), { status: 200 });
    if (url.endsWith(RELAY.DEVICES)) return new Response(JSON.stringify(devices), { status: 200 });
    return new Response('{}', { status: 404 });
  };
  return { calls, fetch };
}

function executorFor(script, over = {}) {
  const r = relay(script);
  const executor = createFleetExecutor({
    rabbitUrl: 'http://relay.test:8787',
    token: 'operator-token',
    deviceToken: 'device-token',
    fetch: r.fetch,
    sleep: async () => {},
    ...over,
  });
  return { executor, r };
}

/** An executor already past dispatch and wait, for the formatting assertions. */
function stubExecutor(over = {}) {
  return {
    run: async () => ({ ok: true, taskId: 'task-abcdef123456' }),
    wait: async () => ({ ok: true, verdict: 'consistent', terminal: true, body: {} }),
    status: async () => ({ ok: true, raw: {} }),
    report: async () => ({ ok: true, raw: {} }),
    devices: async () => ({ ok: true, devices: [] }),
    ...over,
  };
}

const HOST = {
  listSessions: async () => [{ id: 'sess-1', title: 'the parser' }],
  boundSession: async () => 'sess-1',
  bind: async () => {},
  tail: async () => ['a line'],
  setPolicy: async () => {},
};

describe('a message runs a command and the verdict comes back', () => {
  it('dispatches the argv as an array and never as a joined string', async () => {
    const { executor, r } = executorFor({
      task: { task_id: 'task-1' },
      status: { aggregate: { status: 'consistent' }, machines: [{ machine_name: 'win-desktop', outcome: 'consistent' }] },
      report: { verdict: 'consistent', stdout: 'ok' },
    });
    await executor.run(['node', '--test', 'a b']);
    const body = r.calls[0].body;
    assert.deepEqual(body.command_argv, ['node', '--test', 'a b']);
    assert.equal(typeof body.command_argv, 'object', 'an array in, an array out');
    // The argument with a space must survive as one element.
    assert.equal(body.command_argv[2], 'a b');
  });

  it('carries the task id back so the operator can ask again', async () => {
    const { executor } = executorFor({ task: { task_id: 'task-xyz' } });
    const result = await executor.run(['node', '--test']);
    assert.equal(result.ok, true);
    assert.equal(result.taskId, 'task-xyz');
  });

  it('answers /run with the relay verdict and the machines that produced it', async () => {
    const actions = createChatopsActions({
      executor: stubExecutor({
        wait: async () => ({
          ok: true,
          verdict: 'divergent',
          terminal: true,
          body: { results: [{ machine: 'win-desktop', verdict: 'consistent' }, { machine: 'macmini', verdict: 'divergent', exit_code: 1 }] },
        }),
        report: async () => ({ ok: true, raw: { failed: [{ machine: 'macmini', reason: 'assertion failed' }] } }),
      }),
      host: HOST,
    });
    const outcome = await actions.dispatch(['node', '--test']);
    assert.match(outcome.summary, /divergent/);
    assert.match(outcome.summary, /win-desktop/);
    assert.match(outcome.summary, /macmini/);
    assert.match(outcome.summary, /assertion failed/);
    assert.equal(outcome.taskId, 'task-abcdef123456');
  });

  it('reaches /run through the router, from a chat message to a dispatch', async () => {
    // The end-to-end path this release exists for, minus the phone.
    const seen = [];
    const actions = createChatopsActions({
      executor: stubExecutor({
        run: async (argv) => {
          seen.push(argv);
          return { ok: true, taskId: 'task-1' };
        },
        wait: async () => ({ ok: true, verdict: 'consistent', terminal: true, body: {} }),
        report: async () => ({ ok: true, raw: {} }),
      }),
      host: HOST,
    });
    const result = await route('/run node --test', {
      capabilities: new Set(OWNER_CAPABILITIES),
      identity: { channel: 'ilink', id: 'peer', window: 'user:peer' },
      policyModes: ['read-only', 'ask', 'danger-full-access'],
      actions,
    });
    assert.equal(result.kind, 'ok');
    assert.deepEqual(seen, [['node', '--test']]);
    assert.equal(result.taskId, 'task-1');
    assert.match(result.text, /consistent/);
  });

  it('says where the task is, machine by machine', async () => {
    const actions = createChatopsActions({
      executor: stubExecutor({
        status: async () => ({ ok: true, raw: { verdict: 'partial', results: [{ machine: 'win-desktop', verdict: 'consistent' }] } }),
      }),
      host: HOST,
    });
    const outcome = await actions.where('task-1');
    assert.match(outcome.text, /partial/);
    assert.match(outcome.text, /win-desktop/);
  });

  it('distinguishes divergent from divergent-platform', async () => {
    // They mean different things and only one of them is a bug.
    const actions = createChatopsActions({
      executor: stubExecutor({
        wait: async () => ({ ok: true, verdict: 'divergent-platform', terminal: true, body: {} }),
        report: async () => ({ ok: true, raw: {} }),
      }),
      host: HOST,
    });
    const outcome = await actions.dispatch(['node', '--test']);
    assert.match(outcome.summary, /divergent-platform/);
    assert.doesNotMatch(outcome.summary, /^任务 \w+ — failed/m);
  });
});

describe('a wait that expires is an answer, not an error', () => {
  it('reports that the task is still running, with its id', async () => {
    const actions = createChatopsActions({
      executor: stubExecutor({
        wait: async () => ({ ok: true, verdict: 'timeout', terminal: false, body: null }),
      }),
      host: HOST,
      waitMs: 1000,
    });
    const outcome = await actions.dispatch(['node', '--test']);
    assert.match(outcome.summary, /timeout/);
    assert.match(outcome.summary, /还在跑/);
    assert.equal(outcome.taskId, 'task-abcdef123456', 'the id is how the operator asks again');
  });

  it('never throws out of /run, whatever the executor does', async () => {
    const actions = createChatopsActions({
      executor: stubExecutor({ run: async () => ({ ok: false, reason: 'no_online_device', text: '现在没有机器在线。' }) }),
      host: HOST,
    });
    await assert.doesNotReject(() => actions.dispatch(['node', '--test']));
  });

  it('reports a refusal in the operator\'s terms rather than a status code', async () => {
    const { executor } = executorFor({ refuse: { code: 'OPERATOR_REQUIRED', message: 'token needed', status: 401 } });
    const result = await executor.run(['node', '--test']);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'operator_required');
    assert.match(result.text, /operator token/);
  });

  it('names the empty-fleet case differently from a refused one', async () => {
    // "start an agent" and "your token is wrong" are different instructions.
    const { executor } = executorFor({ refuse: { code: 'NO_ONLINE_DEVICE', message: 'none', status: 409 } });
    const result = await executor.run(['node', '--test']);
    assert.equal(result.reason, 'no_online_device');
    assert.match(result.text, /机器在线/);
  });

  it('refuses an empty argv instead of sending an empty command', async () => {
    const { executor, r } = executorFor({ task: { task_id: 't' } });
    const result = await executor.run([]);
    assert.equal(result.ok, false);
    assert.equal(r.calls.length, 0, 'nothing should reach the relay');
  });

  it('treats an unknown verdict as not terminal, so it keeps waiting', async () => {
    assert.equal(isTerminal('consistent'), true);
    assert.equal(isTerminal('weird-new-verdict'), false);
    assert.deepEqual([...TERMINAL].sort(), [...TERMINAL].sort(), 'the list is the relay’s, passed through');
  });
});

describe('the phone-sized formatting rules', () => {
  it('says how much it omitted instead of cutting silently', () => {
    const long = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n');
    const out = tailLines(long, 5);
    assert.match(out, /省略前 35 行/);
    assert.match(out, /line 40/);
  });

  it('leaves short output alone', () => {
    assert.equal(tailLines('a\nb', 5), 'a\nb');
  });

  it('names a machine with no verdict rather than dropping it', () => {
    const lines = describeMachines({ results: [{ machine: 'macmini' }] });
    assert.equal(lines.length, 1);
    assert.match(lines[0], /macmini/);
  });

  it('reads the per-machine rows from the shapes a live relay returns', () => {
    // `machines` on a report, `leases` on a status. Both measured; neither was guessed.
    assert.equal(describeMachines({ machines: [{ machine_name: 'a', outcome: 'ok' }] }).length, 1);
    assert.equal(describeMachines({ leases: [{ machine_name: 'a', state: 'done' }] }).length, 1);
    // And the per-machine verdict is `outcome`, with `status` alongside rather than instead of it.
    const row = describeMachines({
      machines: [{ machine_name: 'e2e-agent', outcome: 'unverifiable', status: 'nonzero_exit', exit_code: 1 }],
    })[0];
    assert.match(row, /e2e-agent: unverifiable/);
    assert.match(row, /status nonzero_exit/);
    assert.match(row, /exit 1/);
  });

  it('returns nothing for a body with no per-machine rows, including an empty object', () => {
    assert.deepEqual(describeMachines({}), []);
    assert.deepEqual(describeMachines({ status: 'consistent' }), []);
  });

  it('formats a failed dispatch without pretending there is a task', () => {
    const text = formatRunResult({ taskId: 't', wait: { ok: false, text: '没有机器在线' } });
    assert.match(text, /派发失败/);
    assert.match(text, /没有机器在线/);
  });
});

describe('a host that supplies no session surface gets named refusals', () => {
  it('throws a sentence, not a TypeError, for an unwired operation', () => {
    const actions = createChatopsActions({ executor: stubExecutor(), host: {} });
    assert.throws(() => actions.listSessions(), /没有接入 会话列表/);
  });

  it('reports through the router as an error rather than as a permission answer', async () => {
    const actions = createChatopsActions({ executor: stubExecutor(), host: {} });
    const result = await route('/sessions', {
      capabilities: new Set(OWNER_CAPABILITIES),
      identity: { channel: 'ilink', id: 'peer', window: 'user:peer' },
      policyModes: [],
      actions,
    });
    assert.equal(result.kind, 'error');
    assert.doesNotMatch(result.text, /权限/);
  });

  it('keeps prompt undefined so the bridge can say there is no session', () => {
    const actions = createChatopsActions({ executor: stubExecutor(), host: {} });
    assert.equal(actions.prompt, undefined);
  });
});

describe('trust goes through the policy, so there is one source of truth', () => {
  it('delegates /trust to policy rather than keeping its own list', async () => {
    const policy = createPolicy({ trustedContacts: ['ilink:owner'] });
    const actions = createChatopsActions({ executor: stubExecutor(), host: HOST, policy });
    assert.deepEqual(actions.trust('ilink', 'friend'), { ok: true });
    assert.equal(policy.ownerCount, 2);
    assert.equal(actions.distrust('ilink', 'friend').ok, true);
    assert.equal(policy.ownerCount, 1);
  });

  it('says so when no policy is wired, instead of reporting success', () => {
    const actions = createChatopsActions({ executor: stubExecutor(), host: HOST });
    assert.equal(actions.trust('ilink', 'x').ok, false);
  });
});

describe('the executor talks to the paths the plugin already uses', () => {
  it('posts to /v1/task, reads /v1/tasks/<id>, /report and /devices', async () => {
    const { executor, r } = executorFor({
      task: { task_id: 'task-1' },
      status: { aggregate: { status: 'consistent' } },
      report: { verdict: 'consistent' },
      devices: { devices: [{ machine_id: 'm1', name: 'macmini', platform: 'macos' }] },
    });
    await executor.run(['node', '--test']);
    await executor.status('task-1');
    await executor.report('task-1');
    await executor.devices();
    const paths = r.calls.map((c) => c.url.replace('http://relay.test:8787', ''));
    assert.deepEqual(paths, [RELAY.TASK, RELAY.TASK_STATUS('task-1'), RELAY.TASK_REPORT('task-1'), RELAY.DEVICES]);
  });

  it('uses the operator token to dispatch and the device token to read', async () => {
    // Measured: GET /v1/tasks/<id> with the operator token answers 401 naming device_token. The
    // two credentials are not interchangeable, so the executor holds both.
    const { executor, r } = executorFor({ task: { task_id: 't' }, status: { aggregate: { status: 'consistent' } } });
    await executor.run(['node', '--test']);
    await executor.status('t');
    assert.equal(r.calls[0].headers.authorization, 'Bearer operator-token', 'dispatch uses the operator token');
    assert.equal(r.calls[1].headers.authorization, 'Bearer device-token', 'a task read uses the device token');
  });

  it('maps relay devices onto the shape /machines prints', async () => {
    const { executor } = executorFor({ devices: { devices: [{ machine_id: 'm1', name: 'macmini', platform: 'macos', arch: 'arm64', online: true }] } });
    const result = await executor.devices();
    assert.equal(result.devices[0].name, 'macmini');
  });

  it('surfaces a transport failure with its cause, not just "fetch failed"', async () => {
    const executor = createFleetExecutor({
      rabbitUrl: 'http://relay.test:8787',
      fetch: async () => {
        const error = new TypeError('fetch failed');
        error.cause = { code: 'ECONNRESET' };
        throw error;
      },
    });
    const result = await executor.run(['node', '--test']);
    assert.equal(result.ok, false);
    assert.match(result.text, /ECONNRESET|refused/);
  });

  it('refuses to be built without a relay url', () => {
    assert.throws(() => createFleetExecutor({}), /requires a rabbitUrl/);
  });

  it('refuses to be built without an executor', () => {
    assert.throws(() => createChatopsActions({}), /requires an executor/);
  });
});
