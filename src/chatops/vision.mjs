/**
 * Invoke the vendored `vision.py` as a subprocess (v0.57.0).
 *
 * ## What this is, and what it deliberately is not
 *
 * It turns an image path into text evidence by running a Python script. **It is not the WeChat integration.** The
 * bridge still answers an image with a help message, and wiring this into it is a separate change -- kept apart
 * because each half has a different failure mode and can be verified alone. **This half is verifiable today:**
 * give it a real image and it either returns text or a named reason.
 *
 * ## The credential never enters `argv`
 *
 * `vision.py` resolves its key as `--api-key` > `VISION_API_KEY` > the provider's own variable (`ZHIPU_API_KEY`
 * for `glm`). **Passing it on the command line would put a live key into `ps` output and into any argv logging**,
 * so this module only ever sets it **in the child's environment**, and the caller supplies it from a file.
 *
 * ## Why the settings file is read here rather than exported by a shell
 *
 * The bridge is started by hand sometimes and by a launcher other times, **so an `export` in a shell rc is only
 * sometimes in effect** -- and a credential that works until the start method changes is worse than one that
 * never worked, because the failure looks like a broken API. A file with mode 0600 is read the same way
 * whichever process is asking.
 *
 * ## Why the exit code and the stdout are both inspected
 *
 * `vision.py` writes its diagnosis to **stderr** and exits non-zero, and a caller that checks only stdout sees
 * an empty string. It also prints the model's reply to **stdout**, so a caller that checks only the exit code
 * discards the answer. Both are read, and the failure message is the script's own words rather than a
 * paraphrase.
 */
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** Where the vendored script lives, matching the layout the skill repository uses. */
export const DEFAULT_SKILL_DIR = join(homedir(), '.agents', 'skills', 'vision-multimodal');
/** The settings file the bridge reads. Mode 0600, one `KEY=value` per line, `provider` accepted as a key. */
export const DEFAULT_ENV_FILE = join(homedir(), '.config', 'w2m', 'vision.env');

/** Longest image this will hand to the script, in bytes. */
export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

/**
 * Read a `KEY=value` settings file.
 *
 * Deliberately not a dotenv implementation: no expansion, no quoting rules, no `export` prefix. **A settings
 * file that is half a shell is a shell**, and the whole point of this one is that it is read by a parser rather
 * than executed.
 *
 * @param {string} path
 * @returns {{values: Record<string,string>, problem: string|null}}
 */
export function readEnvFile(path) {
  if (!existsSync(path)) return { values: {}, problem: `no settings file at ${path}` };
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return { values: {}, problem: `could not read ${path}: ${error.message}` };
  }
  const values = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const at = line.indexOf('=');
    if (at < 1) return { values: {}, problem: `${path}: line ${JSON.stringify(raw.slice(0, 40))} is not KEY=value` };
    const key = line.slice(0, at).trim();
    let value = line.slice(at + 1).trim();
    // Strip one layer of matching quotes, because a key pasted from a web page often carries them.
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return { values, problem: null };
}

/** Mode on POSIX, or null where the platform has no such bits (Windows reports 0o666 for everything). */
const modeOf = (path) => {
  try {
    const mode = statSync(path).mode & 0o777;
    return process.platform === 'win32' ? null : mode;
  } catch {
    return null;
  }
};

/**
 * Turn the settings values into the environment `vision.py` expects.
 *
 * `provider` is translated to `VISION_PROVIDER` because the script reads that name; everything else is passed
 * through, so the file can carry `ZHIPU_API_KEY`, `VISION_API_KEY`, `VISION_BASE_URL` and `VISION_MODEL`
 * without this module having to know which provider is in use.
 *
 * @param {Record<string,string>} values
 * @param {Record<string,string>} [base] the parent environment
 */
export function visionEnv(values, base = process.env) {
  const env = { ...base };
  for (const [key, value] of Object.entries(values)) {
    env[key === 'provider' ? 'VISION_PROVIDER' : key] = value;
  }
  return env;
}

