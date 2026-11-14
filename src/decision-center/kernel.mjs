/**
 * W2M-local replacement for the dsh-Fang kernel barrel the decision-center modules import.
 *
 * The ported plugin was written against `../kernel/index.mjs`, a barrel that existed to share ids,
 * a tiny bus, filesystem helpers, the data-directory resolver and the deployment-role gate between
 * the ten Fang plugins. W2M mounts one plugin, so the same names are supplied here with W2M paths:
 *
 *   * `z` is the vendored schemastery the Fang tree carries (MIT, upstream cordis). Keeping it means
 *     the plugin's `Config` definitions and their descriptions survive the port verbatim;
 *   * `SERVICE` names the Cordis services this plugin provides and optionally reads. The values are
 *     W2M-prefixed so a profile that still mounts Fang's decision center cannot collide with this one;
 *   * `resolveFangLayout` returns only what the ported code reads -- `dataDir` -- anchored in the same
 *     `$DSH_HOME/xclient` state directory every other W2M component uses;
 *   * `roleGate` has nothing to gate: the mother/fork deployment matrix is a Fang concept, and a W2M
 *     profile is always the host, so the gate reports active.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { resolveStateDir } from '../util/cli.mjs';

export { default as z } from './vendor/schemastery.mjs';

/** Cordis service keys. Shared by the plugin that provides them and the routes that read them. */
export const SERVICE = Object.freeze({
  auditor: 'w2mAuditor',
  decisionCenter: 'w2mDecisionCenter',
  restart: 'w2mRestart',
});

/**
 * Audit topic names.
 *
 * The ported module imports this object but records nothing through it -- tickets carry their own
 * `audit` array in the store -- so the port keeps the import surface without inventing topics W2M
 * does not emit.
 */
export const AUDIT = Object.freeze({});

/** Deterministic, dependency-free event bus (same contract as the Fang kernel's). */
export function createBus() {
  const map = new Map();
  return {
    on(topic, fn) {
      if (typeof fn !== 'function') return () => {};
      if (!map.has(topic)) map.set(topic, new Set());
      map.get(topic).add(fn);
      return () => map.get(topic)?.delete(fn);
    },
    off(topic, fn) {
      map.get(topic)?.delete(fn);
    },
    emit(topic, payload) {
      const set = map.get(topic);
      if (!set) return 0;
      let n = 0;
      for (const fn of [...set]) {
        try {
          fn(payload);
          n += 1;
        } catch {
          /* a listener must never break the emitter */
        }
      }
      return n;
    },
    listenerCount(topic) {
      return map.get(topic)?.size ?? 0;
    },
    clear(topic) {
      if (topic === undefined) map.clear();
      else map.delete(topic);
    },
  };
}

export const bus = createBus();

/** `prefix_<base36 time><random>`: sortable enough to read, unique enough to key a ticket. */
export function newId(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function newUuid() {
  return randomUUID();
}

export function nowMs() {
  return Date.now();
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function exists(file) {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeFileAtomic(file, data) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  fs.writeFileSync(tmp, data);
  try {
    fs.renameSync(tmp, file);
  } catch {
    // Windows can refuse a rename while a reader holds the file open; retry once, then fall back.
    try {
      fs.copyFileSync(tmp, file);
    } finally {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* the temp file is disposable */
      }
    }
  }
  return file;
}

export function writeJsonAtomic(file, value, { indent = 2 } = {}) {
  return writeFileAtomic(file, `${JSON.stringify(value, null, indent)}\n`);
}

/**
 * Resolve the data directory the decision store lives in.
 *
 * Only `dataDir` is read by the ported code. An explicit `dataRoot` wins (tests and standalone
 * deployments point it at a throwaway directory); otherwise the store sits under
 * `$DSH_HOME/xclient/decision-center`, beside every other W2M state file.
 */
export function resolveFangLayout(options = {}) {
  const { dataRoot = '' } = options;
  const explicit = String(dataRoot ?? '').trim();
  const dataDir =
    explicit !== '' ? path.resolve(explicit) : path.join(resolveStateDir(null, ''), 'decision-center');
  return { dataDir };
}

/**
 * Deployment-role gate.
 *
 * Fang gates a plugin per mother/fork role. W2M always runs as the host, so the gate reports active
 * and keeps the call site (and its `logger` diagnostic) unchanged.
 */
export function roleGate(pluginKey, { logger = null } = {}) {
  const reason = `${pluginKey} active in host`;
  if (logger && typeof logger.info === 'function') logger.info(reason);
  return { role: 'host', active: true, reason };
}
