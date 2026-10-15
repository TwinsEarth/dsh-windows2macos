/**
 * Validate every skill against the contract its hosts actually enforce.
 *
 * A skill that violates this contract is **not an error at load time** -- the loader logs a warning and
 * returns, so the skill simply never appears. That is the failure mode this exists to catch, and it is why
 * the checks mirror the loaders rather than inventing their own rules.
 *
 * ## Two hosts, and the stricter rule wins
 *
 * `@deepseek-ai/dsh-skill` reads `name` and `description`, tests the name against
 * `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`, and rejects three renamed invocation spellings outright. The Agent Skills
 * specification (agentskills.io) requires the same two fields and adds limits the loader does not have:
 * **`name` at most 64 characters, `description` at most 1024.** A skill shipped to both must satisfy both,
 * and the portable limits are the ones a host is least likely to tell you about.
 *
 * ## No side effects on import
 *
 * The rules are exported and the CLI lives in `main()`. A validator whose import runs it cannot be tested by
 * a suite that is itself run through a child process -- and a sandbox that refuses piped stdio would then
 * disable the test as well as the check.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** From `@deepseek-ai/dsh-skill`: the only names the loader accepts. */
export const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Agent Skills: lowercase letters, numbers and hyphens, not starting or ending with a hyphen. */
export const AGENT_SKILLS_NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
export const NAME_MAX = 64;
export const DESCRIPTION_MAX = 1024;

/** Fields `parseSkillFile` reads. Anything else is carried through `metadata` or ignored by the host. */
export const KNOWN = new Set(['name', 'description', 'whenToUse', 'metadata', 'disable-model-invocation', 'user-invocable']);
/** Fields the Agent Skills specification defines. */
export const PORTABLE = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']);
/** Spellings the loader rejects outright, because they were renamed. */
export const REJECTED = new Set(['disableModelInvocation', 'modelInvocable', 'userInvocable']);

/**
 * Minimal YAML frontmatter reader: `key: value` lines, plus folded continuations.
 *
 * Deliberately not a YAML parser. A skill needing nested structures should fail here rather than be silently
 * misread, and the host does the real parsing with a real parser.
 */
export function frontmatter(text) {
  if (!text.startsWith('---')) return null;
  const end = text.indexOf('\n---', 3);
  if (end < 0) return null;
  const data = {};
  let lastKey = null;
  for (const raw of text.slice(3, end).split('\n')) {
    if (raw.trim() === '') continue;
    const m = /^([A-Za-z][A-Za-z0-9_-]*):\s?(.*)$/.exec(raw);
    if (m) { lastKey = m[1]; data[lastKey] = m[2]; continue; }
    if (lastKey !== null && /^\s+\S/.test(raw)) { data[lastKey] += ` ${raw.trim()}`; continue; }
    return { invalid: true, line: raw };
  }
  return { data, body: text.slice(end + 4) };
}

/**
 * Check every skill in `root` against both hosts.
 *
 * @param {string} root directory whose immediate children are skill directories
 * @returns {{names: string[], problems: string[]}}
 */
export function checkSkills(root) {
  const problems = [];
  const names = [];
  for (const entry of readdirSync(root).sort()) {
    const dir = join(root, entry);
    if (!statSync(dir).isDirectory()) { problems.push(`${entry}: not a directory -- a skill is a directory holding SKILL.md`); continue; }
    let text;
    try { text = readFileSync(join(dir, 'SKILL.md'), 'utf8'); } catch { problems.push(`${entry}: no SKILL.md`); continue; }
    names.push(entry);

    const fm = frontmatter(text);
    if (fm === null) { problems.push(`${entry}: no YAML frontmatter (the loader ignores the file)`); continue; }
    if (fm.invalid === true) { problems.push(`${entry}: unreadable frontmatter line ${JSON.stringify(String(fm.line).slice(0, 60))}`); continue; }
    const { data, body } = fm;

    // The required pair. Missing either means the loader warns and drops the skill.
    for (const required of ['name', 'description']) {
      if (typeof data[required] !== 'string' || data[required].trim() === '') problems.push(`${entry}: frontmatter is missing a non-empty "${required}"`);
    }

    if (typeof data.name === 'string') {
      // The loader takes the name from the file, not the folder, so a mismatch loads under a name nobody looks for.
      if (!SKILL_NAME.test(data.name)) problems.push(`${entry}: name ${JSON.stringify(data.name)} fails the loader pattern -- lowercase kebab-case only`);
      if (!AGENT_SKILLS_NAME.test(data.name)) problems.push(`${entry}: name ${JSON.stringify(data.name)} fails the Agent Skills pattern`);
      if (data.name.length > NAME_MAX) problems.push(`${entry}: name is ${data.name.length} characters, over the ${NAME_MAX}-character limit`);
      if (data.name !== entry) problems.push(`${entry}: name does not match its directory, so it loads under a name the folder does not suggest`);
    }

    if (typeof data.description === 'string' && data.description.length > DESCRIPTION_MAX) {
      problems.push(`${entry}: description is ${data.description.length} characters, over the ${DESCRIPTION_MAX}-character limit`);
    }

    for (const key of Object.keys(data)) {
      if (REJECTED.has(key)) problems.push(`${entry}: field "${key}" was renamed and is rejected outright by the loader`);
      else if (!KNOWN.has(key) && !PORTABLE.has(key)) problems.push(`${entry}: field "${key}" is read by neither host`);
    }

    // The booleans are parsed strictly, so a bad value throws and the skill is dropped.
    for (const key of ['disable-model-invocation', 'user-invocable']) {
      if (!(key in data)) continue;
      const v = String(data[key]).toLowerCase();
      if (!['true', 'false', 'yes', 'no', 'on', 'off', '1', '0'].includes(v)) problems.push(`${entry}: "${key}" must be a boolean, got ${JSON.stringify(data[key])}`);
    }

    // An empty body is a skill that tells the model nothing.
    if (body.trim().length < 200) problems.push(`${entry}: body is ${body.trim().length} chars -- too thin to be useful`);
  }
  return { names, problems };
}

function main(argv) {
  const root = argv[2] ?? 'skills';
  const { names, problems } = checkSkills(root);
  console.log(`  skills found: ${names.length}`);
  for (const name of names) console.log(`    ${name}`);
  console.log(`  problems: ${problems.length}`);
  for (const p of problems) console.log(`    ${p}`);
  process.exit(problems.length === 0 ? 0 : 1);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv);
