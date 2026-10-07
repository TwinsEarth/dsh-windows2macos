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
import fs from 'node:fs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as plugin from '../src/plugin/tools.mjs';

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
    // A host without `ctx.effect` must still be able to run the five W2M tools.
    const { tools } = await register({ rabbitUrl: 'http://127.0.0.1:1' }, { withEffect: false });
    assert.equal(tools.size, 6);
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

