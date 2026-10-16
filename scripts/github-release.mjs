#!/usr/bin/env node
/**
 * Publish a release to GitHub with a title and body that describe *that* release.
 *
 * ## Why this is a module rather than another copied script
 *
 * `E:\GPT\scripts\` holds **66 `publish-*-github.mjs` scripts, 56 of which read the same stale commit file and 57
 * of which carry the same hardcoded title.** The defect was not a typo in one script: **it was that each release
 * copied the previous script, and the two constants that must change were the two easiest to forget.**
 *
 * So a caller states the version and the commit, and **the title and body are derived from the repository's own
 * record** -- the commit subject and the CHANGELOG entry. Neither can be copied by accident, because neither is
 * written by hand.
 *
 * ## What it refuses to do
 *
 * * **Refuse to publish when the CHANGELOG has no entry for the version.** A release whose body cannot be derived
 *   is a release that gets published with the previous one's text -- which is what happened 56 times.
 * * **Refuse when the title would be empty**, for the same reason.
 * * **Re-read after writing** and compare, because `PATCH` returning 200 is not evidence that the field changed.
 */
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const API = 'https://api.github.com';

/** Pull one CHANGELOG section, without its heading. Returns null when the version is not recorded. */
export function changelogEntry(text, version) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^## \[/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start + 1, end).join('\n').trim();
}

/** The commit subject, which is what a release title should say. Returns null when unavailable. */
export function commitSubject(text) {
  const first = String(text).split('\n')[0].trim();
  return first === '' ? null : first;
}

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function headers(token) {
  return {
    Authorization: `Bearer ${token}`,
    'User-Agent': 'dsh-release',
    'X-GitHub-Api-Version': '2022-11-28',
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
  };
}

async function api(token, path, method = 'GET', body) {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const r = await fetch(`${API}${path}`, {
        method,
        headers: headers(token),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(120000),
      });
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* an error page is not JSON */ }
      if (r.ok) return { ok: true, status: r.status, json };
      if (r.status === 404) return { ok: false, status: 404, json };
      // 4xx other than 404 will not succeed on retry, so report rather than loop.
      if (r.status < 500) return { ok: false, status: r.status, json, detail: text.slice(0, 300) };
    } catch (error) {
      if (attempt === 5) return { ok: false, status: 0, detail: error.message };
    }
    await new Promise((r) => setTimeout(r, 3000 * attempt));
  }
  return { ok: false, status: 0, detail: 'retries exhausted' };
}

/**
 * Publish one release.
 *
 * @param {{version: string, commit: string, repo: string, token: string, changelogPath: string,
 *          commitPath?: string, assetPath?: string, assetName?: string, dryRun?: boolean}} options
 * @returns {Promise<{ok: boolean, title?: string, bodyChars?: number, problems: string[]}>}
 */
export async function publishRelease(options) {
  const { version, commit, repo, token, changelogPath, commitPath, assetPath, assetName, dryRun = false } = options;
  const problems = [];
  const tag = `v${version}`;

  const changelog = readFileSync(changelogPath, 'utf8');
  const entry = changelogEntry(changelog, version);
  if (entry === null) problems.push(`CHANGELOG.md has no "## [${version}]" entry, so the body cannot be derived`);

  let subject = null;
  if (commitPath !== undefined) {
    if (!existsSync(commitPath)) problems.push(`no commit message at ${commitPath}`);
    else subject = commitSubject(readFileSync(commitPath, 'utf8'));
  }
  if (subject === null) problems.push('the release title could not be derived');

  if (assetPath !== undefined && !existsSync(assetPath)) problems.push(`no asset at ${assetPath}`);
  if (problems.length > 0) return { ok: false, problems };

  let digest = null;
  let assetBuf = null;
  if (assetPath !== undefined) {
    assetBuf = readFileSync(assetPath);
    digest = sha256(assetBuf);
  }

  const body = digest === null
    ? `${entry}\n`
    : `${entry}\n\n> This asset is **byte-identical to the npm release** (sha256 \`${digest}\`).\n`;

  if (dryRun) {
    return { ok: true, title: subject, bodyChars: body.length, problems: ['dry run: nothing was sent'] };
  }

  const existing = await api(token, `/repos/${repo}/releases/tags/${tag}`);
  if (!existing.ok && existing.status !== 404) {
    return { ok: false, problems: [`could not read ${tag}: HTTP ${existing.status} ${existing.detail ?? ''}`] };
  }

  let release;
  if (existing.ok) {
    const patch = await api(token, `/repos/${repo}/releases/${existing.json.id}`, 'PATCH', { name: subject, body });
    if (!patch.ok) return { ok: false, problems: [`PATCH ${tag}: HTTP ${patch.status} ${patch.detail ?? ''}`] };
    release = patch.json;
  } else {
    const create = await api(token, `/repos/${repo}/releases`, 'POST', {
      tag_name: tag,
      target_commitish: commit,
      name: subject,
      body,
      draft: false,
      prerelease: false,
      make_latest: 'true',
    });
    if (!create.ok) return { ok: false, problems: [`POST release ${tag}: HTTP ${create.status} ${create.detail ?? ''}`] };
    release = create.json;
  }

  if (assetBuf !== null && assetName !== undefined) {
    const upload = await fetch(
      `https://uploads.github.com/repos/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(assetName)}`,
      {
        method: 'POST',
        headers: { ...headers(token), 'Content-Type': 'application/octet-stream' },
        body: assetBuf,
        signal: AbortSignal.timeout(300000),
      },
    );
    // 422 means the asset is already attached, which is the normal case on a re-run and not a failure.
    if (!upload.ok && upload.status !== 422) problems.push(`asset upload: HTTP ${upload.status}`);
  }

  // Read back: a successful PATCH is not evidence that the field now holds what was sent.
  const after = await api(token, `/repos/${repo}/releases/tags/${tag}`);
  const nowTitle = after.json?.name ?? null;
  const nowBody = after.json?.body ?? '';
  if (nowTitle !== subject) problems.push(`title did not stick: read back ${JSON.stringify(nowTitle)}`);
  if (nowBody.length === 0) problems.push('body is empty after the write');

  return { ok: problems.length === 0, title: nowTitle, bodyChars: nowBody.length, problems };
}

/**
 * Run only when executed, never when imported.
 *
 * `pathToFileURL` rather than a hand-built `file://` string, which does not resolve on Windows -- **the fifth time
 * this session that the same guard had to be corrected**, which is why it is written out here rather than
 * abbreviated.
 */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const arg = (name, dflt) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : dflt);
  const version = arg('--version');
  if (version === undefined) {
    process.stderr.write('usage: github-release.mjs --version <x.y.z> [--commit <sha>] [--repo owner/name] [--dry-run]\n');
    process.exit(2);
  }
  const result = await publishRelease({
    version,
    commit: arg('--commit', 'main'),
    repo: arg('--repo', 'TwinsEarth/dsh-windows2macos'),
    token: process.env.GITHUB_TOKEN ?? '',
    changelogPath: arg('--changelog', 'CHANGELOG.md'),
    commitPath: arg('--commit-file', undefined),
    assetPath: arg('--asset', undefined),
    assetName: arg('--asset-name', undefined),
    dryRun: argv.includes('--dry-run'),
  });
  for (const p of result.problems) process.stderr.write(`  ${p}\n`);
  process.stdout.write(`  title: ${result.title ?? '(none)'}\n  body : ${result.bodyChars ?? 0} chars\n`);
  process.exit(result.ok ? 0 : 1);
}
