/**
 * Plugin wiring for the v0.2.3 daily self-update.
 *
 * These tests cover the seam between `tools.mjs` and `auto-update.mjs`: configuration validation,
 * `ctx.effect` ownership of the timer, and the `w2m_update` tool. The updater's own logic is covered
 * in `auto-update.test.mjs`; what matters here is that a *misconfiguration is loud* and that the
 * scheduled job never outlives the plugin.
 */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import * as plugin from '../src/plugin/tools.mjs';
import { findProfileDir } from '../src/plugin/auto-update.mjs';

const cleanup = [];
after(() => {
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
});

/**
 * A fake `ctx` carrying `tools`, and optionally a working `effect` that records its disposer.
 *
 * @param {{withEffect?: boolean, effectThrows?: boolean}} [opts]
 */
function makeCtx({ withEffect = true, effectThrows = false } = {}) {
  const tools = new Map();
  const warnings = [];
  const infos = [];
  const effects = [];
  const disposers = [];
  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return definition;
      },
    },
    logger: {
      warn: (m) => warnings.push(String(m)),
      info: (m) => infos.push(String(m)),
    },
  };
  if (withEffect) {
    ctx.effect = (factory) => {
      if (effectThrows) throw new Error('the host refused the effect');
      const disposer = factory();
      effects.push(disposer);
      if (typeof disposer === 'function') disposers.push(disposer);
      return disposer;
    };
  }
  return { ctx, tools, warnings, infos, effects, disposers };
}

/**
 * Register the plugin and return everything the assertions might need.
 *
 * @param {object} [config]
 * @param {object} [ctxOpts]
 */
async function register(config = {}, ctxOpts = {}) {
  const made = makeCtx(ctxOpts);
  await plugin.apply(made.ctx, config);
  return made;
}

/** A throwaway directory standing in for a DSH profile. */
function makeProfile() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'w2m-profile-'));
  cleanup.push(dir);
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'dsh-profile-test' }), 'utf8');
  return dir;
}

/** Read the update status the way a model would: through the tool. */
async function updateStatus(tools) {
  const tool = tools.get('w2m_update');
  assert.ok(tool, 'w2m_update must be registered');
  return tool.execute({ action: 'status' }, {});
}

describe('w2m_update tool', () => {
  it('is registered with a description that states what it does not do', async () => {
    const { tools } = await register({ rabbitUrl: 'http://127.0.0.1:1' });
    const tool = tools.get('w2m_update');
    assert.ok(tool, 'w2m_update must be registered');
    assert.equal(typeof tool.execute, 'function');
    assert.ok(tool.description.length > 40);
    // The honest-limits sentence: a reader must not think the running code was replaced.
    assert.match(tool.description, /never restarts/i);
    assert.match(tool.description, /Beijing/);
  });

  it('reports the schedule, the version and the profile on status', async () => {
    const profileDir = makeProfile();
    const { tools } = await register({
      rabbitUrl: 'http://127.0.0.1:1',
      profileDir,
      autoUpdate: true,
      autoUpdateTimes: ['00:00:00', '03:00:00', '05:00:00'],
      autoUpdateTimeZone: 'Asia/Shanghai',
    });

    const out = await updateStatus(tools);
    assert.equal(out.ok, true);
    assert.equal(out.action, 'status');
    const u = out.update;
    assert.equal(u.enabled, true);
    assert.deepEqual(u.schedule.times, ['00:00:00', '03:00:00', '05:00:00']);
    assert.equal(u.schedule.time_zone, 'Asia/Shanghai');
    assert.equal(u.profile_dir, profileDir);
    assert.equal(u.repo, 'TwinsEarth/dsh-windows2macos');
    // The version is a placeholder in a checkout, so assert the field exists and is a string rather
    // than pinning a number that the pack step rewrites.
    assert.equal(typeof u.current_version === 'string' || u.current_version === null, true);
  });

  it('answers status without a Rabbit and without a profile', async () => {
    // Nothing about the updater may require the W2M line protocol: it is this plugin's own
    // maintenance, and a machine with no relay configured still needs to be updatable.
    const { tools } = await register({});
    const out = await updateStatus(tools);
    assert.equal(out.ok, true);
    assert.equal(out.update.profile_dir, null);
    assert.equal(out.update.enabled, false);
    assert.match(out.update.disabled_reason ?? '', /no DSH profile/i);
  });

  it('reports why it is disabled instead of looking merely idle', async () => {
    const { tools } = await register({ rabbitUrl: 'http://127.0.0.1:1' });
    const out = await updateStatus(tools);
    const u = out.update;
    assert.equal(u.enabled, false);
    // A status that just says "enabled: false" leaves the reader unable to tell a deliberate
    // setting from a broken profile lookup.
    assert.ok(u.disabled_reason, 'a disabled updater must explain itself');
    // Defaults to off: an updater that replaces the installed plugin is opt-in.
    assert.match(u.disabled_reason, /profile|disabled/i);
  });

  it('defaults to disabled and schedules nothing', async () => {
    const profileDir = makeProfile();
    const { tools } = await register({ rabbitUrl: 'http://127.0.0.1:1', profileDir });
    const out = await updateStatus(tools);
    assert.equal(out.update.enabled, false);
    assert.equal(out.update.schedule.next_at, null, 'a disabled updater must not arm a timer');
  });
});

