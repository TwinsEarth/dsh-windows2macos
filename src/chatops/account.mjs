/**
 * Account identity, the serial number, and the hardware fingerprint (v0.7.5).
 *
 * ## What this is
 *
 * Stage 1 of `docs/ACCOUNT-FLEET-DESIGN.md`: the root of the whole scheme. Everything later —
 * the device keypair, the relay's authorisation model, the fleet-scoped dispatch — depends on
 * knowing *which account* a machine belongs to and *which machine* it is. Neither existed before
 * this file: `machine_id` was a bare `randomUUID()` with no account and no hardware in it.
 *
 * ## The identity source is read, not fetched
 *
 * The account code comes from `ctx.deepseekAccount.getDeviceIdentity()`, whose contract is
 * *"read existing login identity without creating a device or returning credentials"*. It
 * returns `{ deviceId?, userId?, osVersion }`, and `userId` is the account's unique identifier.
 *
 * So there is **no account API call here**, and there is deliberately **no way to set the account
 * code from configuration**. That second point is not a limitation to work around: a value an
 * operator can type is a value an attacker can type, so a hand-entered "account code" would be a
 * forgeable account code. The only accepted source is the one the host authenticates.
 *
 * ## Three things this file refuses to pretend
 *
 * **1. The serial number is not a credential.** It is computed from local inputs, so anyone who
 * knows or guesses an account id can produce a well-formed one. It exists to be **displayed** and
 * to be **grouped by prefix**, and the relay must never trust it. `isWellFormedSn` validates
 * *shape*, and its name says shape — it is not and must not be called an authorisation check.
 *
 * **2. The timestamp is not what makes an SN unique.** Uniqueness is `(ACCT, HWID)`. The timestamp
 * distinguishes a re-registration of the same hardware from a second machine, and makes the string
 * auditable. Calling it a security feature would be an overclaim.
 *
 * **3. A fingerprint that changes is worse than none.** It makes one machine look like two, which
 * fragments a fleet. So sources that change in normal use — MAC addresses, IPs, mount points,
 * installed-package lists — are **excluded on purpose**, and each exclusion is a choice with a
 * reason rather than an omission.
 */

import { createHash } from 'node:crypto';
// v0.8.1: the account-derived fleet key, so a machine joins its account's fleet with no human step.
import { deriveAccountFleetKey, encodeFleetKey } from './fleet-join.mjs';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** SN shape. `W2M-` then three dash-separated hex groups of 8, 12 and 14 characters. */
export const SN_PATTERN = /^W2M-([0-9a-f]{8})-([0-9a-f]{12})-(\d{14})$/;

/** How much of a hash goes into the account code. 8 hex = 32 bits. See the collision note below. */
export const ACCT_HEX = 8;
/** How much goes into the hardware code. 12 hex = 48 bits. */
export const HWID_HEX = 12;

/**
 * Derive the account code.
 *
 * **Hashed, not raw.** The `userId` is an account identifier, and this code ends up in places a
 * login identifier should not: device lists, log lines, chat messages, `w2m_devices` output.
 * Taking a truncated hash keeps the one property grouping needs — the same account hashes the
 * same way on every machine — without shipping the identifier itself around.
 *
 * **The cost of 32 bits, stated rather than hidden.** Two different accounts colliding would
 * merge two fleets. That needs roughly 2^16 distinct accounts on one relay before it is likely,
 * which is far beyond any real deployment; the design document records the detection step for the
 * case where it is not.
 */
export function accountCode(userId) {
  if (typeof userId !== 'string' || userId.trim() === '') return null;
  return createHash('sha256').update(userId.trim(), 'utf8').digest('hex').slice(0, ACCT_HEX);
}

/**
 * Hash a fingerprint string into the hardware code.
 *
 * Normalised first — trimmed, lower-cased, and with runs of whitespace collapsed — because the
 * same machine reports the same value with different spacing depending on the tool that read it,
 * and a fingerprint that changes with its reader is a fingerprint that changes.
 */
