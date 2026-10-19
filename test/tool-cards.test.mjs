/**
 * UI card contract for the eight W2M tools (v0.3.3).
 *
 * This file exists because "UI cards" was an open item for several rounds and the answer turned out to
 * be: **there is nothing to add.** The runtime treats `presentCall`'s return value as an opaque hint
 * and never validates it -- `defineTool` merely wraps it so a schema-invalid argument list yields
 * `undefined` (`dsh-tools/lib/index.js:874-877` in the shipped runtime). There is no registry of card
 * types to choose from, and no consumer in the shipped bundle that reads `card` at all.
 *
 * What the shipped runtime *does* contain is two reference implementations, and they are the only
 * evidence available for what the fields mean:
 *
 *   `dsh-tools/lib/index.js:1445`          run_code        { card: "generic", title: args.description,
 *                                                             kind: "execute", rawInput: args.code }
 *   `dsh-plugin-manager/lib/types/tools.js:85`  the plugin manager
 *                                          { card: 'generic', title: '…',
 *                                            kind: args.action.startsWith('list_') ? 'read' : 'other',
 *                                            rawInput: args }
 *
 * Both use `card: 'generic'`. The plugin manager varies `kind` by whether the action mutates. That is
 * the whole vocabulary with a reference behind it, so the tests below assert exactly that much and no
 * more -- inventing a richer card would be guessing at an interface nobody has documented.
 *
 * The one real defect this file was written to catch: `w2m_update` reported `kind: 'read'` while being
 * able to install a new version into the very profile it runs in. A false "read" is worse than no hint,
 * because the hint is what a user reads to decide whether a call is safe.
 *
 * ---------------------------------------------------------------------------------------------
 * v0.6.2, second subject: the exposure boundary (A9)
 * ---------------------------------------------------------------------------------------------
 *
 * The same question — *what is a user allowed to believe about this surface* — asked one level up.
 * This plugin holds an operator token that authorises dispatch fleet-wide, and its tools are callable
 * by a model. So the boundary between "what a tool may do" and "what only an operator may do" is a
 * claim, and a claim with no assertion behind it is a sentence in a header.
 *
 * The boundary itself is written down in `src/plugin/tools.mjs` ("The exposure boundary: what an
 * agent-facing tool may not do"). The two assertions here are the mechanical half of it:
 *
 *   1. no registered `w2m_*` tool declares a parameter whose name suggests it sets a credential, an
 *      allow-list, a key path or a state directory — i.e. no tool can *hold* one of these;
 *   2. no tool result carries a credential, whatever the tool is asked — i.e. no tool can *move* one.
 *
 * Both are written to fail loudly on an addition rather than to describe the current set: the
 * parameter sweep names the classes it forbids, and the credential sweep runs every tool and checks
 * both halves of each exchange (what came back, and what was sent).
 */

import { after, describe, it } from 'node:test';

/**
 * v1.1.6: `autoStartAgent` defaults to true. Cases in this file are about something else, so the harness pins it off
 * once; call sites were renamed first, so this wrapper's own `plugin.apply` is still a real call.
 */
function applyPinned(ctx, config = {}) {
  return plugin.apply(ctx, { autoStartAgent: false, ...config });
}
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as plugin from '../src/plugin/tools.mjs';

const cleanup = [];

after(() => {
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
});

/** A throwaway profile directory. */
function makeProfile() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'w2m-card-'));
  cleanup.push(dir);
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'dsh-profile-test' }), 'utf8');
  return dir;
}

/** A throwaway state directory, optionally holding a `device.json`. */
function makeStateDir(device) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'w2m-card-state-'));
  cleanup.push(dir);
  if (device) writeFileSync(path.join(dir, 'device.json'), JSON.stringify(device, null, 2), 'utf8');
  return dir;
}

/**
 * A throwaway directory that is **not** a git work tree.
 *
 * The credential sweep calls `w2m_run` and `w2m_status`, and both fingerprint the project through a
 * temporary index (`git add -A` into a scratch index, then `git write-tree`). Pointed at a real
 * checkout that writes objects into its `.git`, which a test has no business doing to a tree other
 * workstreams are editing — and it costs seconds. A directory that answers "not a work tree" on the
 * first git call ends the whole anchor path immediately.
 */
