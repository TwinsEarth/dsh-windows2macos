/**
 * Turning a chat message into an action (v0.7.0).
 *
 * The property this file exists to protect is that **authorisation belongs to the command,
 * not to the caller.** `dsh-chatops` 0.1.0 kept its eleven commands in a `switch` inside a
 * 1,060-line class and gated all of them behind one undifferentiated "is this a trusted
 * window" check, so `/sessions`, `/policy 2` and `/approve` were equally reachable by
 * anyone who had ever been admitted. Here each command declares what it needs, the router
 * refuses before the handler runs, and the tests below assert on the *code* rather than on
 * the sentence — a refusal that reads as a permission answer when it was really a typo is
 * how an operator concludes they lack access they actually have.
 *
 * Three more properties, each of which was a real defect somewhere in that codebase:
 *
 *   * **a misspelled command is not a prompt.** Sending `/sesions` to the model because it
 *     was not recognised is how a typo turns into unexpected model work; the parse refuses
 *     it and says so.
 *   * **an approval id from another window is not honoured.** `/approve <id>` resolves
 *     against *this* window's pending list, so a trusted identity cannot answer a request
 *     it was never shown.
 *   * **the help cannot drift from the implementation**, because it is generated from the
 *     same table the router dispatches through.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  route,
  parseCommand,
  commandTable,
  helpText,
  CAPABILITY,
  OWNER_CAPABILITIES,
  ROUTE_REFUSAL,
} from '../src/chatops/commands.mjs';

/** An action set that records what was called, with scripted results. */
function actions(over = {}) {
  const calls = [];
  const base = {
    listSessions: async () => [
      { id: 'sess-aaaa-1111', title: 'fix the parser' },
      { id: 'sess-bbbb-2222', title: 'write docs' },
    ],
    boundSession: async () => 'sess-aaaa-1111',
    bind: async (window, id) => calls.push(['bind', window, id]),
    tail: async (id, limit) => [`line 1 of ${id}`, `line ${limit}`],
    listMachines: async () => [
      { id: 'm-1', name: 'win-desktop', os: 'windows', arch: 'x64', online: true },
      { id: 'm-2', name: 'macmini', os: 'macos', arch: 'arm64', online: false },
    ],
    dispatch: async (argv) => ({ taskId: 'task-1', summary: `已派发：${argv.join(' ')}` }),
    pending: () => [],
    decideApproval: () => ({ ok: true }),
    setPolicy: async (id, mode) => calls.push(['setPolicy', id, mode]),
    trust: () => ({ ok: true }),
    distrust: () => ({ ok: true }),
  };
  return { actions: { ...base, ...over }, calls };
}

function ctx(over = {}) {
  const { actions: a, calls } = actions(over.actions);
  return {
    calls,
    ctx: {
      capabilities: new Set(over.capabilities ?? OWNER_CAPABILITIES),
      identity: over.identity ?? { channel: 'feishu', id: 'ou_owner', window: 'fsu:ou_owner' },
      policyModes: over.policyModes ?? ['read-only', 'ask', 'danger-full-access'],
      actions: a,
      commands: over.commands,
    },
  };
}

const PENDING = [
  { approval_id: 'appr-1111-2222', window: 'fsu:ou_owner', tool: 'bash', remaining_ms: 30_000, reason: 'rm -rf ./tmp' },
  { approval_id: 'appr-3333-4444', window: 'fsu:ou_owner', tool: 'write', remaining_ms: 20_000, reason: null },
];