export function hardwareCode(...parts) {
  const material = parts
    .filter((p) => typeof p === 'string' && p.trim() !== '')
    .map((p) => p.trim().toLowerCase().replace(/\s+/g, ' '))
    .join('\n');
  if (material === '') return null;
  return createHash('sha256').update(material, 'utf8').digest('hex').slice(0, HWID_HEX);
}

/** `YYYYMMDDhhmmss`, UTC. */
export function timeCode(when = new Date()) {
  const d = when instanceof Date ? when : new Date(when);
  if (Number.isNaN(d.getTime())) throw new TypeError('timeCode needs a valid date');
  const p = (n, width = 2) => String(n).padStart(width, '0');
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
  );
}

/**
 * Build the serial number.
 *
 * `W2M-<ACCT>-<HWID>-<TS>`. Refuses to produce a partial one: an SN missing its account code
 * would be a machine that claims no fleet, and silently emitting that is how a machine ends up
 * in the wrong pool.
 */
export function buildSn({ accountCode: acct, hardwareCode: hwid, at = new Date() } = {}) {
  if (typeof acct !== 'string' || !/^[0-9a-f]{8}$/.test(acct)) {
    throw new TypeError('buildSn needs an 8-hex account code; without one a machine claims no fleet');
  }
  if (typeof hwid !== 'string' || !/^[0-9a-f]{12}$/.test(hwid)) {
    throw new TypeError('buildSn needs a 12-hex hardware code');
  }
  return `W2M-${acct}-${hwid}-${timeCode(at)}`;
}

/**
 * Does this string have the shape of an SN?
 *
 * **Shape, not authorisation.** The name is deliberate: this answers "is it well formed", and a
 * caller that treats a `true` here as proof of anything is misusing it. Nothing about an SN is
 * verifiable by inspection, because it was computed by the party being checked.
 */
export function isWellFormedSn(value) {
  return typeof value === 'string' && SN_PATTERN.test(value);
}

/** The parts of an SN, or null if it is not well formed. */
export function parseSn(value) {
  const m = typeof value === 'string' ? SN_PATTERN.exec(value) : null;
  if (m === null) return null;
  return { accountCode: m[1], hardwareCode: m[2], timeCode: m[3] };
}

/** The account prefix an SN belongs to, for grouping. Null when the SN is malformed. */
export function fleetOf(value) {
  const parts = parseSn(value);
  return parts === null ? null : parts.accountCode;
}

/**
 * Hardware sources, per platform, in priority order.
 *
 * Each entry says how to read a stable machine identity. `key` names the field in the returned
 * diagnostic so an operator can see *which* source was used — a fingerprint whose origin is
 * unknown is one nobody can debug when it changes unexpectedly.
 *
 * **What is deliberately absent, and why:**
 *   * **MAC addresses / IPs** — change with a cable, a dock, a VPN, or a Wi-Fi toggle. A machine
 *     that re-fingerprints after a network change becomes a second device in the fleet.
 *   * **Mount points / partition layout** — change when a disk is added or a volume is resized.
 *   * **Installed packages / versions** — change on every update, so the fingerprint would churn.
 *   * **Hostname alone** — user-editable in one command on every platform.
 */
