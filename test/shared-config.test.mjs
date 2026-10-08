/**
 * Shared fleet configuration (v0.3.3).
 *
 * The tests are organised around the four ways a config system fails its user, not around the happy
 * path:
 *
 *   1. **A secret in a committed file.** The operator believes a token is in effect; it is in git
 *      history forever. Refused, not ignored -- and the test asserts the refusal *names the key*, so
 *      the operator can find it.
 *   2. **A typo'd key.** Silently dropped keys are indistinguishable from settings that work, which is
 *      the worse failure. The test asserts `alowedCommands` is refused rather than ignored.
 *   3. **A setting that is present but overridden.** Every layered config system has this failure; the
 *      answer must be readable, so `describe()` reports the source of each effective value.
 *   4. **Absence vs breakage.** No file is the normal case and must yield defaults; a file that exists
 *      and is wrong must be a loud error. Treating an unparsable file as empty would run the fleet on
 *      defaults while the operator believes their settings apply.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';

import {
  SHARED_CONFIG_DEFAULTS,
  SHARED_CONFIG_NAME,
  MACHINE_CONFIG_NAME,
  loadSharedConfig,
  parseSharedConfig,
  describeSharedConfig,
} from '../src/plugin/shared-config.mjs';

/** A filesystem stub: only the paths in `files` exist. */
function fakeFs(files) {
  return {
    exists: (p) => Object.prototype.hasOwnProperty.call(files, p),
    read: (p) => {
      if (!Object.prototype.hasOwnProperty.call(files, p)) throw new Error(`ENOENT: ${p}`);
      return files[p];
    },
  };
}

/** Load with the given shared file contents (or none). */
function load({ shared, machine, explicit } = {}) {
  const files = {};
  // Built with `path.join`/`resolve` rather than string literals so the stub keys match what the
  // loader actually asks for on this platform. Hardcoding `/proj/.w2m.json` worked on POSIX and
  // silently missed on Windows, where the loader resolves backslashes.
  const sharedPath = resolve(join('/proj', SHARED_CONFIG_NAME));
  const machinePath = resolve(join('/home/u/.w2m', MACHINE_CONFIG_NAME));
  if (shared !== undefined) files[sharedPath] = shared;
  if (machine !== undefined) files[machinePath] = machine;
  const fs = fakeFs(files);
  return loadSharedConfig({ projectDir: '/proj', machineDir: '/home/u/.w2m', exists: fs.exists, read: fs.read, explicit });
}

describe('shared config: absence is normal, breakage is not', () => {
  it('yields the documented defaults when no file exists anywhere', () => {
    const loaded = load();
    assert.deepEqual(loaded.values.allowedCommands, []);
    assert.equal(loaded.values.defaultTimeoutMs, SHARED_CONFIG_DEFAULTS.defaultTimeoutMs);
    for (const key of Object.keys(SHARED_CONFIG_DEFAULTS)) {
      assert.equal(loaded.sources[key], 'default', `${key} should be reported as a default`);
    }
  });

  it('reads the committed file and records its path', () => {
    const loaded = load({ shared: JSON.stringify({ defaultTimeoutMs: 1000 }) });
    assert.equal(loaded.values.defaultTimeoutMs, 1000);
    assert.equal(loaded.sources.defaultTimeoutMs, 'shared');
    assert.match(loaded.files.shared, /\.w2m\.json$/);
  });

  it('throws on an unparsable file rather than falling back to defaults', () => {
    // The whole point: defaults while the operator believes their settings are active is a
    // silently-wrong fleet, which is worse than a refusal to start.
    assert.throws(
      () => load({ shared: '{ this is not json' }),
      (err) => err.code === 'W2M_CONFIG_UNPARSABLE' && /not valid JSON/.test(err.message),
    );
  });

  it('refuses a non-object document', () => {
    for (const doc of ['[]', '"a string"', 'null', '42']) {
      assert.throws(
        () => load({ shared: doc }),
        (err) => err.code === 'W2M_CONFIG_NOT_AN_OBJECT',
        `expected a refusal for ${doc}`,
      );
    }
  });
});

describe('shared config: secrets are refused, not ignored', () => {
  it('refuses every obvious spelling of a credential and names the key', () => {
    const spellings = [
      'operator_token',
      'operatorToken',
      'signing_secret',
      'signingSecret',
      'device_token',
      'password',
      'apiKey',
      'api_key',
      'credentials',
    ];
    for (const key of spellings) {
      const result = parseSharedConfig(JSON.stringify({ [key]: 'value' }), '.w2m.json');
      assert.equal(result.ok, false, `${key} must be refused`);
      assert.equal(result.code, 'W2M_CONFIG_SECRET_REFUSED', `${key} should be a secret refusal`);
      assert.equal(result.key, key, 'the refusal must name the key so it can be found');
      assert.match(result.error, /committed/, 'the reason must say why');
    }
  });

  it('does not refuse benign keys that merely contain similar letters', () => {
    // A blanket substring test would be easier and would eventually reject a legitimate key; this
    // pins the ones that must keep working.
    const ok = parseSharedConfig(JSON.stringify({ allowedCommands: ['node'], maxOutputBytes: 1024 }), '.w2m.json');
    assert.equal(ok.ok, true, ok.ok ? '' : ok.error);
  });

  it('refuses a secret even when it sits beside valid keys', () => {
    // Order matters: a parser that applies valid keys and then stops at the secret would leave the
    // caller with a half-applied config.
    assert.throws(
      () => load({ shared: JSON.stringify({ defaultTimeoutMs: 1000, operatorToken: 'x' }) }),
      (err) => err.code === 'W2M_CONFIG_SECRET_REFUSED' && err.key === 'operatorToken',
    );
  });
});