describe('findProfileDir (the branch ESLint found, not the tests)', () => {
  /**
   * Build a real installed layout on disk and resolve from inside it.
   *
   * The origin of this test: `resolveProfileDir` used to be a closure inside `apply()`, and it called
   * `existsSync` without importing it. ESM throws `ReferenceError` for an unbound identifier, so the
   * plugin would have failed to load from any mounted profile -- the normal installed layout. It
   * survived a fully green suite because no test ever executed that branch. A test that only checks
   * the return value would repeat the mistake; this one walks a real directory tree.
   *
   * @param {string} rel - Path of the module inside the profile.
   * @returns {{root: string, moduleUrl: string}}
   */
  function installedAt(rel) {
    const root = mkdtempSync(path.join(os.tmpdir(), 'w2m-profile-probe-'));
    cleanup.push(root);
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'dsh-profile-test' }), 'utf8');
    const moduleUrl = pathToFileURL(path.join(root, rel)).href;
    return { root, moduleUrl };
  }

  it('finds the profile root from a plain node_modules layout', () => {
    const { root, moduleUrl } = installedAt(
      path.join('node_modules', '@twinsearth', 'w2m-dsh-plugin', 'src', 'plugin', 'tools.mjs'),
    );
    assert.equal(findProfileDir({ moduleUrl }), root);
  });

  it('finds the root through a pnpm .pnpm segment, which is why it walks instead of slicing', () => {
    // A fixed-depth slice would land on `.pnpm` here and return a path that is not a profile.
    const { root, moduleUrl } = installedAt(
      path.join('node_modules', '.pnpm', '@twinsearth+w2m-dsh-plugin@0.3.0', 'node_modules', '@twinsearth', 'w2m-dsh-plugin', 'lib', 'tools.js'),
    );
    assert.equal(findProfileDir({ moduleUrl }), root);
  });

  it('returns null when there is no profile above the module', () => {
    // A checkout run from a clone: no enclosing package root, so self-update is unavailable and the
    // caller must say so rather than invent a target.
    const { moduleUrl } = installedAt(path.join('src', 'plugin', 'tools.mjs'));
    assert.equal(findProfileDir({ moduleUrl }), null);
  });

  it('requires the root to look like a package, not just any node_modules parent', () => {
    // `node_modules` alone is not evidence of a profile; without a package.json the walk keeps going.
    const root = mkdtempSync(path.join(os.tmpdir(), 'w2m-no-manifest-'));
    cleanup.push(root);
    const moduleUrl = pathToFileURL(
      path.join(root, 'node_modules', '@twinsearth', 'w2m-dsh-plugin', 'src', 'plugin', 'tools.mjs'),
    ).href;
    assert.equal(findProfileDir({ moduleUrl }), null);
  });

  it('prefers an explicitly configured profileDir', () => {
    const explicit = mkdtempSync(path.join(os.tmpdir(), 'w2m-explicit-'));
    cleanup.push(explicit);
    const { moduleUrl } = installedAt(path.join('node_modules', 'x', 'y.mjs'));
    assert.equal(findProfileDir({ explicit, moduleUrl }), explicit);
  });

  it('survives unusable input instead of throwing at load time', () => {
    // This runs while the plugin is being constructed, so a throw here takes the whole tool set down.
    for (const input of [{}, { moduleUrl: '' }, { moduleUrl: 'not a url' }, { explicit: '   ', moduleUrl: null }]) {
      assert.equal(findProfileDir(input), null, JSON.stringify(input));
    }
  });

  it('the plugin actually loads from a mounted profile layout', async () => {
    // The end-to-end version of the same property: `apply()` resolves the profile as part of
    // building its config, so a broken walk fails the load, not just the updater.
    const profileDir = mkdtempSync(path.join(os.tmpdir(), 'w2m-mounted-'));
    cleanup.push(profileDir);
    writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-mounted' }), 'utf8');
    const made = await register({ rabbitUrl: 'http://127.0.0.1:1', profileDir });
    const out = await updateStatus(made.tools);
    assert.equal(out.update.profile_dir, profileDir);
    assert.equal(made.tools.size, 8);
  });
});