export const HW_SOURCES = Object.freeze({
  win32: Object.freeze([
    Object.freeze({ key: 'MachineGuid', kind: 'registry', path: 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', name: 'MachineGuid' }),
    Object.freeze({ key: 'SMBIOS-UUID', kind: 'exec', file: 'powershell', args: Object.freeze(['-NoProfile', '-Command', '(Get-CimInstance Win32_ComputerSystemProduct).UUID']) }),
  ]),
  darwin: Object.freeze([
    Object.freeze({ key: 'IOPlatformUUID', kind: 'exec', file: 'ioreg', args: Object.freeze(['-rd1', '-c', 'IOPlatformExpertDevice']), extract: /"IOPlatformUUID"\s*=\s*"([^"]+)"/ }),
  ]),
  linux: Object.freeze([
    Object.freeze({ key: 'machine-id', kind: 'file', path: '/etc/machine-id' }),
    Object.freeze({ key: 'dbus-machine-id', kind: 'file', path: '/var/lib/dbus/machine-id' }),
  ]),
});

/**
 * Values that mean "this source gave nothing useful".
 *
 * A machine with no SMBIOS UUID reports all-zeroes or a placeholder depending on firmware, and
 * hashing that would give **every such machine the same hardware code** — a far worse failure
 * than having none, because it silently merges distinct machines.
 */
const USELESS = new Set([
  '',
  '0',
  'none',
  'null',
  'undefined',
  '00000000-0000-0000-0000-000000000000',
  'ffffffff-ffff-ffff-ffff-ffffffffffff',
  '03000200-0400-0500-0006-000700080009',
  'to be filled by o.e.m.',
  'default string',
  'system serial number',
]);

/** Is this a value worth hashing? */
export function isUsefulHardwareValue(value) {
  if (typeof value !== 'string') return false;
  const v = value.trim().toLowerCase();
  return v !== '' && !USELESS.has(v);
}

/**
 * Read the raw hardware values, in priority order, and report which were usable.
 *
 * Everything is injectable so a test can drive a Windows-shaped machine on Linux, or a Darwin
 * fixture in CI, without the host having that platform's tools — the alternative is a suite that
 * only exercises whichever platform it happens to run on.
 *
 * @param {object} [options]
 * @param {string} [options.platform]
 * @param {(spec: object) => Promise<string|null>} [options.read] Default reader; override wholly in tests.
 * @param {(file: string, args: string[]) => Promise<string>} [options.exec]
 * @param {(path: string) => Promise<string>} [options.readFile]
 * @param {(event: string, detail?: object) => void} [options.audit]
 */
export async function readHardwareValues(options = {}) {
  const platform = options.platform ?? process.platform;
  const sources = HW_SOURCES[platform] ?? [];
  const execImpl = options.exec ?? (async (file, args) => {
    const { stdout } = await run(file, args, { windowsHide: true, timeout: 5000 });
    return stdout;
  });
  const readFileImpl = options.readFile ?? ((path) => readFile(path, 'utf8'));
  const audit = options.audit ?? (() => {});

  const readOne = options.read ?? (async (spec) => {
    if (spec.kind === 'file') return readFileImpl(spec.path);
    if (spec.kind === 'exec') {
      const out = await execImpl(spec.file, spec.args);
      if (spec.extract) {
        const m = spec.extract.exec(out);
        return m === null ? null : m[1];
      }
      return out;
    }
    if (spec.kind === 'registry') {
      // `reg query` is used rather than a native call so there is no dependency beyond Windows
      // itself, and so the same `exec` seam covers every source.
      const out = await execImpl('reg', ['query', spec.path, '/v', spec.name]);
      const m = /REG_SZ\s+(\S+)/.exec(out);
      return m === null ? null : m[1];
    }
    return null;
  });

  const values = [];
  for (const spec of sources) {
    let raw = null;
    try {
      raw = await readOne(spec);
    } catch (error) {
      // A source that cannot be read is not a failure of the fingerprint: the next source is the
      // point of having a list. It is recorded so an operator can see the list was cut short.
      audit('hw/source-failed', { source: spec.key, detail: error instanceof Error ? error.message : String(error) });
      continue;
    }
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!isUsefulHardwareValue(value)) {
      audit('hw/source-unusable', { source: spec.key, value: value.slice(0, 40) });
      continue;
    }
    values.push({ source: spec.key, value });
  }
  return { platform, values };
}

/**
 * The host-facing identity service.
 *
 * `getDeviceIdentity()` is read off the context rather than imported, because it is a Cordis
 * service and an optional one: a host without it must produce a named refusal, not a crash. That
 * is what `ctx.get('deepseekAccount')` is for.
 *
 * @param {object} options
 * @param {object} [options.ctx] A Cordis context exposing `get('deepseekAccount')`.
 * @param {object} [options.account] The service itself, injected directly in tests.
 * @param {string} [options.platform]
 * @param {object} [options.hardware] Overrides for `readHardwareValues`.
 * @param {object} [options.stored] An SN already on disk, so it is never regenerated.
 * @param {(event: string, detail?: object) => void} [options.audit]
 */
export function createAccountIdentity(options = {}) {
  const audit = options.audit ?? (() => {});
  const platform = options.platform ?? process.platform;

  function accountService() {
    if (options.account) return options.account;
    if (typeof options.ctx?.get === 'function') return options.ctx.get('deepseekAccount') ?? null;
    return null;
  }

  /**
   * The account's own identifier, or a named reason there is none.
   *
   * `signed-out` is a **normal state**, not an error: a machine with no account has no fleet, and
   * the design says it must not be given a random one instead. Fabricating a placeholder here
   * would put two unrelated machines in the same pool, which is the exact defect being removed.
   */
  async function identify() {
    const service = accountService();
    if (service === null || typeof service.getDeviceIdentity !== 'function') {
      return { ok: false, reason: 'no_account_service', detail: 'the host exposes no deepseekAccount service' };
    }
    let identity;
    try {
      identity = await service.getDeviceIdentity();
      /**
       * A switched account is invisible until the profile is fetched.
       *
       * `getDeviceIdentity()` reads `getPlatformSession().userId`, and that is only populated
       * from a profile already cached for the current grant. After credentials/record-updated
       * the old profile is discarded and the session's userId is null until someone calls
       * `getProfile()`. A machine that was paired before the switch therefore derived no new
       * fleet key and kept its old token -- the reported "still in the previous account's
       * fleet" state. Fetch the profile once when the identity is missing; the second read then
       * sees the new account.
       */
      if ((identity?.userId == null) && typeof service.getProfile === 'function') {
        try {
          await service.getProfile();
          identity = await service.getDeviceIdentity();
        } catch { /* keep the signed-out answer if the profile cannot be read */ }
      }
    } catch (error) {
      return { ok: false, reason: 'identity_read_failed', detail: error instanceof Error ? error.message : String(error) };
    }
    const userId = typeof identity?.userId === 'string' && identity.userId.trim() !== '' ? identity.userId : null;
    if (userId === null) {
      return { ok: false, reason: 'signed-out', detail: 'no DeepSeek account is signed in on this machine' };
    }
    const acct = accountCode(userId);
    if (acct === null) return { ok: false, reason: 'bad_account_id', detail: 'the account id hashed to nothing' };
    audit('account/identified', { account_code: acct });
    // `userId` is returned so the fleet key can be derived from it. It is deliberately NOT put on
    // the wire: the key travels, the raw account id does not, so a relay learns a fleet's identity
    // without learning the account's.
    return {
      ok: true,
      accountCode: acct,
      userId,
      deviceId: identity.deviceId ?? null,
      osVersion: identity.osVersion ?? null,
    };
  }

  /** The hardware code, and which source produced it. */
  async function fingerprint() {
    const { values } = await readHardwareValues({ platform, ...options.hardware });
    if (values.length === 0) {
      return { ok: false, reason: 'no_hardware_source', detail: `no usable hardware identity on ${platform}` };
    }
    const hwid = hardwareCode(...values.map((v) => v.value));
    if (hwid === null) return { ok: false, reason: 'no_hardware_source', detail: 'the values hashed to nothing' };
    return { ok: true, hardwareCode: hwid, sources: values.map((v) => v.source) };
  }

  /**
   * The identity this machine should present.
   *
   * A stored SN is returned unchanged, always. Regenerating it would change the machine's identity
   * on every start — every restart would look like a new device, and the fleet would fill with
   * ghosts of one machine.
   */
    async function resolve() {
      /**
       * The fleet key is derived on **every** resolve, including the stored-SN path.
       *
       * A first version returned early when an SN was already stored and never read the account
       * at all. That is right for the SN -- it must not be regenerated, or every restart would
       * look like a new device -- but it is **wrong for the key**: a machine has a stored SN from
       * its second start onward, so it would have derived a key exactly once and then never
       * again.
       *
       * The auto-join would therefore have worked on a machine's first boot and silently stopped
       * afterwards -- the hardest kind of bug to see, because it works when you test it. So the
       * account is read in both paths, and a signed-out machine yields no key rather than an
       * error.
       */
      const account = await identify();
      let accountFields = { accountCode: null, fleetKey: null, fleetKeyReason: null };
      if (account.ok) {
        try {
          // The KEY travels; the raw `userId` does not.
          accountFields = { accountCode: account.accountCode, fleetKey: encodeFleetKey(deriveAccountFleetKey(account.userId)) };
        } catch (error) {
          /**
           * v0.8.10: **carry the reason out, do not just log it.**
           *
           * This catch used to set `fleetKey: null` and nothing else, which made a derivation
           * failure *indistinguishable from being signed out* at the call site: both arrive as
           * "ok: true (or false) with no key". The caller could not say which had happened, so the
           * one branch that was actually failing had no voice -- the same silent-no-op class fixed
           * in v0.8.5 and v0.8.9, in a third place.
           *
           * `audit` was already called here, but audit output is not somewhere an operator looks.
           * The reason now travels with the result so whoever receives it can name it.
           */
          const detail = error instanceof Error ? error.message : String(error);
          audit('account/fleet-key-failed', { detail });
          accountFields = { accountCode: account.accountCode, fleetKey: null, fleetKeyReason: `fleet_key_derivation_failed: ${detail}` };
        }
      }

      if (options.stored !== undefined && options.stored !== null) {
        const parsed = parseSn(options.stored);
        if (parsed === null) {
          return { ok: false, reason: 'stored_sn_malformed', detail: options.stored };
        }
        // The SN is returned unchanged; the key is fresh, because it comes from the account.
        return { ok: true, sn: options.stored, ...parsed, ...accountFields, reused: true };
      }

      if (!account.ok) return account;
      const hardware = await fingerprint();
      /**
       * v0.8.12: **a missing serial number must not discard a fleet key that was already derived.**
       *
       * The SN needs the hardware fingerprint; the fleet key does not. The key comes from the
       * account's `userId`, and it is computed above, before this point. Returning the bare hardware
       * failure threw that work away -- and because the whole `resolve()` result was then
       * `ok: false` with a hardware reason, the caller could not tell that the *key* had been fine.
       *
       * Measured on the machine this was reported from: `readHardwareValues({ platform: 'win32' })`
       * returns **zero** usable values (both `MachineGuid` and the SMBIOS UUID source come back
       * empty), so `fingerprint()` always failed there and the fleet key was always discarded --
       * which is exactly the reported symptom, a signed-in machine that joins nothing. Retrying the
       * derivation could never have helped: the account was readable and the key *was* computed, then
       * dropped one line later.
       *
       * So the failure is reported as what it is -- `no_hardware_source`, with `ok: false` and the SN
       * fields absent, because there genuinely is no SN -- while `accountFields` still travels, so a
       * caller that only needs to join the account's fleet is not held hostage by a display
       * identifier.
       */
      if (!hardware.ok) return { ...hardware, ...accountFields };
      const sn = buildSn({ accountCode: account.accountCode, hardwareCode: hardware.hardwareCode, at: options.at ?? new Date() });
      audit('account/sn-created', { sn, sources: hardware.sources });
      return {
        ok: true,
        sn,
        ...accountFields,
        hardwareCode: hardware.hardwareCode,
        timeCode: parseSn(sn).timeCode,
        hardwareSources: hardware.sources,
        reused: false,
      };
    }

  return { identify, fingerprint, resolve };
}

/** The config keys an SN needs in order to survive a restart. */
export const SN_STATE_KEY = 'sn';