describe('shared config: a typo is refused, not dropped', () => {
  it('refuses an unknown key and lists the known ones', () => {
    const result = parseSharedConfig(JSON.stringify({ alowedCommands: ['node'] }), '.w2m.json');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'W2M_CONFIG_UNKNOWN_KEY');
    assert.equal(result.key, 'alowedCommands');
    assert.match(result.error, /allowedCommands/, 'the message must list the real key so it can be fixed');
  });

  it('refuses a bad value with a message naming the key and the expectation', () => {
    const cases = [
      [{ allowedCommands: 'node' }, /array of strings/],
      [{ allowedCommands: [1, 2] }, /array of strings/],
      [{ defaultTimeoutMs: 0 }, /between 1 and 86400000/],
      [{ defaultTimeoutMs: -5 }, /between 1 and 86400000/],
      [{ updateTimes: ['3:00'] }, /time of day/],
      [{ updateTimes: [null] }, /time of day/],
      // Right shape, impossible clock. A digit-count check would accept this.
      [{ updateTimes: ['99:99'] }, /time of day/],
      [{ updateTimeZone: 'Mars/Olympus' }, /not a time zone/],
      [{ maxOutputBytes: -1 }, /positive integer/],
    ];
    for (const [doc, pattern] of cases) {
      const result = parseSharedConfig(JSON.stringify(doc), '.w2m.json');
      assert.equal(result.ok, false, `${JSON.stringify(doc)} must be refused`);
      assert.equal(result.code, 'W2M_CONFIG_BAD_VALUE');
      assert.match(result.error, pattern, `message for ${JSON.stringify(doc)}`);
    }
  });

  it('accepts a real IANA zone and normalizes HH:MM to HH:MM:SS', () => {
    const result = parseSharedConfig(JSON.stringify({ updateTimeZone: 'Europe/London', updateTimes: ['07:30'] }), '.w2m.json');
    assert.equal(result.ok, true, result.ok ? '' : result.error);
    // The scheduler takes HH:MM:SS, so a caller that wrote HH:MM must not have to know that.
    assert.deepEqual(result.values.updateTimes, ['07:30:00']);
  });
});

describe('shared config: layering is explicit and readable', () => {
  it('lets the machine file override the shared file key by key', () => {
    const loaded = load({
      shared: JSON.stringify({ defaultTimeoutMs: 1000, updateTimeZone: 'UTC' }),
      machine: JSON.stringify({ defaultTimeoutMs: 2000 }),
    });
    assert.equal(loaded.values.defaultTimeoutMs, 2000, 'machine overrides shared');
    assert.equal(loaded.sources.defaultTimeoutMs, 'machine');
    // A key the machine file does not mention keeps coming from the shared file, not from a default.
    assert.equal(loaded.values.updateTimeZone, 'UTC');
    assert.equal(loaded.sources.updateTimeZone, 'shared');
  });

  it('lets the host config override both files', () => {
    const loaded = load({
      shared: JSON.stringify({ defaultTimeoutMs: 1000 }),
      explicit: { defaultTimeoutMs: 3000 },
    });
    assert.equal(loaded.values.defaultTimeoutMs, 3000);
    assert.equal(loaded.sources.defaultTimeoutMs, 'explicit');
  });

  it('reports the source of every value, so an overridden setting is visible', () => {
    // This is the failure mode of every layered config system: the value is present in the file the
    // operator edited, and something else wins. Reading the answer must not require experimentation.
    const loaded = load({
      shared: JSON.stringify({ defaultTimeoutMs: 1000, allowedCommands: ['node'] }),
      machine: JSON.stringify({ allowedCommands: ['node', 'git'] }),
    });
    const text = describeSharedConfig(loaded);
    assert.match(text, /defaultTimeoutMs = 1000\s+\[shared\]/);
    assert.match(text, /allowedCommands = \["node","git"\]\s+\[machine\]/);
    assert.match(text, /w2m\.json/);
  });

  it('does not let an unrelated host setting appear to come from the shared file', () => {
    const loaded = load({ explicit: { rabbitUrl: 'http://x', somethingElse: 1 } });
    assert.equal(Object.prototype.hasOwnProperty.call(loaded.values, 'rabbitUrl'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(loaded.values, 'somethingElse'), false);
  });

  it('refuses a bad value from the host layer too, with the same rigour as the file', () => {
    assert.throws(
      () => load({ explicit: { defaultTimeoutMs: 'soon' } }),
      (err) => err.code === 'W2M_CONFIG_BAD_VALUE' && err.key === 'defaultTimeoutMs',
    );
  });

  it('copies array values instead of sharing them with the caller', () => {
    // A shared mutable default would let one caller's edit change another's view of the config --
    // which in a long-lived plugin process means one tool's write silently reconfigures the next.
    const first = load();
    first.values.allowedCommands.push('mutated');
    assert.deepEqual(load().values.allowedCommands, []);
    assert.deepEqual(SHARED_CONFIG_DEFAULTS.allowedCommands, []);
  });
});