describe('config validation is loud, not silently defaulted', () => {
  it('names autoUpdateTimes when a slot is malformed', async () => {
    // A silently-substituted default would move the check to an hour nobody chose, and nothing
    // would ever say so -- the exact class of silent failure this project keeps having to fix.
    for (const bad of [['3:00:00'], ['25:00:00'], ['00:60:00'], ['nope'], [''], ['00:00:00', '99:00:00']]) {
      await assert.rejects(
        () => register({ rabbitUrl: 'http://127.0.0.1:1', autoUpdate: true, autoUpdateTimes: bad }),
        (err) => {
          assert.match(String(err.message), /autoUpdateTimes/, `bad=${JSON.stringify(bad)}`);
          return true;
        },
      );
    }
  });

  it('accepts a well-formed override and dedupes it', async () => {
    const profileDir = makeProfile();
    const { tools } = await register({
      rabbitUrl: 'http://127.0.0.1:1',
      profileDir,
      autoUpdate: true,
      autoUpdateTimes: ['05:00:00', '00:00:00', '05:00:00'],
    });
    const out = await updateStatus(tools);
    assert.deepEqual(out.update.schedule.times, ['00:00:00', '05:00:00']);
  });

  it('names autoUpdateTimeZone for an unknown zone', async () => {
    await assert.rejects(
      () => register({ rabbitUrl: 'http://127.0.0.1:1', autoUpdate: true, autoUpdateTimeZone: 'Not/AZone' }),
      (err) => {
        assert.match(String(err.message), /autoUpdateTimeZone/);
        return true;
      },
    );
  });

  it('names updateRepo when it is not owner/name', async () => {
    for (const bad of ['not-a-repo', 'a/b/c', '', '   ']) {
      if (bad.trim() === '') continue; // an empty string falls back to the default on purpose
      await assert.rejects(
        () => register({ rabbitUrl: 'http://127.0.0.1:1', autoUpdate: true, updateRepo: bad }),
        (err) => {
          assert.match(String(err.message), /updateRepo/);
          return true;
        },
      );
    }
  });

  it('applies documented defaults when nothing is configured', async () => {
    const profileDir = makeProfile();
    const { tools } = await register({ rabbitUrl: 'http://127.0.0.1:1', profileDir, autoUpdate: true });
    const u = (await updateStatus(tools)).update;
    assert.deepEqual(u.schedule.times, ['00:00:00', '03:00:00', '05:00:00']);
    assert.equal(u.schedule.time_zone, 'Asia/Shanghai');
    assert.equal(u.dry_run, false);
    assert.equal(u.allow_prerelease, false);
  });
});

