/**
 * Runtime validation driver — runs INSIDE the Harness runtime (Electron in Node mode).
 *
 * Two input modes, because real session logs can be very large:
 *
 *   ELECTRON_RUN_AS_NODE=1 "<exe>" runtime-driver.mjs <artifacts.json>
 *       one artifact object or an array of small artifacts (batch mode)
 *
 *   ELECTRON_RUN_AS_NODE=1 "<exe>" runtime-driver.mjs -ndjson <artifact.ndjson>
 *       one artifact streamed line-by-line: first line `{header, inheritedEventCount}`, then one JSON event per
 *       line. Streaming exists because parsing a ~370 MiB JSON array crashed the Electron V8 heap on a real
 *       backup; the streaming path never holds the whole artifact as one JS value.
 *
 * Output is one line: `W2M-RUNTIME-VALIDATE:{"verdicts":[{ok, detail, events}, ...]}`.
 *
 * The verdict for each artifact comes from the application's own catalog:
 * `sessionFormatCatalog.createRestore(header, { validation: 'current' })` -> `decodeRow` per event -> `finish()`.
 * That is the code the running app uses (G5); this file adds no validation logic of its own.
 *
 * Why a separate process: the catalog lives inside `resources/app.asar`, which only Electron's patched `fs` can
 * read (the same constraint `test/helpers/dsh-loader-driver.mjs` documents).
 *
 * Exit code is always 0 when a verdict was produced; the line carries `ok`. A crash or a missing line is the
 * caller's signal that the measurement itself failed (it reports that as "no verdict", never as a pass).
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';

const REPORT_PREFIX = 'W2M-RUNTIME-VALIDATE:';

/** Report a verdict and leave. */
function report(verdicts) {
  process.stdout.write(`${REPORT_PREFIX}${JSON.stringify({ verdicts })}\n`);
}

/** Where the installed packages are, relative to the running Harness executable. */
function packagesUrl() {
  const runtimeRoot = path.dirname(process.execPath);
  const modules = path.join(runtimeRoot, 'resources', 'app.asar', 'dsh', 'node_modules');
  if (!fs.existsSync(modules)) throw new Error(`the running runtime has no app.asar node_modules at ${modules}`);
  return pathToFileURL(modules).href;
}

/** Validate one in-memory artifact through the installed catalog; never throws. */
function validateOne(catalog, artifact) {
  if (artifact === null || typeof artifact !== 'object' || artifact.header === undefined || !Array.isArray(artifact.events)) {
    return { ok: false, detail: 'the artifact is not {header, events, inheritedEventCount}', events: 0 };
  }
  try {
    const restore = catalog.createRestore(artifact.header, { validation: 'current' });
    for (const event of artifact.events) restore.decodeRow(event);
    const restored = restore.finish();
    return { ok: true, detail: `validated by the installed Harness (format v${restored.header.version})`, events: restored.events.length };
  } catch (error) {
    const name = error?.constructor?.name ?? 'Error';
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, detail: `${name}: ${message}`, events: 0 };
  }
}

/** Validate one artifact streamed from an NDJSON file; never throws. */
async function validateStreamed(catalog, file) {
  let restore = null;
  let events = 0;
  try {
    const stream = fs.createReadStream(file, { encoding: 'utf8' });
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of lines) {
      if (line.trim() === '') continue;
      const row = JSON.parse(line);
      if (restore === null) {
        restore = catalog.createRestore(row.header, { validation: 'current' });
        continue;
      }
      restore.decodeRow(row);
      events += 1;
    }
    if (restore === null) return { ok: false, detail: 'the NDJSON artifact has no header line', events: 0 };
    const restored = restore.finish();
    return { ok: true, detail: `validated by the installed Harness (format v${restored.header.version})`, events: restored.events.length };
  } catch (error) {
    const name = error?.constructor?.name ?? 'Error';
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, detail: `${name}: ${message}`, events };
  }
}

async function main() {
  const first = process.argv[2];
  const second = process.argv[3];
  const streamMode = first === '-ndjson';
  const target = streamMode ? second : first;
  if (typeof target !== 'string' || target === '') {
    report([{ ok: false, detail: 'usage: runtime-driver.mjs <artifacts.json> | -ndjson <artifact.ndjson>', events: 0 }]);
    return;
  }
  let catalog;
  try {
    const packages = packagesUrl();
    ({ sessionFormatCatalog: catalog } = await import(`${packages}/@deepseek-ai/dsh-session-format-catalog/lib/index.js`));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    report([{ ok: false, detail: `the runtime validator failed to start: ${message}`, events: 0 }]);
    return;
  }
  if (streamMode === true) {
    report([await validateStreamed(catalog, target)]);
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (error) {
    report([{ ok: false, detail: `could not read the artifacts: ${error instanceof Error ? error.message : String(error)}`, events: 0 }]);
    return;
  }
  const artifacts = Array.isArray(parsed) ? parsed : [parsed];
  report(artifacts.map((artifact) => validateOne(catalog, artifact)));
}

await main();