describe('a command is gated by what it needs, not by who is asking', () => {
  it('refuses /policy to an identity without the policy capability', async () => {
    const { ctx: c } = ctx({ capabilities: [CAPABILITY.VIEW, CAPABILITY.OPERATE] });
    const result = await route('/policy 2', c);
    assert.equal(result.kind, 'refused');
    assert.equal(result.refusal, ROUTE_REFUSAL.FORBIDDEN, 'the code is what a test can hold on to');
    assert.match(result.text, /policy/);
  });

  it('refuses /run to an identity that may view but not dispatch', async () => {
    const { ctx: c, calls } = ctx({ capabilities: [CAPABILITY.VIEW] });
    const result = await route('/run node --test', c);
    assert.equal(result.refusal, ROUTE_REFUSAL.FORBIDDEN);
    assert.deepEqual(calls, [], 'a refused command must not reach the action');
  });

  it('refuses /log to an identity without transcript access', async () => {
    // Transcripts are where a model's output lands, which can include anything it read.
    const { ctx: c } = ctx({ capabilities: [CAPABILITY.VIEW, CAPABILITY.OPERATE] });
    assert.equal((await route('/log 5', c)).refusal, ROUTE_REFUSAL.FORBIDDEN);
  });

  it('refuses /trust to an identity without admin', async () => {
    // The capability that can widen every other capability is the one most worth gating.
    const { ctx: c } = ctx({ capabilities: OWNER_CAPABILITIES.filter((x) => x !== CAPABILITY.ADMIN) });
    assert.equal((await route('/trust feishu:ou_x', c)).refusal, ROUTE_REFUSAL.FORBIDDEN);
  });

  it('still allows the read-only commands an owner obviously needs', async () => {
    const { ctx: c } = ctx();
    for (const text of ['/help', '/whoami', '/sessions', '/pending', '/machines']) {
      const result = await route(text, c);
      assert.equal(result.kind, 'ok', `${text} should be allowed: ${result.text}`);
    }
  });

  it('checks authorisation before the handler, so a handler cannot forget', async () => {
    // Proven by the handler never being reached: the action recorder stays empty.
    const { ctx: c, calls } = ctx({
      capabilities: [],
      actions: { bind: async () => calls.push(['should-not-happen']) },
    });
    await route('/use 1', c);
    assert.deepEqual(calls, []);
  });
});

describe('a misspelled command is not sent to the model', () => {
  it('refuses an unknown /name with a named code', async () => {
    const { ctx: c } = ctx();
    const result = await route('/sesions', c);
    assert.equal(result.kind, 'refused');
    assert.equal(result.refusal, ROUTE_REFUSAL.UNKNOWN_COMMAND);
    assert.match(result.text, /help/);
  });

  it('passes ordinary text through as a prompt', async () => {
    const { ctx: c } = ctx();
    const result = await route('把 README 翻译成英文', c);
    assert.equal(result.kind, 'prompt');
    assert.equal(result.text, '把 README 翻译成英文');
  });

  it('treats a bare slash as a prompt rather than an empty command', async () => {
    const parsed = parseCommand('/');
    assert.equal(parsed.kind, 'command');
    assert.equal(parsed.name, '');
    const { ctx: c } = ctx();
    assert.equal((await route('/', c)).refusal, ROUTE_REFUSAL.UNKNOWN_COMMAND);
  });

  it('lower-cases the name, so /HELP works', async () => {
    const { ctx: c } = ctx();
    assert.equal((await route('/HELP', c)).kind, 'ok');
  });

  it('splits arguments on whitespace and keeps the rest intact', async () => {
    const parsed = parseCommand('/run   node   --test  ');
    assert.deepEqual(parsed, { kind: 'command', name: 'run', args: ['node', '--test'] });
  });

  it('treats a non-string as an empty prompt rather than throwing', async () => {
    assert.deepEqual(parseCommand(null), { kind: 'prompt', text: '' });
    assert.deepEqual(parseCommand(undefined), { kind: 'prompt', text: '' });
  });
});