describe('w2m_history and w2m_stats (v0.3.0)', () => {
  /** Register against a routing fetch stub and hand back the calls it made. */
  function withRelay(routes) {
    const calls = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const path = String(url).replace(/^https?:\/\/[^/]+/, '');
      calls.push({ path });
      const route = routes.find((r) => path === r.path || path.startsWith(`${r.path}?`));
      if (!route) {
        const body = JSON.stringify({ error: { code: 'NOT_FOUND' } });
        return {
          ok: false,
          status: 404,
          json: async () => JSON.parse(body),
          text: async () => body,
          // The plugin reads the raw bytes first, because a signed request's body must not be
          // re-serialised. A stub that only offers json()/text() fails there, not in the assertion.
          arrayBuffer: async () => new TextEncoder().encode(body).buffer,
        };
      }
      const body = JSON.stringify(route.body);
      return {
        ok: route.status === undefined || route.status < 400,
        status: route.status ?? 200,
        json: async () => route.body,
        text: async () => body,
        arrayBuffer: async () => new TextEncoder().encode(body).buffer,
      };
    };
    return { calls, restore: () => { globalThis.fetch = original; } };
  }

  const TASKS = {
    protocol_version: 1,
    rabbit_time: '2026-10-08T00:00:00Z',
    tasks: [
      { task_id: 'T2', mode: 'split', created_at: '2026-10-08T00:00:02Z', created_by: 'op', index_total: 4, cancelled: false, degraded: null, leases: ['m1', 'm2'], lease_states: { m1: 'done', m2: 'done' } },
      { task_id: 'T1', mode: 'replicate', created_at: '2026-10-08T00:00:01Z', created_by: 'op', index_total: 1, cancelled: true, degraded: null, leases: ['m1'], lease_states: { m1: 'cancelled' } },
    ],
  };

  it('lists recent tasks in the order the relay gave, without fetching any result', async () => {
    const profileDir = makeProfile();
    const { tools } = await register({ rabbitUrl: 'http://relay.test', profileDir, operatorToken: 'op' });
    const stub = withRelay([{ path: '/v1/tasks', body: TASKS }]);
    try {
      const out = JSON.parse(await tools.get('w2m_history').execute({}, {}));
      assert.equal(out.ok, true);
      assert.equal(out.returned, 2);
      assert.equal(out.held, 2);
      assert.deepEqual(out.tasks.map((t) => t.task_id), ['T2', 'T1']);
      assert.deepEqual(stub.calls.map((c) => c.path), ['/v1/tasks?limit=20']);
    } finally {
      stub.restore();
    }
  });

  it('filters by mode, and says when a filter hid everything', async () => {
    const profileDir = makeProfile();
    const { tools } = await register({ rabbitUrl: 'http://relay.test', profileDir, operatorToken: 'op' });
    const stub = withRelay([{ path: '/v1/tasks', body: TASKS }]);
    try {
      const one = JSON.parse(await tools.get('w2m_history').execute({ mode: 'replicate' }, {}));
      assert.equal(one.returned, 1);
      assert.equal(one.held, 2, 'the number the relay holds is reported separately');

      const none = JSON.parse(await tools.get('w2m_history').execute({ mode: 'pipeline' }, {}));
      assert.equal(none.returned, 0);
      assert.equal(none.held, 2);
      // An empty result must not be indistinguishable from an empty relay.
      assert.match(none.notes.join(' '), /filtered out/);
    } finally {
      stub.restore();
    }
  });

  it('excludes cancelled tasks only when asked to', async () => {
    const profileDir = makeProfile();
    const { tools } = await register({ rabbitUrl: 'http://relay.test', profileDir, operatorToken: 'op' });
    const stub = withRelay([{ path: '/v1/tasks', body: TASKS }]);
    try {
      assert.equal(JSON.parse(await tools.get('w2m_history').execute({}, {})).returned, 2);
      assert.equal(JSON.parse(await tools.get('w2m_history').execute({ include_cancelled: false }, {})).returned, 1);
    } finally {
      stub.restore();
    }
  });

  it('clamps a huge limit instead of asking the relay for it', async () => {
    const profileDir = makeProfile();
    const { tools } = await register({ rabbitUrl: 'http://relay.test', profileDir, operatorToken: 'op' });
    const stub = withRelay([{ path: '/v1/tasks', body: TASKS }]);
    try {
      await tools.get('w2m_history').execute({ limit: 1_000_000 }, {});
      assert.equal(stub.calls[0].path, '/v1/tasks?limit=200', 'the local cap must win');
    } finally {
      stub.restore();
    }
  });

  it('summarises the fleet even when per-machine detail is unavailable', async () => {
    const profileDir = makeProfile();
    const { tools } = await register({ rabbitUrl: 'http://relay.test', profileDir });
    const stub = withRelay([
      { path: '/healthz', body: { protocol_version: 1, rabbit_time: 'now', relay_id: 'r1', uptime_ms: 1000, devices: 2, tasks: 5, results: 4, rtt: { machines_reporting: 1, min_ms: 40, max_ms: 40, avg_ms: 40, machines_stale: 0, machines_unknown: 1 } } },
      { path: '/v1/devices', status: 401, body: { error: { code: 'UNAUTHORIZED' } } },
    ]);
    try {
      const out = JSON.parse(await tools.get('w2m_stats').execute({}, {}));
      assert.equal(out.ok, true);
      assert.equal(out.counts.devices, 2);
      assert.equal(out.counts.tasks, 5);
      assert.equal(out.rtt.avg_ms, 40);
      assert.equal(out.machines, null, 'the per-machine half is dropped rather than failing the summary');
      assert.match(out.notes.join(' '), /per-machine detail is unavailable/);
    } finally {
      stub.restore();
    }
  });

  it('reports an unreported RTT as null, never as zero', async () => {
    const profileDir = makeProfile();
    const { tools } = await register({ rabbitUrl: 'http://relay.test', profileDir });
    const stub = withRelay([{ path: '/healthz', body: { protocol_version: 1, devices: 1, tasks: 0, results: 0 } }]);
    try {
      const out = JSON.parse(await tools.get('w2m_stats').execute({}, {}));
      // 0ms means "instantaneous"; a relay that does not report it means "unknown". Conflating the
      // two is how a dead fleet reads as a healthy one.
      assert.equal(out.rtt, null);
      assert.equal(out.relay.relay_id, null);
    } finally {
      stub.restore();
    }
  });
});