/** Does the resolved environment actually carry a key for the selected provider? */
const KEY_FOR = { glm: 'ZHIPU_API_KEY', qwen: 'DASHSCOPE_API_KEY', kimi: 'MOONSHOT_API_KEY', openai: 'OPENAI_API_KEY', siliconflow: 'SILICONFLOW_API_KEY' };

export function keyPresent(env) {
  if (typeof env.VISION_API_KEY === 'string' && env.VISION_API_KEY !== '') return true;
  const provider = env.VISION_PROVIDER ?? 'qwen';
  if (provider === 'ollama') return true; // needs no key by design
  const name = KEY_FOR[provider] ?? 'VISION_API_KEY';
  return typeof env[name] === 'string' && env[name] !== '';
}

/**
 * Run one vision command.
 *
 * @param {{command?: string, image: string, prompt?: string, scriptDir?: string, env: object, python?: string, timeoutMs?: number}} options
 * @returns {Promise<{ok: boolean, text: string, reason: string|null, code: number|null, ms: number}>}
 */
export function analyze({ command = 'chat', image, prompt, scriptDir = DEFAULT_SKILL_DIR, env, python = 'python3', timeoutMs = 120_000 }) {
  const script = join(scriptDir, 'vision.py');
  /**
   * Caller mistakes are reported before configuration mistakes.
   *
   * A wrong image path and a missing script are both refusals, and the order decides which one a caller sees.
   * **The image is the argument; the script is the installation.** Checking the installation first meant every
   * malformed call on a machine without the skill answered "no vision.py at …" -- true, and useless, because
   * the caller's own mistake was never mentioned.
   */
  if (typeof image !== 'string' || image === '') return Promise.resolve({ ok: false, text: '', reason: 'no image path given', code: null, ms: 0 });
  if (!existsSync(script)) return Promise.resolve({ ok: false, text: '', reason: `no vision.py at ${script}`, code: null, ms: 0 });
  if (!existsSync(image)) return Promise.resolve({ ok: false, text: '', reason: `image does not exist: ${image}`, code: null, ms: 0 });
  try {
    const size = statSync(image).size;
    if (size > MAX_IMAGE_BYTES) return Promise.resolve({ ok: false, text: '', reason: `image is ${size} bytes, over the ${MAX_IMAGE_BYTES}-byte limit`, code: null, ms: 0 });
  } catch (error) {
    return Promise.resolve({ ok: false, text: '', reason: `could not stat the image: ${error.message}`, code: null, ms: 0 });
  }

  // `shell: false` and an argv array: the image path is data, never a command fragment.
  const argv = [script, command, '--image', image];
  if (typeof prompt === 'string' && prompt !== '') argv.push('--prompt', prompt);
  const started = Date.now();

  return new Promise((resolve) => {
    const child = spawn(python, argv, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let settled = false;
    const finish = (result) => { if (!settled) { settled = true; resolve(result); } };
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, text: '', reason: `vision.py did not finish within ${timeoutMs} ms`, code: null, ms: Date.now() - started });
    }, timeoutMs);

    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', (error) => {
      clearTimeout(timer);
      // A missing interpreter is the most likely error here, and it must read as itself rather than as a
      // generic failure -- the deploy that installs the script does not install python3.
      finish({ ok: false, text: '', reason: error.code === 'ENOENT' ? `no ${python} on PATH` : `could not start ${python}: ${error.message}`, code: null, ms: Date.now() - started });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const ms = Date.now() - started;
      if (code === 0) {
        const text = out.trim();
        if (text === '') finish({ ok: false, text: '', reason: 'vision.py exited 0 but printed nothing', code, ms });
        else finish({ ok: true, text, reason: null, code, ms });
        return;
      }
      // The script's own words, not a paraphrase: it names the missing key env var, the bad path, or the HTTP
      // status, and replacing that with "vision failed" throws away the only actionable part.
      const detail = (err.trim() || out.trim() || `exit ${code}`).split(/\r?\n/).slice(-3).join(' | ');
      finish({ ok: false, text: '', reason: detail, code, ms });
    });
  });
}