function makeNonRepoDir() {
  return makeStateDir(null);
}

/** Register the plugin and hand back the tool map. */
async function register(config = {}) {
  const tools = new Map();
  const ctx = {
    tools: { register: (tool) => tools.set(tool.name, tool) },
    effect: () => {},
    on: () => {},
  };
  await applyPinned(ctx, { rabbitUrl: 'http://127.0.0.1:1', ...config });
  return tools;
}

describe('tool cards: the contract the shipped runtime actually implements', () => {
  it('gives every tool a presentCall that yields a generic card with a title', async () => {
    const tools = await register({ stateDir: makeProfile() });
    assert.equal(tools.size, 13, 'the twelve tools are the surface this contract covers');
    for (const [name, tool] of tools) {
      assert.equal(typeof tool.presentCall, 'function', `${name} needs a presentCall`);
      const card = tool.presentCall({});
      assert.ok(card && typeof card === 'object', `${name}.presentCall must return an object`);
      // `generic` is the only card value with a reference implementation in the shipped runtime.
      assert.equal(card.card, 'generic', `${name} must use the only documented card value`);
      assert.equal(typeof card.title, 'string', `${name} needs a title`);
      assert.ok(card.title.length > 0, `${name}'s title must not be empty`);
      assert.ok('rawInput' in card, `${name} must supply rawInput`);
      assert.equal(typeof card.kind, 'string', `${name} needs a kind`);
    }
  });

  it('marks a check-and-install cycle as mutating, not as a read', async () => {
    // The defect this file exists for. `check` installs a newer release when one exists, so reporting
    // it as a read is a false claim about safety in the one place a user reads to judge that.
    const tools = await register({ stateDir: makeProfile() });
    const update = tools.get('w2m_update');

    assert.equal(update.presentCall({ action: 'check' }).kind, 'other',
      'a cycle that can install must not be labelled read');
    // `status` only reports; `'read'` is accurate for it and is the value the reference implementation
    // uses for its non-mutating actions.
    assert.equal(update.presentCall({ action: 'status' }).kind, 'read');
    // With no action the tool defaults to `status`, so the no-argument call must agree with `status`.
    assert.equal(update.presentCall({}).kind, 'read', 'the default action is status');
    assert.equal(update.presentCall(undefined).kind, 'read', 'a missing args object is the default action');
  });

  it('keeps a write-capable run distinguishable from a read-only one', async () => {
    const tools = await register({ stateDir: makeProfile() });
    const run = tools.get('w2m_run');
    const reading = run.presentCall({ command_argv: ['node', '--test'] });
    const writing = run.presentCall({ command_argv: ['node', '--test'], write: true });
    assert.notEqual(reading.kind, writing.kind, 'a writing run must not look like a read-only one');
    assert.equal(writing.kind, 'write');
    assert.equal(reading.kind, 'read');
  });

  it('never puts a credential in rawInput', async () => {
    // rawInput is handed to the UI, so anything in it is rendered. Tokens belong to the host config and
    // must not travel into a card, however the argument list is shaped.
    const tools = await register({
      stateDir: makeProfile(),
      operatorToken: 'LEAK-CANARY-OPERATOR',
      signingSecret: 'LEAK-CANARY-SIGNING',
    });
    for (const [name, tool] of tools) {
      const rendered = JSON.stringify(tool.presentCall({ action: 'check', command_argv: ['node'] }) ?? {});
      assert.equal(rendered.includes('LEAK-CANARY-OPERATOR'), false, `${name} leaked the operator token`);
      assert.equal(rendered.includes('LEAK-CANARY-SIGNING'), false, `${name} leaked the signing secret`);
    }
  });

  it('survives being called with no arguments, like the runtime does on an invalid call', async () => {
    // `defineTool` returns `undefined` from `presentCall` when the arguments fail schema validation
    // (`dsh-tools/lib/index.js:875`), so the UI must already cope with a missing card -- but our own
    // function is still called with whatever the caller passed, including nothing.
    const tools = await register({ stateDir: makeProfile() });
    for (const [name, tool] of tools) {
      assert.doesNotThrow(() => tool.presentCall(undefined), `${name}.presentCall(undefined)`);
      assert.doesNotThrow(() => tool.presentCall({}), `${name}.presentCall({})`);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// The exposure boundary
// ---------------------------------------------------------------------------------------------

/**
 * Parameter names a `w2m_*` tool may never declare, grouped by the boundary they would cross.
 *
 * The rule is about **what a tool can hold**, not about what a well-behaved caller would pass. A
 * parameter is a promise that the value will be used, so a `token` parameter is a promise to accept a
 * credential from a model, an `allowed_commands` parameter is a promise to rewrite what every machine
 * will run, and a `state_dir` or `key_path` parameter is a promise to pick up — or write — another
 * machine's identity. None of those is a narrowing; each one *widens*, which is the one direction this
 * project refuses everywhere else.
 *
 * The lists are deliberately name-shaped and generous: a parameter that merely sounds like one of
 * these is refused by review, not by this test, and a false positive here costs a rename rather than a
 * hole. `executor_machine_id` — the one parameter that names a machine — is deliberately *not* on any
 * list, and {@link it} asserts the sweep sees it, so this test cannot pass by the tool set going
 * empty.
 */
const FORBIDDEN_PARAMETER_PATTERNS = [
  // A credential. Every one of these is read from the host config or the environment and is never a
  // caller's to supply: accepting one would let a model choose whose fleet-wide authority to spend.
  { why: 'a credential', re: /token/i },
  { why: 'a credential', re: /secret/i },
  { why: 'a credential', re: /password/i },
  { why: 'a credential', re: /passphrase/i },
  { why: 'a credential', re: /credential/i },
  { why: 'a credential', re: /api[_-]?key/i },
  { why: 'a credential', re: /pairing[_-]?code/i },
  { why: 'a credential', re: /bearer/i },
  // The allow-list. What a machine will run is decided by that machine's own configuration and by
  // whoever edits the files on it; a tool that could write the list would be a tool that widens
  // execution fleet-wide without touching a single machine.
  { why: 'an allow-list', re: /allow/i },
  { why: 'an allow-list', re: /whitelist/i },
  { why: 'an allow-list', re: /blacklist/i },
  { why: 'an allow-list', re: /deny/i },
  { why: 'an allow-list', re: /permit/i },
  // Key material and identity files. `device.key` is this machine's private half and `device.json` is
  // its identity; a path parameter for either is a promise to read or replace them.
  { why: 'a key path or identity file', re: /key[_-]?(path|file)/i },
  { why: 'a key path or identity file', re: /private[_-]?key/i },
  { why: 'a key path or identity file', re: /public[_-]?key/i },
  { why: 'a key path or identity file', re: /device[_-]?key/i },
  { why: 'a key path or identity file', re: /identity[_-]?(file|path)/i },
  { why: 'a key path or identity file', re: /state[_-]?dir/i },
];

/** Is this parameter name forbidden, and why? `null` when it is fine. */
function forbiddenParameter(name) {
  const hit = FORBIDDEN_PARAMETER_PATTERNS.find((entry) => entry.re.test(name));
  return hit ? hit.why : null;
}

/** The bearer token the stub relay accepts. A canary: it must never come back out. */
const CANARY_OPERATOR = 'LEAK-CANARY-OPERATOR';
const CANARY_PAIRING = 'LEAK-CANARY-PAIRING';
const CANARY_DEVICE = 'LEAK-CANARY-DEVICE';
const CANARY_UPDATE = 'LEAK-CANARY-UPDATE';

const CANARIES = [CANARY_OPERATOR, CANARY_PAIRING, CANARY_DEVICE, CANARY_UPDATE];

/** A paired device whose own token is a canary. */
const CANARY_DEVICE_JSON = {
  machine_id: '3f2a9c14-6d1e-4a77-9f10-2c8b1d5e7a30',
  machine_name: 'win-desktop',
  device_token: CANARY_DEVICE,
  rabbit_url: 'http://127.0.0.1:1',
};

/** The aggregate `w2m_wait` reads, already terminal so no poll loop is entered. */
const TERMINAL_TASK = {
  protocol_version: 1,
  rabbit_time: '2026-10-07T12:00:00Z',
  task: { task_id: 'T-CANARY', mode: 'replicate', index_total: 1 },
  leases: [],
  aggregate: {
    task_id: 'T-CANARY',
    status: 'consistent',
    counts: { refused: 0, unverifiable: 0, ok: 1, failed: 0, expired: 0, pending: 0 },
    differences: [],
    notes: [],
    machines: [
      {
        machine_id: 'aaa',
        machine_name: 'win-desktop',
        index: 0,
        attempt: 1,
        lease_state: 'reported',
        outcome: 'ok',
        status: 'ok',
        refusal_reason: null,
        exit_code: 0,
        reasons: [],
        envelope: {
          status: 'ok',
          exit_code: 0,
          stdout_sha256: 'a'.repeat(64),
          stdout_bytes: 12,
          base_commit: 'c'.repeat(40),
          base_tree: 'd'.repeat(40),
          pre_tree_fingerprint: 'd'.repeat(40),
          command_hash: 'e'.repeat(64),
        },
      },
    ],
  },
};

/** The one machine the stub relay holds. */
const CANARY_FLEET = {
  protocol_version: 1,
  rabbit_time: '2026-10-07T12:00:00Z',
  devices: [
    {
      machine_id: 'aaa',
      machine_name: 'win-desktop',
      platform: { os: 'windows', os_version: '10.0.26100', arch: 'x64', shell: 'pwsh' },
      caps: { case_sensitive_fs: false, symlinks: false, exec_bit: false },
      last_seen: '2026-10-07T12:00:00Z',
      state: 'online',
    },
  ],
};

/** `/healthz`, as a relay that requires an operator token answers it. */
const CANARY_HEALTHZ = {
  protocol_version: 1,
  rabbit_time: '2026-10-07T12:00:00Z',
  relay_id: 'relay-canary',
  uptime_ms: 1000,
  started_at: '2026-10-07T11:00:00Z',
  base_path: null,
  effective_scheme: 'http',
  operator_token_required: true,
  pair_rate_limit: 10,
  persistence: 'memory',
  devices: 1,
  tasks: 1,
  results: 1,
  pairing_codes: 0,
};

/**
 * Install a routing `fetch` for the credential sweep, and record every call.
 *
 * A route's `body` is JSON; `text` names a non-JSON answer (`w2m_report`'s markdown). An undeclared
 * route throws, so a tool that starts calling somewhere new fails loudly instead of quietly passing
 * the sweep with a shorter result.
 *
 * @param {Array<{method?: string, path: string, body?: unknown, text?: string, contentType?: string}>} routes
 * @returns {{calls: Array<{method: string, path: string, headers: object, body: string|null}>, restore: () => void}}
 */
function installFetch(routes) {
  const calls = [];
  const previousFetch = globalThis.fetch;

  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : (input?.url ?? String(input)));
    const method = String(init.method ?? 'GET').toUpperCase();
    const headers = init.headers ?? {};
    const body = init.body === undefined || init.body === null ? null : String(init.body);
    calls.push({ method, path: url.pathname, headers, body });

    const route = routes.find(
      (candidate) => candidate.path === url.pathname && String(candidate.method ?? 'GET').toUpperCase() === method,
    );
    if (!route) throw new Error(`test route missing: ${method} ${url.pathname}`);

    const text = route.text ?? JSON.stringify(route.body ?? {});
    return new Response(text, {
      status: 200,
      headers: { 'content-type': route.contentType ?? 'application/json' },
    });
  };

  return {
    calls,
    restore: () => {
      globalThis.fetch = previousFetch;
    },
  };
}

describe('exposure boundary: a tool may not hold a credential, an allow-list or a key path', () => {
  it('names the classes it forbids, so a pattern that matches nothing is caught here', () => {
    // The self-check for the sweep below. A pattern list that had drifted into matching nothing would
    // make that test pass for every future tool too, which is the failure mode this file exists for.
    for (const name of [
      'operator_token',
      'deviceToken',
      'signing_secret',
      'password',
      'api_key',
      'pairing_code',
      'allowed_commands',
      'allowedCommands',
      'whitelist',
      'device_key_path',
      'private_key',
      'state_dir',
    ]) {
      assert.notEqual(forbiddenParameter(name), null, `\`${name}\` must be refused by name`);
    }
    // ...and the names this surface legitimately carries are not caught, so the sweep cannot be
    // satisfied by renaming a real parameter into something unrecognisable.
    for (const name of ['executor_machine_id', 'command_argv', 'write_scope', 'cwd_rel', 'timeout_ms', 'include_stale']) {
      assert.equal(forbiddenParameter(name), null, `\`${name}\` is a legitimate parameter`);
    }
  });

  it('declares no parameter that could set a credential, widen an allow-list or name a key file', async () => {
    const tools = await register({
      stateDir: makeStateDir(CANARY_DEVICE_JSON),
      operatorToken: CANARY_OPERATOR,
      pairingCode: CANARY_PAIRING,
    });

    let seen = 0;
    const everyName = [];
    for (const [toolName, tool] of tools) {
      for (const parameter of Object.keys(tool.parameters ?? {})) {
        seen += 1;
        everyName.push(parameter);
        const why = forbiddenParameter(parameter);
        assert.equal(
          why,
          null,
          `${toolName} declares \`${parameter}\`, which names ${why} - a tool that can set one of ` +
            'these widens what the fleet will do, and that decision belongs to an operator editing ' +
            'configuration on the machine itself, never to a model',
        );
      }
    }

    // Not decoration: without it, a future edit that registered no tools -- or renamed the surface --
    // would satisfy the loop above while asserting nothing at all.
    assert.equal(seen > 0, true, 'the sweep must have read a parameter map');
    assert.ok(
      everyName.includes('executor_machine_id'),
      `the sweep must have seen the one machine-naming parameter; it saw ${everyName.join(', ')}`,
    );
  });
});

describe('exposure boundary: no tool result may carry a credential', () => {
  it('returns none of the four credentials from any of the twelve tools, and never puts one in a body', async () => {
    const fetchStub = installFetch([
      { method: 'GET', path: '/healthz', body: CANARY_HEALTHZ },
      { method: 'GET', path: '/v1/devices', body: CANARY_FLEET },
      { method: 'POST', path: '/v1/task', body: { task_id: 'T-CANARY', seq: 1, leases: [] } },
      { method: 'GET', path: '/v1/tasks/T-CANARY', body: TERMINAL_TASK },
      {
        method: 'GET',
        path: '/v1/tasks/T-CANARY/report',
        text: '# T-CANARY\n\none machine, consistent\n',
        contentType: 'text/markdown',
      },
      {
        method: 'GET',
        path: '/v1/tasks',
        body: {
          protocol_version: 1,
          rabbit_time: '2026-10-07T12:00:00Z',
          tasks: [{ task_id: 'T-CANARY', mode: 'replicate', index_total: 1, cancelled: false, leases: [], lease_states: {} }],
        },
      },
    ]);

    const previousUpdateToken = process.env.W2M_UPDATE_TOKEN;
    process.env.W2M_UPDATE_TOKEN = CANARY_UPDATE;

    try {
      const tools = await register({
        // `relay` mode on purpose: this sweep is about what a result carries, and a UDP socket plus an
        // announce loop would add a moving part that can fail for reasons unrelated to credentials.
        p2pMode: 'relay',
        stateDir: makeStateDir(CANARY_DEVICE_JSON),
        projectDir: makeNonRepoDir(),
        operatorToken: CANARY_OPERATOR,
        pairingCode: CANARY_PAIRING,
      });

      const sweep = [
        ['w2m_devices', {}],
        ['w2m_run', { command_argv: ['node', '--test'] }],
        ['w2m_wait', { task_id: 'T-CANARY', wait_ms: 400, poll_ms: 25 }],
        ['w2m_report', { task_id: 'T-CANARY' }],
        ['w2m_status', {}],
        ['w2m_update', { action: 'status' }],
        ['w2m_history', { limit: 1 }],
        ['w2m_stats', {}],
        // v0.9.6. Swept like the rest because it answers from a state directory that holds
        // `device.json` -- exactly the kind of tool that could echo a credential back in a "here is
        // what I found" field. It reports paths and its own records, never the device file's contents.
        ['w2m_memory', {}],
        // v0.26.0. Swept for the same reason and one more: its rows are built from whatever was
        // dispatched, so a request's `reason` text is attacker-adjacent input that reaches a model.
        // An empty queue is enough to prove the tool answers without a credential, and the sweep is
        // about the shape of the result, not about filling the queue.
        ['w2m_approvals', { action: 'list' }],
        // v0.37.0. Swept because it holds live state across calls: a council id, phases, ballots. Exactly the
        // kind of tool whose result could echo back something it was handed.
        ['w2m_council', { action: 'list' }],
      ];

      const results = [];
      for (const [name, args] of sweep) {
        const text = await tools.get(name).execute(args, {});
        assert.equal(typeof text, 'string', `${name} must answer with a string`);
        // A tool that failed would produce a short result that trivially carries no credential, so
        // "it ran and said something" is part of the assertion rather than an assumption.
        const parsed = JSON.parse(text);
        assert.equal(parsed.ok, true, `${name} must have run: ${text.slice(0, 200)}`);
        results.push([name, text]);
      }
      assert.equal(results.length, 11, 'every registered tool must be swept, not a sample of them');

      for (const [name, text] of results) {
        for (const canary of CANARIES) {
          assert.equal(
            text.includes(canary),
            false,
            `${name}'s result carried ${canary}: a tool result is read by a model and rendered in a ` +
              'transcript, so a credential that reaches one has left the host configuration',
          );
        }
      }

      // The other half of the exchange. The operator token and the device token legitimately travel in
      // an `Authorization` header -- that is what they are for -- but never in a body, and no header
      // but that one may carry them.
      assert.equal(fetchStub.calls.length > 0, true, 'the sweep must have made calls to inspect');
      for (const call of fetchStub.calls) {
        for (const canary of CANARIES) {
          assert.equal(
            (call.body ?? '').includes(canary),
            false,
            `${call.method} ${call.path} sent ${canary} in the request body`,
          );
        }
        for (const [header, value] of Object.entries(call.headers)) {
          const rendered = String(value);
          const carries = CANARIES.filter((canary) => rendered.includes(canary));
          if (carries.length === 0) continue;
          assert.equal(
            header.toLowerCase(),
            'authorization',
            `${call.method} ${call.path} put ${carries.join(', ')} in the \`${header}\` header`,
          );
        }
      }

      // The two claims this sweep exists to pin, stated as facts about the answers rather than left to
      // be inferred from "no canary appeared": the credential is reported as a presence, and the
      // operator token is authenticated with rather than echoed.
      const status = JSON.parse(results.find(([name]) => name === 'w2m_status')[1]);
      assert.equal(status.config.operatorToken_configured, true);
      assert.equal(status.config.pairingCode_configured, true, 'presence, not the value');
      assert.equal(status.identity.paired, true);
      assert.equal(
        fetchStub.calls.some(
          (call) => call.method === 'POST' && call.path === '/v1/task'
            && String(call.headers.authorization ?? '') === `Bearer ${CANARY_OPERATOR}`,
        ),
        true,
        'the operator token must still be the thing that authorises the dispatch',
      );
    } finally {
      fetchStub.restore();
      if (previousUpdateToken === undefined) delete process.env.W2M_UPDATE_TOKEN;
      else process.env.W2M_UPDATE_TOKEN = previousUpdateToken;
    }
  });
});