describe('shared config reaches the wire (v0.3.3)', () => {
  /** A fetch stub that records the request bodies it was given. */
  function withRelay(body = { task_id: 'T1', seq: 1, leases: [] }) {
    const calls = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      const path = String(url).replace(/^https?:\/\/[^/]+/, '');
      calls.push({ path, body: init.body === undefined ? null : JSON.parse(String(init.body)) });
      const text = JSON.stringify(body);
      return {
        ok: true,
        status: 200,
        json: async () => JSON.parse(text),
        text: async () => text,
        arrayBuffer: async () => new TextEncoder().encode(text).buffer,
      };
    };
    return { calls, restore: () => { globalThis.fetch = original; } };
  }

  /** A project directory containing a `.w2m.json`. */
  function projectWith(sharedDoc) {
    const dir = makeProfile();
    if (sharedDoc !== null) {
      writeFileSync(path.join(dir, '.w2m.json'), typeof sharedDoc === 'string' ? sharedDoc : JSON.stringify(sharedDoc), 'utf8');
    }
    return dir;
  }

  it('sends the timeout from the shared config instead of the built-in default', async () => {
    const projectDir = projectWith({ defaultTimeoutMs: 12345 });
    const { tools } = await register({ rabbitUrl: 'http://relay.test', projectDir, operatorToken: 'op' }, { withEffect: false });
    const stub = withRelay();
    try {
      await tools.get('w2m_run').execute({ command_argv: ['node', '--test'] }, {});
      const sent = stub.calls.find((c) => c.path === '/v1/task');
      assert.ok(sent, 'the run must reach POST /v1/task');
      // The assertion that matters: the body, not the config object. A loader that parses but is never
      // consulted would pass every other test in the suite.
      assert.equal(sent.body.timeout_ms, 12345);
    } finally {
      stub.restore();
    }
  });

  it('lets an explicit per-call timeout win over the shared config', async () => {
    const projectDir = projectWith({ defaultTimeoutMs: 12345 });
    const { tools } = await register({ rabbitUrl: 'http://relay.test', projectDir, operatorToken: 'op' }, { withEffect: false });
    const stub = withRelay();
    try {
      await tools.get('w2m_run').execute({ command_argv: ['node', '--test'], timeout_ms: 999 }, {});
      assert.equal(stub.calls.find((c) => c.path === '/v1/task').body.timeout_ms, 999);
    } finally {
      stub.restore();
    }
  });

  it('refuses to start on an unparsable shared config rather than running on defaults', async () => {
    // Running with defaults while the operator believes their settings apply is the silently-wrong
    // outcome; a fleet whose allow-list silently reverted to empty is the specific danger.
    const projectDir = projectWith('{ not json');
    await assert.rejects(
      () => register({ rabbitUrl: 'http://relay.test', projectDir, operatorToken: 'op' }, { withEffect: false }),
      (err) => err.code === 'W2M_CONFIG_UNPARSABLE',
    );
  });

  it('refuses a shared config that tries to carry a credential', async () => {
    const projectDir = projectWith({ operatorToken: 'oops' });
    await assert.rejects(
      () => register({ rabbitUrl: 'http://relay.test', projectDir, operatorToken: 'op' }, { withEffect: false }),
      (err) => err.code === 'W2M_CONFIG_SECRET_REFUSED',
    );
  });

  it('reports the source of every shared value through w2m_status', async () => {
    // The layered-config failure is "the value is in the file I edited and something else wins". The
    // answer has to be readable from one call.
    const projectDir = projectWith({ defaultTimeoutMs: 4242 });
    const { tools } = await register({ rabbitUrl: 'http://relay.test', projectDir, operatorToken: 'op' }, { withEffect: false });
    const stub = withRelay({
      protocol_version: 1,
      ok: true,
      devices: 1,
    });
    try {
      const out = JSON.parse(await tools.get('w2m_status').execute({}, {}));
      assert.ok(out.shared_config, 'w2m_status must report the shared config');
      assert.equal(out.shared_config.sources.defaultTimeoutMs, 'shared');
      assert.equal(out.shared_config.values.defaultTimeoutMs, 4242);
      assert.match(out.shared_config.summary, /defaultTimeoutMs = 4242\s+\[shared\]/);
    } finally {
      stub.restore();
    }
  });

  it('reports defaults as defaults when no file exists', async () => {
    const projectDir = projectWith(null);
    const { tools } = await register({ rabbitUrl: 'http://relay.test', projectDir, operatorToken: 'op' }, { withEffect: false });
    const stub = withRelay({ protocol_version: 1, ok: true, devices: 0 });
    try {
      const out = JSON.parse(await tools.get('w2m_status').execute({}, {}));
      assert.equal(out.shared_config.sources.defaultTimeoutMs, 'default');
      assert.equal(out.shared_config.values.defaultTimeoutMs, 300000);
    } finally {
      stub.restore();
    }
  });
});

