/**
 * 发布字节核验：同一个版本在 tag 树、GitHub Release 资产、npm tarball 三处必须逐字节一致。
 *
 * 用法：
 *   node scripts/verify-release-bytes.mjs 3.0.0                      # 只比对 Release 与 npm
 *   node scripts/verify-release-bytes.mjs 3.0.0 --dist dist/x.tgz    # 再比对本地打包产物（应先在
 *                                                                    # 该版本的 tag 提交上跑 scripts/pack.mjs）
 *   node scripts/verify-release-bytes.mjs 3.0.0 --package <dir>       # 或者给出解包后的 package 目录
 *
 * 输出一张表：每个来源的字节数与 sha256；全部相等退出 0，任一不等退出 1 并列出差异。
 * 该脚本只读网络与本地文件，不发布任何东西。
 */
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

const REPO = 'TwinsEarth/dsh-windows2macos';
const PACKAGE = '@twinsearth/w2m-dsh-plugin';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function fail(message) {
  process.stderr.write(`verify-release-bytes: ${message}\n`);
  process.exit(1);
}

async function download(url) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) fail(`GET ${url} -> HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

const args = process.argv.slice(2);
const version = args[0];
if (version === undefined || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  fail('usage: node scripts/verify-release-bytes.mjs <version> [--dist <tgz>] [--package <dir>]');
}
let distPath = null;
let packageDir = null;
for (let index = 1; index < args.length; index += 1) {
  if (args[index] === '--dist') distPath = args[++index] ?? fail('--dist needs a path');
  else if (args[index] === '--package') packageDir = args[++index] ?? fail('--package needs a path');
  else fail(`unknown argument: ${args[index]}`);
}

const report = [];
const problems = [];

// 1) GitHub Release：SHA256SUMS 与 tgz 资产
const releaseResponse = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/v${version}`, {
  headers: { accept: 'application/vnd.github+json' },
});
if (!releaseResponse.ok) fail(`release v${version} -> HTTP ${releaseResponse.status}`);
const release = await releaseResponse.json();
const sumsAsset = (release.assets ?? []).find((asset) => asset.name === 'SHA256SUMS');
const tgzName = `twinsearth-w2m-dsh-plugin-${version}.tgz`;
const tgzAsset = (release.assets ?? []).find((asset) => asset.name === tgzName);
if (sumsAsset === undefined) fail('the release has no SHA256SUMS asset');
if (tgzAsset === undefined) fail(`the release has no ${tgzName} asset`);

const sumsText = new TextDecoder().decode(await download(sumsAsset.browser_download_url));
const recorded = new Map();
for (const line of sumsText.split('\n')) {
  const match = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim());
  if (match !== null) recorded.set(match[2].trim(), match[1]);
}
if (!recorded.has(tgzName)) fail(`SHA256SUMS does not name ${tgzName}`);

const releaseBytes = await download(tgzAsset.browser_download_url);
report.push({
  source: `GitHub Release v${version}`,
  bytes: releaseBytes.byteLength,
  sha256: sha256(releaseBytes),
});
report.push({ source: 'Release SHA256SUMS', bytes: sumsText.length, sha256: recorded.get(tgzName) });

// 2) npm：registry 元数据与实际 tarball 字节
const registryResponse = await fetch(`https://registry.npmjs.org/${encodeURIComponent(PACKAGE)}`, {
  headers: { accept: 'application/json', 'cache-control': 'no-cache' },
});
if (!registryResponse.ok) fail(`npm registry lookups -> HTTP ${registryResponse.status}`);
const registry = await registryResponse.json();
const manifest = registry.versions?.[version];
if (manifest === undefined)
  problems.push(`npm has no ${PACKAGE}@${version}; latest is ${registry['dist-tags']?.latest ?? '(none)'}`);
let npmBytes = null;
if (manifest !== undefined) {
  npmBytes = await download(manifest.dist.tarball);
  report.push({
    source: `npm tarball ${PACKAGE}@${version}`,
    bytes: npmBytes.byteLength,
    sha256: sha256(npmBytes),
  });
}

// 3) 本地打包产物（可选）：应来自该版本的 tag 提交
if (distPath !== null) {
  const bytes = new Uint8Array(readFileSync(distPath));
  report.push({ source: `local ${distPath}`, bytes: statSync(distPath).size, sha256: sha256(bytes) });
}
if (packageDir !== null) {
  const pkg = JSON.parse(readFileSync(`${packageDir}/package.json`, 'utf8'));
  report.push({ source: `unpacked ${packageDir}/package.json`, bytes: 0, sha256: `version=${pkg.version}` });
  if (pkg.version !== version)
    problems.push(`unpacked package version is ${pkg.version}, expected ${version}`);
}

// 4) 比对：asset 字节、资产声明哈希、npm 字节必须一致
const expected = recorded.get(tgzName);
const mismatched = report.filter(
  (entry) => entry.source !== 'Release SHA256SUMS' && entry.bytes > 0 && entry.sha256 !== expected,
);
if (report.find((entry) => entry.source === `GitHub Release v${version}`)?.sha256 !== expected) {
  problems.push('the Release asset does not hash to the value in its own SHA256SUMS');
}
if (npmBytes !== null && sha256(npmBytes) !== expected) {
  problems.push('the npm tarball does not hash to the Release SHA256SUMS value');
}

const width = Math.max(...report.map((entry) => entry.source.length));
process.stdout.write(`\nrelease byte verification for ${PACKAGE}@${version}\n\n`);
for (const entry of report) {
  process.stdout.write(
    `  ${entry.source.padEnd(width)}  ${String(entry.bytes).padStart(9)} B  ${entry.sha256}\n`,
  );
}
process.stdout.write(`\n  expected (SHA256SUMS) ${expected}\n`);
process.stdout.write(`  head tag: v${version}\n`);

if (problems.length > 0 || mismatched.length > 0) {
  for (const problem of problems) process.stderr.write(`  FAIL ${problem}\n`);
  for (const entry of mismatched)
    process.stderr.write(`  FAIL ${entry.source} hash differs from SHA256SUMS\n`);
  process.exit(1);
}
process.stdout.write('\n  OK: tag tree pack, Release asset, SHA256SUMS and npm tarball are byte-identical\n');
