/**
 * Runtime validation driver — runs INSIDE the Harness runtime (Electron in Node mode).
 *
 * Started by `src/backup/runtime-validate.mjs` as:
 *
 *   ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" runtime-driver.mjs <artifact.json>
 *
 * The artifact JSON is `{ header, events, inheritedEventCount }`, already decoded from the zstd container by the
 * node side (frame splitting is tested there). This file's only job is to hand it to the application's own
 * session-format catalog and report the verdict on one stdout line.
 *
 * Why the driver must be a separate process: the catalog modules live inside `resources/app.asar`, which only
 * Electron's patched `fs` can read. This is the same constraint `test/helpers/dsh-loader-driver.mjs` documents,
 * and the same mechanism: the real code, driven for real, by the real runtime.
 *
 * Exit code is always 0 when a verdict was produced; the line carries `ok`. A crash or a missing verdict is the
 * caller's signal that the measurement itself failed (it reports that as "no verdict", never as a pass).
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPORT_PREFIX = 'W2M-RUNTIME-VALIDATE:';

/** Report a verdict and leave. */
function report(verdict) {
  process.stdout.write(`${REPORT_PREFIX}${JSON.stringify(verdict)}\n`);
}

/** Where the installed packages are, relative to the running Harness executable. */
function packagesUrl() {
  const runtimeRoot = path.dirname(process.execPath);
  const modules = path.join(runtimeRoot, 'resources', 'app.asar', 'dsh', 'node_modules');
  if (!fs.existsSync(modules)) throw new Error(`the running runtime has no app.asar node_modules at ${modules}`);
  return pathToFileURL(modules).href;
}

async function main() {
  const artifactFile = process.argv[2];
  if (typeof artifactFile !== 'string' || artifactFile === '') {
    report({ ok: false, detail: 'usage: runtime-driver.mjs <artifact.json>', events: 0 });
    return;
  }
  let artifact;
  try {
    artifact = JSON.parse(fs.readFileSync(artifactFile, 'utf8'));
  } catch (error) {
    report({ ok: false, detail: `could not read the artifact: ${error instanceof Error ? error.message : String(error)}`, events: 0 });
    return;
  }
  if (artifact === null || typeof artifact !== 'object' || artifact.header === undefined || !Array.isArray(artifact.events)) {
    report({ ok: false, detail: 'the artifact is not {header, events, inheritedEventCount}', events: 0 });
    return;
  }
  try {
    const packages = packagesUrl();
    const { sessionFormatCatalog } = await import(`${packages}/@deepseek-ai/dsh-session-format-catalog/lib/index.js`);
    // `validation: 'current'` selects the installed Session package's own validation (restoreCurrent).
    const restore = sessionFormatCatalog.createRestore(artifact.header, { validation: 'current' });
    for (const event of artifact.events) restore.decodeRow(event);
    const restored = restore.finish();
    report({ ok: true, detail: `validated by the installed Harness (format v${restored.header.version})`, events: restored.events.length });
  } catch (error) {
    const name = error?.constructor?.name ?? 'Error';
    const message = error instanceof Error ? error.message : String(error);
    report({ ok: false, detail: `${name}: ${message}`, events: 0 });
  }
}

await main();