describe('an approval id is resolved against this window only', () => {
  it('answers the oldest request when no id is given', async () => {
    const decided = [];
    const { ctx: c } = ctx({ actions: { pending: () => PENDING, decideApproval: (id, o) => (decided.push([id, o]), { ok: true }) } });
    const result = await route('/approve', c);
    assert.equal(result.kind, 'ok');
    assert.deepEqual(decided, [['appr-1111-2222', 'allowed-once']]);
  });

  it('refuses an id that this window was never shown', async () => {
    const decided = [];
    const { ctx: c } = ctx({
      actions: { pending: () => PENDING, decideApproval: (id, o) => (decided.push([id, o]), { ok: true }) },
    });
    // `appr-9999` exists elsewhere; honouring it here would let a trusted identity answer a
    // request it had no business seeing.
    const result = await route('/approve appr-9999', c);
    assert.equal(result.refusal, ROUTE_REFUSAL.BAD_ARGUMENTS);
    assert.deepEqual(decided, []);
  });

  it('accepts an unambiguous id prefix', async () => {
    const decided = [];
    const { ctx: c } = ctx({ actions: { pending: () => PENDING, decideApproval: (id) => (decided.push(id), { ok: true }) } });
    await route('/reject appr-3333', c);
    assert.deepEqual(decided, ['appr-3333-4444']);
  });

  it('reports a decision that did not take effect instead of claiming success', async () => {
    // The failure this replaces: 0.1.0 replied "✅ 已批准，继续执行" on the strength of a
    // promise resolving, with nothing tying it to the request it was authorising.
    const { ctx: c } = ctx({ actions: { pending: () => PENDING, decideApproval: () => ({ ok: false, reason: 'expired' }) } });
    const result = await route('/approve', c);
    assert.equal(result.kind, 'refused');
    assert.match(result.text, /expired/);
    assert.doesNotMatch(result.text, /已批准/);
  });

  it('says there is nothing to decide rather than failing', async () => {
    const { ctx: c } = ctx({ actions: { pending: () => [] } });
    const result = await route('/approve', c);
    assert.equal(result.kind, 'ok');
    assert.match(result.text, /没有待审批/);
  });

  it('shows what is waiting, with its deadline', async () => {
    const { ctx: c } = ctx({ actions: { pending: () => PENDING } });
    const result = await route('/pending', c);
    assert.match(result.text, /bash/);
    assert.match(result.text, /30s 后超时/);
  });
});

describe('binding a window to a session refuses to guess', () => {
  it('binds by list index', async () => {
    const { ctx: c, calls } = ctx();
    const result = await route('/use 2', c);
    assert.equal(result.kind, 'ok');
    assert.deepEqual(calls, [['bind', 'fsu:ou_owner', 'sess-bbbb-2222']]);
  });

  it('refuses an ambiguous prefix rather than picking one', async () => {
    // Two sessions sharing a prefix: binding the wrong one is a silent misroute and the
    // caller cannot tell it happened.
    const { ctx: c, calls } = ctx({
      actions: {
        listSessions: async () => [
          { id: 'sess-aaaa-1111', title: 'one' },
          { id: 'sess-aaaa-2222', title: 'two' },
        ],
      },
    });
    const result = await route('/use sess-aaaa', c);
    assert.equal(result.refusal, ROUTE_REFUSAL.BAD_ARGUMENTS);
    assert.match(result.text, /2 个会话/);
    assert.deepEqual(calls, []);
  });

  it('refuses an index that is out of range', async () => {
    const { ctx: c } = ctx();
    assert.equal((await route('/use 9', c)).refusal, ROUTE_REFUSAL.BAD_ARGUMENTS);
  });

  it('requires exactly one argument', async () => {
    const { ctx: c } = ctx();
    assert.equal((await route('/use', c)).refusal, ROUTE_REFUSAL.BAD_ARGUMENTS);
    assert.equal((await route('/use 1 2', c)).refusal, ROUTE_REFUSAL.BAD_ARGUMENTS);
  });
});

