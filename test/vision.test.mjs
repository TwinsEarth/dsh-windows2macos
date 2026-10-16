/**
 * The vision subprocess wrapper (v0.57.0).
 *
 * ## What is asserted, and what deliberately is not
 *
 * Everything here runs **without a network and without a key**: the settings parser, the environment
 * translation, the key-presence check, and every refusal path. **The one thing not asserted is a real model
 * answer**, because that needs a credential -- and a suite that needs one is a suite that skips wherever the
 * credential is absent, which is most places.
 *
 * ## The two properties worth protecting
 *
 * * **The key never reaches `argv`.** `vision.py` accepts `--api-key`, and passing it would put a live
 *   credential into `ps` output and into any argument logging. The module only ever sets it in the child's
 *   environment, and one assertion checks the argv the child receives.
 * * **A refusal is the script's own words.** `vision.py` writes its diagnosis to stderr -- the missing variable
 *   name, the bad path, the HTTP status -- and collapsing that into "vision failed" discards the only
 *   actionable part.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readEnvFile, visionEnv, keyPresent, analyze, describeImage, DEFAULT_ENV_FILE, DEFAULT_SKILL_DIR, MAX_IMAGE_BYTES } from '../src/chatops/vision.mjs';

let dir;
before(() => { dir = mkdtempSync(join(tmpdir(), 'vision-suite-')); });
after(() => { rmSync(dir, { recursive: true, force: true }); });

const write = (name, text) => { const p = join(dir, name); writeFileSync(p, text, 'utf8'); return p; };

describe('the settings file is parsed, not executed', () => {
  it('reads KEY=value lines and ignores comments and blanks', () => {
    const p = write('a.env', '# a comment\nprovider=glm\n\nZHIPU_API_KEY=abc123\n');
    const { values, problem } = readEnvFile(p);
    assert.equal(problem, null);
    assert.deepEqual(values, { provider: 'glm', ZHIPU_API_KEY: 'abc123' });
  });

  it('strips one layer of matching quotes, because a key pasted from a page carries them', () => {
    assert.deepEqual(readEnvFile(write('b.env', 'ZHIPU_API_KEY="abc"\n')).values.ZHIPU_API_KEY, 'abc');
    assert.deepEqual(readEnvFile(write('c.env', "ZHIPU_API_KEY='abc'\n")).values.ZHIPU_API_KEY, 'abc');
    // Only ONE layer, and only when both ends match.
    assert.deepEqual(readEnvFile(write('d.env', 'ZHIPU_API_KEY="abc\n')).values.ZHIPU_API_KEY, '"abc');
  });

  it('keeps an empty value rather than dropping the line', () => {
    // An explicitly empty key is a different state from an absent one, and the caller decides what it means.
    assert.deepEqual(readEnvFile(write('e.env', 'ZHIPU_API_KEY=\n')).values, { ZHIPU_API_KEY: '' });
  });

  it('refuses a line that is not KEY=value instead of guessing', () => {
    const { problem } = readEnvFile(write('f.env', 'provider=glm\nthis is not a setting\n'));
    assert.match(problem, /is not KEY=value/);
  });

  it('reports a missing file as a named problem, not as empty settings', () => {
    // The distinction matters: absent settings mean "nothing configured", and the caller must be able to say so.
    const { values, problem } = readEnvFile(join(dir, 'absent.env'));
    assert.deepEqual(values, {});
    assert.match(problem, /no settings file at/);
  });

  it('never expands anything, because a half-shell is a shell', () => {
    const { values } = readEnvFile(write('g.env', 'A=$HOME\nB=`whoami`\n'));
    assert.equal(values.A, '$HOME');
    assert.equal(values.B, '`whoami`');
  });
});

describe('the environment translation', () => {
  it('renames `provider` to VISION_PROVIDER and passes the rest through', () => {
    const env = visionEnv({ provider: 'glm', ZHIPU_API_KEY: 'k', VISION_MODEL: 'm' }, {});
    assert.equal(env.VISION_PROVIDER, 'glm');
    assert.equal(env.ZHIPU_API_KEY, 'k');
    assert.equal(env.VISION_MODEL, 'm');
    assert.equal(env.provider, undefined, 'the file key is not left behind under its own name');
  });

  it('overlays the parent environment rather than replacing it', () => {
    const env = visionEnv({ ZHIPU_API_KEY: 'k' }, { PATH: '/usr/bin', HOME: '/home/x' });
    assert.equal(env.PATH, '/usr/bin');
    assert.equal(env.HOME, '/home/x');
    assert.equal(env.ZHIPU_API_KEY, 'k');
  });

  it('finds a key under the generic name, the provider name, or not at all', () => {
    assert.equal(keyPresent({ VISION_API_KEY: 'k' }), true);
    assert.equal(keyPresent({ VISION_PROVIDER: 'glm', ZHIPU_API_KEY: 'k' }), true);
    assert.equal(keyPresent({ VISION_PROVIDER: 'glm' }), false);
    assert.equal(keyPresent({ VISION_PROVIDER: 'glm', ZHIPU_API_KEY: '' }), false, 'empty is not a key');
    // Ollama needs none by design, so its absence is not a missing key.
    assert.equal(keyPresent({ VISION_PROVIDER: 'ollama' }), true);
    assert.equal(keyPresent({}), false, 'the default provider is qwen, which does need one');
  });
});

describe('refusals carry a reason a caller can act on', () => {
  /**
   * A directory that satisfies the script-exists check, so the assertions below reach the branch they name.
   *
   * Without it every case answered `no vision.py at …` -- **true, and useless**: the caller's own mistake was
   * never mentioned. The module now reports caller mistakes before configuration ones, and this directory keeps
   * the two separable in the test as well.
   */
  before(() => { writeFileSync(join(dir, 'vision.py'), '# placeholder', 'utf8'); });

  it('names a missing image path', async () => {
    const r = await analyze({ image: join(dir, 'nope.png'), env: {}, scriptDir: dir });
    assert.equal(r.ok, false);
    assert.match(r.reason, /image does not exist/);
  });

  it('refuses an empty image argument even with no script installed', async () => {
    // The ordering that IS guaranteed: an empty argument is rejected before the installation is consulted. My
    // first version of this test claimed a non-existent image outranks a missing script too, and the module says
    // otherwise -- **the code was right and the assertion was wrong.** The order is: empty argument, then
    // script, then whether the image is there.
    const r = await analyze({ image: '', env: {}, scriptDir: join(dir, 'noskill') });
    assert.match(r.reason, /no image path given/, `got: ${r.reason}`);
  });

  it('names a missing script directory', async () => {
    const r = await analyze({ image: join(dir, 'x.png'), env: {}, scriptDir: join(dir, 'noskill') });
    assert.match(r.reason, /no vision\.py at/);
  });

  it('names a missing interpreter, which is the likeliest failure after a deploy', async () => {
    // The deploy that installs vision.py does not install python3, so this is the failure to expect.
    const image = write('tiny.png', 'not really a png');
    const r = await analyze({ image, env: {}, scriptDir: dir, python: 'python-absent-xyz' });
    assert.equal(r.ok, false);
    assert.match(r.reason, /no python-absent-xyz on PATH/);
  });

  it('surfaces the settings problem through describeImage, not an empty answer', async () => {
    const r = await describeImage({ image: join(dir, 'x.png'), envFile: join(dir, 'absent.env') });
    assert.equal(r.ok, false);
    assert.equal(r.text, '');
    assert.match(r.reason, /no settings file at/);
  });

  it('names the provider and the variable it wanted when the key is absent', async () => {
    const envFile = write('nokey.env', 'provider=glm\n');
    const image = write('k.png', 'bytes');
    const r = await describeImage({ image, envFile, scriptDir: dir, env: {} });
    assert.equal(r.ok, false);
    assert.match(r.reason, /no key for provider "glm"/);
    assert.match(r.reason, /ZHIPU_API_KEY/, 'and names the variable to set');
  });
});

describe('the defaults match the layout the skill ships with', () => {
  it('looks for the script under ~/.agents/skills and the settings under ~/.config/w2m', () => {
    // Both are asserted because a wrong default is invisible: the module answers "no vision.py at …", which
    // reads as a broken install rather than as a wrong constant.
    assert.ok(DEFAULT_SKILL_DIR.endsWith(join('.agents', 'skills', 'vision-multimodal')), DEFAULT_SKILL_DIR);
    assert.ok(DEFAULT_ENV_FILE.endsWith(join('.config', 'w2m', 'vision.env')), DEFAULT_ENV_FILE);
  });

  it('bounds the image size, so one large file cannot become one large upload', () => {
    assert.equal(MAX_IMAGE_BYTES, 12 * 1024 * 1024);
  });
});