describe('the scheduled job is owned by ctx.effect', () => {
  it('registers exactly one effect when enabled, and arms one unref\u2019d timer', async () => {
    const profileDir = makeProfile();
    const made = await register({ rabbitUrl: 'http://127.0.0.1:1', profileDir, autoUpdate: true });
    assert.equal(made.effects.length, 1, 'one effect owns the daily job');
    assert.equal(typeof made.effects[0], 'function', 'the effect must return a disposer');
    assert.equal((await updateStatus(made.tools)).update.schedule.started, true);
  });

  it('the disposer stops the schedule, so nothing survives an unload', async () => {
    const profileDir = makeProfile();
    const made = await register({ rabbitUrl: 'http://127.0.0.1:1', profileDir, autoUpdate: true });
    const before = (await updateStatus(made.tools)).update.schedule;
    assert.equal(before.stopped, false);

    // This is the property `ctx.effect` exists to provide: invoking the disposer must leave no
    // timer behind. A leaked daily job would keep calling GitHub after the plugin is gone.
    made.disposers[0]();
    const afterStop = (await updateStatus(made.tools)).update.schedule;
    assert.equal(afterStop.stopped, true);
  });

  it('does not require ctx.effect when the feature is off', async () => {
    // A host without `ctx.effect` must still be able to run the W2M tools.
    const { tools } = await register({ rabbitUrl: 'http://127.0.0.1:1' }, { withEffect: false });
    assert.equal(tools.size, 8);
    assert.equal((await updateStatus(tools)).update.enabled, false);
  });

  it('fails loudly when enabled on a host that cannot track the effect', async () => {
    // Silently continuing would arm a timer nothing can release.
    await assert.rejects(
      () => register({ rabbitUrl: 'http://127.0.0.1:1', autoUpdate: true }, { withEffect: false }),
      (err) => {
        assert.match(String(err.message), /ctx\.effect/);
        assert.equal(err.code, 'W2M_NO_EFFECT');
        return true;
      },
    );
  });

  it('surfaces a throwing effect instead of pretending the job is scheduled', async () => {
    await assert.rejects(
      () => register({ rabbitUrl: 'http://127.0.0.1:1', autoUpdate: true }, { effectThrows: true }),
      /host refused the effect/,
    );
  });
});