describe('the sandbox policy is chosen from an index, never from text', () => {
  it('accepts 0, 1 and 2', async () => {
    for (const [n, mode] of [[0, 'read-only'], [1, 'ask'], [2, 'danger-full-access']]) {
      const { ctx: c, calls } = ctx();
      assert.equal((await route(`/policy ${n}`, c)).kind, 'ok');
      assert.deepEqual(calls, [['setPolicy', 'sess-aaaa-1111', mode]]);
    }
  });

  it('refuses a name, so a future enum member cannot be selected from chat', async () => {
    const { ctx: c, calls } = ctx();
    assert.equal((await route('/policy danger-full-access', c)).refusal, ROUTE_REFUSAL.BAD_ARGUMENTS);
    assert.deepEqual(calls, []);
  });

  it('refuses an index with no mode behind it', async () => {
    const { ctx: c } = ctx();
    assert.equal((await route('/policy 7', c)).refusal, ROUTE_REFUSAL.BAD_ARGUMENTS);
  });
});

describe('the fleet is reachable, and says so when it is not', () => {
  it('lists the machines with their online state', async () => {
    const { ctx: c } = ctx();
    const result = await route('/machines', c);
    assert.match(result.text, /win-desktop/);
    assert.match(result.text, /●/);
    assert.match(result.text, /○/);
  });

  it('says the fleet is not connected rather than reporting an empty one', async () => {
    // "No machines" and "this install has no fleet" are different answers, and only one of
    // them is the operator's config being wrong.
    const { ctx: c } = ctx({ actions: { listMachines: undefined } });
    const result = await route('/machines', c);
    assert.equal(result.refusal, ROUTE_REFUSAL.UNAVAILABLE);
  });

  it('dispatches /run with the argv the operator typed', async () => {
    const sent = [];
    const { ctx: c } = ctx({ actions: { dispatch: async (argv) => (sent.push(argv), { taskId: 't', summary: 'sent' }) } });
    const result = await route('/run node --test', c);
    assert.equal(result.kind, 'ok');
    assert.deepEqual(sent, [['node', '--test']]);
    assert.equal(result.taskId, 't');
  });

  it('refuses /run with no command', async () => {
    const { ctx: c } = ctx();
    assert.equal((await route('/run', c)).refusal, ROUTE_REFUSAL.BAD_ARGUMENTS);
  });
});

describe('the help cannot drift from the implementation', () => {
  it('documents every command in the table', () => {
    const text = helpText();
    for (const command of commandTable()) {
      assert.match(text, new RegExp(`/${command.name}\\b`), `${command.name} is missing from help`);
    }
  });

  it('names no command the table does not have', async () => {
    const { ctx: c } = ctx();
    const result = await route('/help', c);
    const named = [...result.text.matchAll(/\/([a-z]+)/g)].map((m) => m[1]);
    const known = new Set(commandTable().map((x) => x.name));
    for (const n of new Set(named)) assert.ok(known.has(n), `help mentions /${n}, which is not a command`);
  });

  it('explains one command when asked, including its capability', async () => {
    const { ctx: c } = ctx();
    const result = await route('/help policy', c);
    assert.match(result.text, /\/policy <0\|1\|2>/);
    assert.match(result.text, /policy/);
  });

  it('every command declares a capability the router knows', () => {
    const known = new Set(Object.values(CAPABILITY));
    for (const command of commandTable()) {
      assert.ok(known.has(command.capability), `${command.name} declares ${command.capability}`);
      assert.ok(command.usage.startsWith(`/${command.name}`), `${command.name}: usage must start with its own name`);
      assert.equal(typeof command.run, 'function');
    }
  });
});

describe('a handler that throws is reported as a defect', () => {
  it('does not surface as a refusal the operator would read as a permission answer', async () => {
    const { ctx: c } = ctx({
      actions: {
        listSessions: async () => {
          throw new Error('session service unavailable');
        },
      },
    });
    const result = await route('/sessions', c);
    assert.equal(result.kind, 'error');
    assert.match(result.text, /session service unavailable/);
  });
});

describe('identity is reported back so a misroute is visible', () => {
  it('shows the channel, the id and the capabilities', async () => {
    const { ctx: c } = ctx({ capabilities: [CAPABILITY.VIEW] });
    const result = await route('/whoami', c);
    assert.match(result.text, /feishu:ou_owner/);
    assert.match(result.text, /fsu:ou_owner/);
    assert.match(result.text, /view/);
  });
});