/**
 * Is vision usable right now, and if not, why?
 *
 * ## Why the bridge calls this
 *
 * The bridge answers an image with a help message. **Without this it can only say "unsupported"**, which is the
 * same sentence whether the skill is missing, the key is absent, or the interpreter is not installed -- and an
 * operator reading it has no next step. With it, the message names the one thing that is missing.
 *
 * **This is the module's first production caller**, and it is deliberately the smallest useful one: a capability
 * probe, not the analysis path. The orphan gate in `scripts/preflight.mjs` is what required a caller at all, and
 * it was right to -- **a mechanism with no caller is indistinguishable from a finished feature**, which this
 * repository has shipped four times.
 *
 * @param {{envFile?: string, scriptDir?: string, python?: string, env?: object}} [options]
 * @returns {Promise<{ready: boolean, reason: string|null, provider: string|null}>}
 */
export async function visionStatus(options = {}) {
  const envFile = options.envFile ?? DEFAULT_ENV_FILE;
  const scriptDir = options.scriptDir ?? DEFAULT_SKILL_DIR;
  if (!existsSync(join(scriptDir, 'vision.py'))) {
    return { ready: false, reason: `no vision.py at ${join(scriptDir, 'vision.py')}`, provider: null };
  }
  const { values, problem } = readEnvFile(envFile);
  if (problem !== null) return { ready: false, reason: problem, provider: null };
  const env = visionEnv(values, options.env ?? process.env);
  const provider = env.VISION_PROVIDER ?? 'qwen';
  if (!keyPresent(env)) {
    return { ready: false, reason: `${envFile} has no key for provider "${provider}" (set ${KEY_FOR[provider] ?? 'VISION_API_KEY'})`, provider };
  }
  const python = options.python ?? 'python3';
  // The interpreter is checked last because it is the one failure a deploy cannot fix on its own.
  const found = await new Promise((resolve) => {
    const child = spawn(python, ['--version'], { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
  if (!found) return { ready: false, reason: `no ${python} on PATH`, provider };
  return { ready: true, reason: null, provider };
}

/**
 * One sentence for a person who sent an image the bridge cannot hand to a model.
 *
 * @param {{envFile?: string, scriptDir?: string, python?: string, env?: object}} [options]
 * @returns {Promise<string>}
 */
export async function visionUnavailableNote(options = {}) {
  const status = await visionStatus(options);
  if (status.ready) return `vision is configured (${status.provider}) and can read an image on disk`;
  return `vision is not available: ${status.reason}`;
}

/**
 * The whole path, from a settings file to an answer.
 *
 * @param {{image: string, prompt?: string, command?: string, envFile?: string, scriptDir?: string, python?: string, env?: object, timeoutMs?: number}} options
 */
export async function describeImage(options) {
  const envFile = options.envFile ?? DEFAULT_ENV_FILE;
  const { values, problem } = readEnvFile(envFile);
  if (problem !== null) return { ok: false, text: '', reason: problem, code: null, ms: 0 };

  const mode = modeOf(envFile);
  if (mode !== null && (mode & 0o077) !== 0) {
    // A settings file holding a credential that others can read is worth saying out loud, but it is not a
    // refusal: the operator may have a reason, and refusing would make the tool unusable on a shared box.
    return {
      ok: false,
      text: '',
      reason: `${envFile} is mode ${mode.toString(8)}; a file holding a key should be 0600 (chmod 600 ${envFile})`,
      code: null,
      ms: 0,
    };
  }

  const env = visionEnv(values, options.env ?? process.env);
  if (!keyPresent(env)) {
    const provider = env.VISION_PROVIDER ?? 'qwen';
    return { ok: false, text: '', reason: `no key for provider "${provider}": set ${KEY_FOR[provider] ?? 'VISION_API_KEY'} in ${envFile}`, code: null, ms: 0 };
  }
  return analyze({ ...options, env });
}
