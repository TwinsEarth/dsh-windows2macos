/**
 * Memory-domain tools: w2m_memory, w2m_chat, w2m_intent.
 *
 * Each `register<Name>(ctx, deps)` factory is invoked by `apply()` in the same order the tools have
 * always been registered; the body is the same block that used to be inline in `apply()`, with the
 * apply-scope glue it closed over now arriving through `deps`.
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
// The individual memory layer (v0.9.6). Read through the agent's own module rather than re-parsing the
// file here: the reader carries the rules that matter -- newest-first by file position, a malformed line
// skipped rather than fatal, and the rotated generation reachable -- and a second implementation would
// drift from the writer's shape without anything failing.
import { appendMemory, readMemorySync } from '../../agent/memory.mjs';
// v0.41.0: v4.8.0's other half. Written in 0.9.9 and 0.29.0, and **nothing called them** until here --
// `field-authority.mjs` was reported as an orphan in 0.36.0 and stayed on the accepted list until 0.41.0.
// `makeBlock` is NOT imported: this path receives blocks and only reads them. Building one here would be the
// plugin asserting a claim on its own behalf, which is the sender's job.
import { acceptBlock, verifyBlock } from '../../agent/blocks.mjs';
import { acceptWithAuthority } from '../../agent/field-authority.mjs';
// v1.0.11: the merge rule (#2b) lives in its own module so the operator's two layers can be tested as a rule,
// exhaustively, without a profile or a relay.
import { mergeMemory } from '../fleet-merge.mjs';
import { joinUrl } from '../../agent/url.mjs';
import { renderMemoryView } from '../memory-view.mjs';
import { renderMergeHint } from '../merge-hint.mjs';
import { deriveTurns } from '../turn.mjs';
import { decryptChatMessage, deriveChatKey, encryptChatText, encryptChatTextV2, isEncrypted } from '../../util/chat-crypto.mjs';
import { chatEncV2Supported } from '../chat-v2-gate.mjs';
import { listIntents, resolveIntent } from '../intents.mjs';

import { CHAT_CURSOR_FILE, CHAT_SPOOL_FILE, readLocalIdentity, request, requireRabbit, resolvedFleetKey, resolveToken, throwIfAborted, W2MError } from './shared.mjs';

async function readChatCursors(stateDir) {
  if (typeof stateDir !== 'string' || stateDir === '') return {};
  try {
    const parsed = JSON.parse(await fs.readFile(join(stateDir, CHAT_CURSOR_FILE), 'utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

async function writeChatCursors(stateDir, cursors) {
  if (typeof stateDir !== 'string' || stateDir === '') return false;
  try { await fs.writeFile(join(stateDir, CHAT_CURSOR_FILE), JSON.stringify(cursors, null, 2), 'utf8'); return true; }
  catch { return false; }
}

async function readChatSpool(stateDir) {
  if (typeof stateDir !== 'string' || stateDir === '') return [];
  try {
    const text = await fs.readFile(join(stateDir, CHAT_SPOOL_FILE), 'utf8');
    return text.split('\n').map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter((entry) => entry !== null && typeof entry === 'object');
  } catch { return []; }
}

async function writeChatSpool(stateDir, entries) {
  if (typeof stateDir !== 'string' || stateDir === '') return false;
  try {
    await fs.writeFile(join(stateDir, CHAT_SPOOL_FILE), entries.map((entry) => JSON.stringify(entry)).join('\n') + (entries.length === 0 ? '' : '\n'), 'utf8');
    return true;
  } catch { return false; }
}

export function registerMemory(ctx, deps) {
  const { cfg, collectivePath, defineTool, jsonOutput } = deps;
  ctx.tools.register(defineTool({
    name: 'w2m_memory',
    description:
      'Ask what the fleet already knows and what this machine has already done. scope="local" reads ' +
      'this machine\'s individual memory: one line per finished task with the command, exit code, ' +
      'duration, transport and the tails of stdout/stderr. scope="fleet" reads the curated collective ' +
      'memory: measured facts with their dates, decisions with their reasoning, and open problems. The ' +
      'relay keeps only hashes, so these files are the only place a command\'s output survives. Use it ' +
      'before re-running work -- it is what turns a dozen rediscovery dispatches into one lookup.',
    parameters: {
      /**
       * v1.0.7: `read` (the default, and the only behaviour before this release), `publish`, or `pull`.
       *
       * Defaulting to `read` is deliberate: every existing caller says nothing about `action`, and a tool that
       * changed what "call `w2m_memory`" means would be a silent behaviour change on the one path that is supposed
       * to be safe to call blindly.
       */
      action: {
        type: 'string',
        enum: ['read', 'publish', 'pull', 'latest', 'diff', 'merge', 'append'],
        description:
          'read (default) = answer from memory. publish = upload the curated collective memory '
          + '(`fleet-memory.md`) to the relay as a content-addressed blob and return its SHA-256. latest = ask the '
          + 'relay which blob this fleet published last. pull = fetch one blob by SHA-256 -- or by "latest" -- and '
          + 'return its text, re-hashing it. diff = compare the local document against the fleet current blob and '
          + 'report what differs. merge = apply the declared conflict rule (newest wins by default; a declared '
          + 'repair of the default flow outranks recency) and return the merged text with every decision recorded. '
          + '**No action modifies the local file.**',
        default: 'read',
      },
      hash: {
        type: 'string',
        description:
          'The SHA-256 naming the blob, for action="pull": 64 lowercase hex characters. A hash that exists on the '
          + 'relay but belongs to another fleet is reported as not found, exactly like a hash that was never '
          + 'stored -- a distinguishable refusal would confirm to a prober which hashes this relay holds.',
      },
      records: {
        type: 'array',
        items: { type: 'string' },
        description:
          'For action="append": one append-only record per string. Appending is the unit of change, so two machines ' +
          'can add records without one overwriting the other document.',
      },
      if_revision: {
        type: 'number',
        description:
          'For action="append": the revision you read. A stale value is refused with 409 and the records you have not ' +
          'read, because applying it on top of something you never saw is a silent overwrite.',
      },
      scope: {
        type: 'string',
        enum: ['local', 'fleet'],
        description:
          'local (default) = what this machine did; fleet = what the fleet knows, from the curated ' +
          'collective memory.',
        default: 'local',
      },
      machine: {
        type: 'string',
        description:
          'Which machine\'s memory to read. Defaults to this machine. Naming another machine is ' +
          'answered with where its memory is kept, because this build can only read the local file.',
      },
      limit: {
        type: 'number',
        description: 'How many records to return, newest first. Defaults to 20.',
        default: 20,
      },
      include_previous: {
        type: 'boolean',
        description:
          'Also read the rotated generation (`memory.jsonl.1`). The log is capped and rotates, so a ' +
          'memory question about anything older than the current file needs this.',
        default: false,
      },
      record: {
        type: 'string',
        description:
          'Record a conclusion against the most recent task: what its result meant. This is the only ' +
          'field a machine is not allowed to write itself -- the machine stores the fact, a reader ' +
          'asserts the meaning. Written as a new record so nothing already written is rewritten.',
      },
      accept_block: {
        type: 'object',
        /**
         * `true`, and it has to be stated.
         *
         * ## The defect this closes, and why it took so long to see
         *
         * DSH's `parameterSchemaSpecToJsonSchema` **requires an explicit `additionalProperties` on every
         * `type: 'object'` parameter** and throws otherwise:
         *
         *     JsonSchemaError: unsupported JSON schema:
         *       parameters.accept_block.additionalProperties must be explicitly true or false at authorError
         *         at parameterSchemaSpecToJsonSchema (dsh-tools/lib/index.js:803)
         *         at defineTool (dsh-tools/lib/index.js:848)
         *         at Object.apply (src/plugin/tools.mjs:5025)
         *
         * **The throw happens while the tool is being defined, so the whole fiber fails to mount** -- the client
         * reports the package as `异常`, none of the twelve tools appear, and **the message is only visible if
         * something gets far enough to print it.** This parameter has had that shape since v0.41.0, so the
         * failure dates from then.
         *
         * **`true` rather than `false`:** `verifyBlock()` and `acceptWithAuthority()` already validate the block's
         * structure and hash, so the schema is not the guard here, and a peer that adds a field outside the seven
         * would be **refused for a reason that has nothing to do with trust**. Refusing a legitimate block is the
         * worse error of the two.
         *
         * Only one parameter in this file had the shape -- checked across the whole tool surface, not just here.
         */
        additionalProperties: true,
        description:
          'v0.41.0. Accept a CAT7 cognitive block received from another machine, per field, DRIVEN BY AN ' +
          'AUTHORITY LEVEL (actor_authority below) rather than accepted whole. A field the level cannot ' +
          'afford is OMITTED from the stored block rather than set to null, and lineage is checked against ' +
          'the ancestors you supply: a block whose parent cannot be produced is REFUSED, never silently ' +
          're-rooted, because re-rooting turns an unverifiable history into no history. Every field decision ' +
          'is reported, so a refusal is readable rather than mysterious.',
      },
      actor_authority: {
        type: 'number',
        description:
          'The authority level, 0..100, for accept_block. Required with it: an unset level means there is ' +
          'no actor to judge, and accepting a block whole would defeat the point of field-level acceptance.',
      },
      lineage: {
        type: 'array',
        items: { type: 'string' },
        description:
          'The hashes of the ancestors you can actually produce, for accept_block. A block naming an ' +
          'ancestor outside this list is refused rather than re-rooted.',
      },
    },
    output: jsonOutput,
    async execute(args, exec) {
      throwIfAborted(exec?.signal);

      /**
       * v1.2.2: append records to the shared memory under compare-and-swap.
       *
       * A 409 is returned AS-IS, with the revision and what the caller has not read. Retrying here would turn a visible
       * conflict into a silent overwrite, which is the whole reason the relay keeps a revision instead of merging.
       */
      if (typeof args?.action === 'string' && args.action === 'append') {
        const doc = typeof args?.scope === 'string' && args.scope.trim() !== '' ? args.scope.trim() : 'fleet';
        const incoming = Array.isArray(args?.records)
          ? args.records
          : (typeof args?.records === 'string' ? [args.records] : []);
        const records = incoming.filter((entry) => typeof entry === 'string' && entry.trim() !== '');
        if (records.length === 0) {
          throw new W2MError('W2M_MEMORY_APPEND', 'W2M_MEMORY_APPEND: records is required for append', {
            hint: 'pass records: ["a fact the fleet should keep", ...]',
          });
        }
        const appendUrl = cfg.rabbitUrl ?? null;
        if (appendUrl === null) {
          throw new W2MError('W2M_NO_RELAY', 'W2M_NO_RELAY: no relay is configured, so shared memory cannot be written', {
            hint: 'set rabbitUrl in the profile patch',
          });
        }
        const appendToken = await resolveToken(cfg);
        if (appendToken === null) {
          throw new W2MError('W2M_NO_TOKEN', 'W2M_NO_TOKEN: this machine has no device token, so shared memory cannot be written', {
            hint: 'pair this machine first, then retry',
          });
        }
        const appendBody = { records };
        if (Number.isInteger(args?.if_revision)) appendBody.if_revision = args.if_revision;
        const appended = await request({
          rabbitUrl: appendUrl,
          token: appendToken,
          method: 'PUT',
          pathname: '/v1/fleet/memory/' + encodeURIComponent(doc),
          body: appendBody,
          signal: exec?.signal,
        });
        if (appended?.ok !== true) {
          return JSON.stringify({
            ok: false,
            action: 'append',
            doc,
            status: appended?.status ?? 0,
            code: appended?.json?.error?.code ?? appended?.error?.code ?? 'W2M_MEMORY_APPEND',
        // v1.2.11: turn the 409's numbers into the next step a reader can actually take.
        merge_hint: renderMergeHint({ conflict: appended?.json?.detail ?? appended?.json?.error?.detail ?? null }),
            detail: appended?.json?.detail ?? null,
          });
        }
        return JSON.stringify({
          ok: true,
          action: 'append',
          doc,
          revision: appended.json?.revision ?? null,
          appended: appended.json?.appended ?? 0,
        });
      }

      /**
       * v1.0.7 (#1c): publish the collective memory as a content-addressed blob.
       *
       * ## Why this exists at all
       *
       * The blob channel (1a/1b) is a route and a store; **without a caller it is the same defect as the seven
       * written-but-unreachable modules this repository keeps an accepted-orphans list for.** This is the caller:
       * a machine that wants its curated memory to be fetchable by its own fleet says so, and gets back the hash
       * that names it.
       *
       * ## Why it reads the file and does not rewrite it
       *
       * Publishing is a **copy, not a move**. If it deleted or normalised the file, the only durable copy of what
       * this machine knows would depend on the relay having accepted it -- and the relay is explicitly not the
       * durable store (`storage.mjs`: each machine's `memory.jsonl` is the only copy of what a command printed).
       *
       * ## Why a missing file is a named refusal
       *
       * `putBlob` rejects an empty body with `BLOB_EMPTY`, which is correct but arrives too late to say anything
       * useful. A machine with no `fleet-memory.md` has not published anything yet -- that is a state, not a
       * protocol violation, and the message should say which file is missing and where it was looked for.
       */
if (typeof args?.action === 'string' && ['publish', 'latest', 'pull', 'diff', 'merge'].includes(args.action)) {
throw new W2MError('MEMORY_SYNC_UNAVAILABLE', 'MEMORY_SYNC_UNAVAILABLE: relay blob endpoints are retired in 1.9.2; a data-plane sink is required (1.9.3)', {
hint: 'the local fleet-memory.md is unchanged; action read/show still reads local memory',
});
}

      if (typeof args?.action === 'string' && args.action === 'publish') {
        const file = collectivePath();
        if (file === null) {
          throw new W2MError('W2M_CONFIG', 'W2M_CONFIG: there is no profile to publish collective memory from', {
            hint: 'the collective layer lives beside the profile that mounted this plugin; set `stateDir` or run '
              + 'with a profile',
          });
        }
        let bytes;
        try {
          // `fs` is `promises as fs` in this file (line 93), so this is the promise API -- a bare `readFile` is not
          // in scope and would throw ReferenceError at the exact moment the caller wanted to publish.
          bytes = await fs.readFile(file);
        } catch {
          // The error object is deliberately not bound: every refusal of a read here is the same refusal (there is
          // no document at that path), and naming the errno would tell the caller to debug a filesystem this plugin
          // does not own.
          throw new W2MError(
            'W2M_NOT_FOUND',
            `W2M_NOT_FOUND: no collective memory to publish at ${file}`,
            { hint: 'write measured facts to it first; publishing copies the file, it does not create one' },
          );
        }
        const hash = createHash('sha256').update(bytes).digest('hex');
        const base = requireRabbit(cfg);
        const token = await resolveToken(cfg);
        const result = await request({
          rabbitUrl: base,
          token,
          method: 'PUT',
          pathname: `/v1/fleet/blobs/${hash}`,
          rawBody: bytes,
          signal: exec?.signal,
        });
        return JSON.stringify({
          ok: true,
          published: true,
          hash,
          bytes: bytes.length,
          file,
          relay: {
            http_status: result.status,
            // `request()` returns `{status, ok, json, text, error}` -- the parsed body is `json`, not `body`.
            evicted: result.json?.evicted ?? [],
          },
          next: 'another machine in the same fleet can GET ' + `/v1/fleet/blobs/${hash}` + ' to fetch it',
        });
      }

      /**
       * v1.0.7 (#1d, the other direction): fetch one blob by the hash that names it.
       *
       * ## Why this had to exist before the channel was called finished
       *
       * A `publish` with no `pull` is a backup, not a channel: the bytes leave the machine and nothing can bring
       * them back through the tool surface. The relay route existed and was tested, and the plugin could still only
       * write -- which is the same "half a mechanism" shape the whole 1a-1d sequence was organised to avoid.
       *
       * ## Why the reader re-hashes instead of trusting the relay
       *
       * The relay verifies `sha256(body) === key` on write, so in principle what comes back is what was stored. **A
       * reader must not depend on that.** The hash is the only thing that makes the bytes a claim rather than an
       * assertion, and a verification performed only by the party that could be wrong is not a verification. So the
       * content is re-hashed here, and a mismatch is a failure rather than a warning -- accepting unverified bytes
       * under a name they do not match would make every later reader's check decorative too.
       */
      /**
       * v1.0.9: which blob this fleet published last -- **the discovery half of the channel**.
       *
       * Without it the channel only works if a human reads a 64-character hash off one machine and types it into
       * another, which is a demo rather than a sync.
       */
      if (typeof args?.action === 'string' && args.action === 'latest') {
        const base = requireRabbit(cfg);
        const token = await resolveToken(cfg);
        const pointer = await request({
          rabbitUrl: base,
          token,
          pathname: '/v1/fleet/blobs/latest',
          signal: exec?.signal,
        });
        if (pointer.status === 404) {
          throw new W2MError(
            'W2M_NOT_FOUND',
            'W2M_NOT_FOUND: this fleet has published no blob yet',
            { hint: 'run `action: "publish"` on a machine in this fleet first' },
          );
        }
        if (pointer.status !== 200) {
          throw new W2MError(
            'W2M_RABBIT_REFUSED',
            `W2M_RABBIT_REFUSED: GET /v1/fleet/blobs/latest answered HTTP ${pointer.status}`,
            { http_status: pointer.status, detail: pointer.error ?? null },
          );
        }
        return JSON.stringify({
          ok: true,
          hash: pointer.json?.hash ?? null,
          bytes: pointer.json?.bytes ?? null,
          published_at: pointer.json?.published_at ?? null,
          published_by: pointer.json?.published_by ?? null,
          next: 'w2m_memory {"action":"pull","hash":"latest"} fetches it and verifies it against this hash',
        });
      }

      if (typeof args?.action === 'string' && args.action === 'pull') {
        let wanted = typeof args?.hash === 'string' ? args.hash.trim().toLowerCase() : '';
        const base = requireRabbit(cfg);
        const token = await resolveToken(cfg);
        /**
         * `"latest"` resolves the fleet pointer first.
         *
         * **The pointer is trusted only to name a hash; the bytes are still verified against that hash.** Resolving
         * must not weaken the re-hash below, or the pointer becomes the thing trusted instead of the content -- and
         * a pointer is metadata, which is exactly what a relay is allowed to be wrong about.
         */
        let viaLatest = false;
        if (wanted === 'latest') {
          viaLatest = true;
          const pointer = await request({
            rabbitUrl: base,
            token,
            pathname: '/v1/fleet/blobs/latest',
            signal: exec?.signal,
          });
          if (pointer.status === 404) {
            throw new W2MError(
              'W2M_NOT_FOUND',
              'W2M_NOT_FOUND: this fleet has published no blob to follow',
              { hint: 'publish from a machine in this fleet first, or pass an explicit hash' },
            );
          }
          if (pointer.status !== 200) {
            throw new W2MError(
              'W2M_RABBIT_REFUSED',
              `W2M_RABBIT_REFUSED: GET /v1/fleet/blobs/latest answered HTTP ${pointer.status}`,
              { http_status: pointer.status, detail: pointer.error ?? null },
            );
          }
          wanted = String(pointer.json?.hash ?? '');
        }
        if (!/^[0-9a-f]{64}$/.test(wanted)) {
          throw new W2MError(
            'W2M_CONFIG',
            'W2M_CONFIG: `action: "pull"` needs `hash` -- 64 lowercase hex characters, or the word "latest"',
            { hint: 'the hash is what `action: "publish"` returned, and "latest" follows this fleet\'s own pointer' },
          );
        }
        const result = await request({
          rabbitUrl: base,
          token,
          pathname: `/v1/fleet/blobs/${wanted}`,
          accept: 'application/octet-stream',
          signal: exec?.signal,
        });
        if (result.status === 404) {
          // Deliberately the same answer for "never stored" and "another fleet's": see the `hash` parameter note.
          throw new W2MError(
            'W2M_NOT_FOUND',
            `W2M_NOT_FOUND: no blob named ${wanted} is readable by this machine`,
            {
              hint: 'the hash may belong to another fleet, or the relay may have evicted it -- blobs are evicted '
                + 'oldest-first once a fleet holds 256',
            },
          );
        }
        if (result.status !== 200) {
          throw new W2MError(
            'W2M_RABBIT_REFUSED',
            `W2M_RABBIT_REFUSED: GET /v1/fleet/blobs/${wanted} answered HTTP ${result.status}`,
            { http_status: result.status, detail: result.error ?? null },
          );
        }
        const body = result.text ?? '';
        const actual = createHash('sha256').update(body, 'utf8').digest('hex');
        if (actual !== wanted) {
          throw new W2MError(
            'W2M_BAD_BLOB',
            `W2M_BAD_BLOB: the bytes returned for ${wanted} hash to ${actual} instead`,
            {
              hint: 'the reader refuses unverified content rather than passing it on; nothing was written locally',
              expected: wanted,
              actual,
            },
          );
        }
        return JSON.stringify({
          ok: true,
          pulled: true,
          hash: wanted,
          via_latest: viaLatest,
          bytes: Buffer.byteLength(body, 'utf8'),
          verified: true,
          content: body,
        });
      }

      /**
       * v1.0.10 (#2a): **compare** this machine's collective memory against the fleet's current blob. Writes nothing.
       *
       * ## Why this exists before merge does
       *
       * "Merge" needs a conflict rule -- *when two machines assert different facts, who wins?* -- and that is a
       * product decision, not an implementation detail. Shipping a merge before its rule is how a fleet silently
       * loses one machine's memory.
       *
       * What needs no decision is the half that **prevents harm**: telling a caller whether their local document is
       * the newest one, and what would be lost if they published over the fleet's copy. That is this action.
       *
       * ## Why a set comparison instead of a diff
       *
       * `same` is decided by **whole-document hash equality**, not by the absence of line differences: two documents
       * with identical line sets in a different order are not the same, and reporting them as the same would hide an
       * order change. The line sets are then reported as `local_only` / `fleet_only` -- deliberately *not* a diff,
       * because a diff would report "moved" versus "changed" and then want a merge policy. **A set comparison cannot
       * resolve anything, which is the property this step needs.**
       *
       * ## Why it re-hashes the fleet copy
       *
       * Comparing unverified content would launder it: the report would give a hash-verified-looking answer about
       * bytes nobody checked. A blob that fails its own name is reported as unverified, never compared.
       */
      if (typeof args?.action === 'string' && args.action === 'diff') {
        const file = collectivePath();
        if (file === null) {
          throw new W2MError('W2M_CONFIG', 'W2M_CONFIG: there is no profile to compare collective memory from', {
            hint: 'the collective layer lives beside the profile that mounted this plugin',
          });
        }
        let localBytes;
        try {
          localBytes = await fs.readFile(file);
        } catch {
          throw new W2MError('W2M_NOT_FOUND', `W2M_NOT_FOUND: no collective memory to compare at ${file}`, {
            hint: 'write measured facts to it first; this action compares, it does not create',
          });
        }
        const localHash = createHash('sha256').update(localBytes).digest('hex');
        const base = requireRabbit(cfg);
        const token = await resolveToken(cfg);

        const pointer = await request({
          rabbitUrl: base,
          token,
          pathname: '/v1/fleet/blobs/latest',
          signal: exec?.signal,
        });
        if (pointer.status === 404) {
          // No fleet document yet: nothing to differ from. Reported as a state, not as an error.
          return JSON.stringify({
            ok: true,
            same: false,
            local: { hash: localHash, bytes: localBytes.length, file },
            fleet: { present: false, reason: 'this fleet has published no blob yet' },
            merged: false,
            wrote_anything: false,
          });
        }
        if (pointer.status !== 200) {
          throw new W2MError(
            'W2M_RABBIT_REFUSED',
            `W2M_RABBIT_REFUSED: GET /v1/fleet/blobs/latest answered HTTP ${pointer.status}`,
            { http_status: pointer.status, detail: pointer.error ?? null },
          );
        }
        const fleetHash = String(pointer.json?.hash ?? '');
        const fleetRes = await request({
          rabbitUrl: base,
          token,
          pathname: `/v1/fleet/blobs/${fleetHash}`,
          accept: 'application/octet-stream',
          signal: exec?.signal,
        });
        if (fleetRes.status === 404) {
          // The pointer is a hint (see #3): eviction can take the document it names.
          return JSON.stringify({
            ok: true,
            same: false,
            local: { hash: localHash, bytes: localBytes.length, file },
            fleet: {
              present: false,
              pointed_at: fleetHash,
              reason: 'the pointer names a blob that no longer exists (oldest-first eviction)',
            },
            merged: false,
            wrote_anything: false,
          });
        }
        if (fleetRes.status !== 200) {
          throw new W2MError(
            'W2M_RABBIT_REFUSED',
            `W2M_RABBIT_REFUSED: GET /v1/fleet/blobs/${fleetHash} answered HTTP ${fleetRes.status}`,
            { http_status: fleetRes.status, detail: fleetRes.error ?? null },
          );
        }
        const fleetText = fleetRes.text ?? '';
        const fleetActual = createHash('sha256').update(fleetText, 'utf8').digest('hex');
        if (fleetActual !== fleetHash) {
          throw new W2MError(
            'W2M_BAD_BLOB',
            `W2M_BAD_BLOB: the fleet blob ${fleetHash} hashes to ${fleetActual} instead`,
            {
              hint: 'refusing to compare unverified content -- a comparison over bytes nobody checked would '
                + 'launder them',
              expected: fleetHash,
              actual: fleetActual,
            },
          );
        }

        const localText = localBytes.toString('utf8');
        // Trailing whitespace only: leading whitespace is markdown structure, not noise.
        const norm = (text) => new Set(text.split('\n').map((line) => line.replace(/\s+$/, '')));
        const localLines = norm(localText);
        const fleetLines = norm(fleetText);
        const localOnly = [...localLines].filter((line) => !fleetLines.has(line));
        const fleetOnly = [...fleetLines].filter((line) => !localLines.has(line));
        return JSON.stringify({
          ok: true,
          same: localHash === fleetHash,
          local: { hash: localHash, bytes: localBytes.length, lines: localLines.size, file },
          fleet: {
            present: true,
            hash: fleetHash,
            bytes: Buffer.byteLength(fleetText, 'utf8'),
            lines: fleetLines.size,
            published_at: pointer.json?.published_at ?? null,
            published_by: pointer.json?.published_by ?? null,
          },
          differing_lines: localOnly.length + fleetOnly.length,
          preview: {
            local_only: localOnly.slice(0, 20),
            fleet_only: fleetOnly.slice(0, 20),
            truncated: localOnly.length > 20 || fleetOnly.length > 20,
          },
          merged: false,
          wrote_anything: false,
          note: 'a comparison only. Merge has no conflict rule yet, so nothing is resolved and nothing is written.',
        });
      }

      /**
       * v1.0.11 (#2b): merge this machine's collective memory with the fleet's current blob, **under the operator's
       * rule**, and still write nothing.
       *
       * ## The rule (the operator's, quoted)
       *
       * > 默认最新的赢；如果是修复默认流程，最全 & 验证最全面的有最后修改权。
       *
       * The two layers are implemented in `src/plugin/fleet-merge.mjs`: newest publication wins by default, and a
       * declared repair of the default flow outranks recency. **The operationalisation is that module's; this branch
       * only supplies the inputs.**
       *
       * ## Why the result is returned rather than written
       *
       * The local file is this machine's only copy, and half of a merge's input arrived over the network. **Letting
       * one round trip rewrite it would hand a remote party a write into local memory.** So the merged text comes
       * back in the result, decisions and all, and the caller decides.
       *
       * ## Recency inputs, named
       *
       * `localAddedAtMs` is the file's mtime; `fleetAddedAtMs` is the relay's `published_at` for the pointer's blob.
       * Both are compared as milliseconds. **Neither is a claim about content** -- which is exactly why they are only
       * the tie-break of last resort under the default layer.
       */
      if (typeof args?.action === 'string' && args.action === 'merge') {
        const file = collectivePath();
        if (file === null) {
          throw new W2MError('W2M_CONFIG', 'W2M_CONFIG: there is no profile to merge collective memory from', {
            hint: 'the collective layer lives beside the profile that mounted this plugin',
          });
        }
        let localBytes;
        let localStat;
        try {
          localBytes = await fs.readFile(file);
          localStat = await fs.stat(file);
        } catch {
          throw new W2MError('W2M_NOT_FOUND', `W2M_NOT_FOUND: no collective memory to merge at ${file}`, {
            hint: 'merge needs a local document; it compares against the fleet copy, it does not create one',
          });
        }
        const localHash = createHash('sha256').update(localBytes).digest('hex');
        const base = requireRabbit(cfg);
        const token = await resolveToken(cfg);

        const pointer = await request({ rabbitUrl: base, token, pathname: '/v1/fleet/blobs/latest', signal: exec?.signal });
        if (pointer.status === 404) {
          return JSON.stringify({
            ok: true, merged: false, wrote_anything: false,
            local: { hash: localHash, bytes: localBytes.length, file },
            reason: 'this fleet has published no blob yet, so there is nothing to merge with. Publishing comes first.',
          });
        }
        if (pointer.status !== 200) {
          throw new W2MError('W2M_RABBIT_REFUSED', `W2M_RABBIT_REFUSED: GET /v1/fleet/blobs/latest answered HTTP ${pointer.status}`, {
            http_status: pointer.status, detail: pointer.error ?? null,
          });
        }
        const fleetHash = String(pointer.json?.hash ?? '');
        const fleetRes = await request({
          rabbitUrl: base, token, pathname: `/v1/fleet/blobs/${fleetHash}`,
          accept: 'application/octet-stream', signal: exec?.signal,
        });
        if (fleetRes.status !== 200) {
          throw new W2MError('W2M_NOT_FOUND', `W2M_NOT_FOUND: the fleet pointer names ${fleetHash}, which answered HTTP ${fleetRes.status}`, {
            hint: 'the pointer is a hint (see #3); oldest-first eviction can remove the blob it names',
            prescribed: 'publish from a machine in this fleet to establish a current document again',
          });
        }
        const fleetText = fleetRes.text ?? '';
        const fleetActual = createHash('sha256').update(fleetText, 'utf8').digest('hex');
        if (fleetActual !== fleetHash) {
          throw new W2MError('W2M_BAD_BLOB', `W2M_BAD_BLOB: the fleet blob ${fleetHash} hashes to ${fleetActual} instead`, {
            hint: 'refusing to merge unverified content', expected: fleetHash, actual: fleetActual,
          });
        }

        const fleetPublishedAt = Date.parse(String(pointer.json?.published_at ?? ''));
        const outcome = mergeMemory({
          localText: localBytes.toString('utf8'),
          localAddedAtMs: Number.isFinite(localStat.mtimeMs) ? localStat.mtimeMs : 0,
          localHash,
          fleetText,
          fleetAddedAtMs: Number.isFinite(fleetPublishedAt) ? fleetPublishedAt : 0,
          fleetHash,
        });

        return JSON.stringify({
          ok: true,
          merged: true,
          wrote_anything: false,
          rule: 'default: newest publication wins; a declared repair of the default flow outranks recency, and between '
            + 'two repairs the one with the higher (evidence + 2 x verified) wins',
          local: { hash: localHash, bytes: localBytes.length, file, added_at_ms: Math.round(localStat.mtimeMs) },
          fleet: {
            hash: fleetHash, bytes: Buffer.byteLength(fleetText, 'utf8'),
            published_at: pointer.json?.published_at ?? null, published_by: pointer.json?.published_by ?? null,
          },
          decisions: outcome.decisions,
          unresolved: outcome.unresolved,
          refused: outcome.refused,
          unchanged: outcome.unchanged,
          added: outcome.added,
          removed: outcome.removed,
          merged_text: outcome.text,
          next: 'this result is text only. Writing it back is the caller\'s decision -- a merge does not edit the '
            + 'document it read.',
        });
      }

      const limitRaw = Number(args?.limit);
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 500) : 20;

      const requested = typeof args?.machine === 'string' && args.machine.trim() !== '' ? args.machine.trim() : null;
      const identity = await readLocalIdentity(cfg);
      const self = identity?.machine_name ?? null;
      const selfId = identity?.machine_id ?? null;

      /**
       * The collective layer, returned as the document it is.
       *
       * No parsing, on purpose. The file is written for a person -- facts with their evidence and the date
       * they were measured, decisions with the reasoning that produced them -- and a parser over prose
       * would silently drop whatever shape it did not expect. What it dropped would be exactly what a
       * human judged worth writing down, so the honest answer is the text plus where it came from.
       */
      if (args?.scope === 'fleet') {
        const file = collectivePath();
        let text = null;
        let error = null;
        if (file === null) {
          error = 'MEMORY_NO_COLLECTIVE';
        } else {
          try {
            text = await fs.readFile(file, 'utf8');
          } catch (readError) {
            error = readError?.code === 'ENOENT' ? 'MEMORY_NO_COLLECTIVE' : `MEMORY_READ_FAILED: ${readError?.code}`;
          }
        }
        const headings = text === null
          ? []
          : text.split('\n').filter((line) => /^#{1,3} /.test(line)).map((line) => line.replace(/^#+\s*/, '').trim());
        return JSON.stringify(
          {
            ok: true,
            scope: 'fleet',
            path: file,
            found: text !== null,
            bytes: text === null ? null : Buffer.byteLength(text, 'utf8'),
            // The section list is what makes a long document usable: a reader can see what the collective
            // memory covers without paying for the whole of it first.
            sections: headings,
            body: text,
            ...(error === null ? {} : { reason_code: error }),
            notes: [
              error === 'MEMORY_NO_COLLECTIVE'
                ? (file === null
                  ? 'no profile directory could be resolved, so the collective memory has no known location'
                  : `no collective memory at ${file}; it is written by hand on the archive host, and its absence means nothing has been curated there yet`)
                : null,
              'this document is curated, not generated: every fact in it should carry the date it was measured and how',
            ].filter((n) => n !== null),
          },
          null,
          2,
        );
      }

      /**
       * Recording a conclusion.
       *
       * The one field a machine may not write for itself. `memoryRecord` always emits `conclusion: null`
       * because a machine that invented one would be asserting an interpretation it cannot have; this is
       * the path by which a reader -- a person, or the agent acting on their instruction -- supplies it.
       *
       * Appended as a new record rather than by rewriting the existing line. The log is append-only, and
       * in-place editing would break the property that makes it trustworthy: what was written is what
       * happened, and an amendment is a later statement about it. Rewriting would also lose the original
       * text, which is the thing a reader most needs when a conclusion turns out to be wrong.
       */
      const conclusionText = typeof args?.record === 'string' && args.record.trim() !== '' ? args.record.trim() : null;
      /**
       * v0.41.0: accept a received cognitive block, field by field, driven by the authority model.
       *
       * ## Why the block is written as a ROW rather than into a structure of its own
       *
       * The memory file is JSONL rows with a \`kind\`. A conclusion is one kind; an accepted block is
       * another. Giving blocks their own file would mean two stores to read, two to rotate, and two
       * answers to "what does this machine remember" -- and the rotation in \`appendMemory\` already
       * handles the size problem a second store would be created to solve.
       *
       * ## Why an unset authority level REFUSES rather than accepting everything
       *
       * Field-level acceptance exists because a receiver should not adopt everything a sender asserts.
       * With no level there is no actor to judge, so accepting the block whole would be the exact
       * behaviour this mode was built to replace -- and it would look like success.
       */
      // Hoisted above both branches that write: block acceptance and the conclusion. One read of the
      // configured directory, so the two cannot disagree about where memory lives.
      const stateDirForRecord = cfg.stateDir ?? null;

      if (args?.accept_block !== undefined && args?.accept_block !== null) {
        if (stateDirForRecord === null) {
          return JSON.stringify({ ok: false, scope: 'local', reason_code: 'MEMORY_NO_STATE_DIR', detail: 'this plugin has no stateDir configured, so a block has nowhere to be accepted into' });
        }
        if (!Number.isInteger(args?.actor_authority)) {
          return JSON.stringify({
            ok: false,
            scope: 'local',
            reason_code: 'MEMORY_BLOCK_NO_AUTHORITY',
            detail: 'accept_block needs actor_authority as an integer 0..100; without a level there is no actor to judge the fields, and accepting the block whole is what field-level acceptance exists to prevent',
          });
        }
        const received = args.accept_block;
        const verified = verifyBlock(received);
        if (!verified.ok) {
          // A block that fails its own hash is refused entirely: field-level acceptance is about trust, and
          // there is nothing to trust about content that does not match what it claims to be.
          return JSON.stringify({ ok: false, scope: 'local', reason_code: verified.code, detail: verified.detail, verified: false });
        }
        const { accepted, refused, decisions } = acceptWithAuthority(
          received,
          { level: args.actor_authority, id: self },
          { accept: acceptBlock, ...(Array.isArray(args.lineage) ? { lineage: args.lineage } : {}) },
        );
        if (accepted === null) {
          // Refused as a whole -- a missing ancestor, most likely. Reported with the whole field list, because
          // "refused" without "why" is the failure this project keeps having to correct.
          return JSON.stringify({ ok: false, scope: 'local', reason_code: refused[0]?.why?.split(':')[0] ?? 'MEMORY_BLOCK_REFUSED', detail: refused[0]?.why ?? 'the block was refused', refused, decisions });
        }
        const row = {
          at: new Date().toISOString(),
          kind: 'block',
          machine_id: selfId,
          machine_name: self,
          // The block's own hash identifies what was accepted; the lineage it declared travels with the row, so
          // a reader can tell an accepted block from a fabricated one without re-deriving anything.
          block_hash: received.hash ?? null,
          lineage: Array.isArray(received.lineage) ? [...received.lineage] : [],
          accepted_by_level: args.actor_authority,
          accepted,
          accepted_fields: decisions.filter((d) => d.accepted).map((d) => d.field),
          // Refusals are stored, not discarded: "what did this machine decline to believe" is as much a part
          // of its memory as what it took, and the design's whole third test is about dissent surviving.
          refused_fields: decisions.filter((d) => !d.accepted).map((d) => ({ field: d.field, why: d.reason })),
        };
        const written = appendMemory(stateDirForRecord, row);
        return JSON.stringify({
          ok: written.ok === true,
          scope: 'local',
          recorded: written.ok === true,
          kind: 'block',
          block_hash: row.block_hash,
          accepted_fields: row.accepted_fields,
          refused_fields: row.refused_fields,
          accepted,
          decisions,
          path: written.path ?? null,
          reason_code: written.ok === true ? null : 'MEMORY_BLOCK_WRITE_FAILED',
          detail: written.ok === true
            ? `accepted ${row.accepted_fields.length} field(s) at level ${args.actor_authority}; ${row.refused_fields.length} omitted`
            : (written.error ?? 'the block could not be written'),
        });
      }

      if (conclusionText !== null) {
        if (stateDirForRecord === null) {
          return JSON.stringify(
            {
              ok: false,
              scope: 'local',
              reason_code: 'MEMORY_NO_STATE_DIR',
              detail: 'this plugin has no stateDir configured, so a conclusion has nowhere to be written',
            },
            null,
            2,
          );
        }
        const recent = readMemorySync(stateDirForRecord, { limit: 1 });
        const subject = recent.records[0] ?? null;
        const written = appendMemory(stateDirForRecord, {
          at: new Date().toISOString(),
          kind: 'conclusion',
          task_id: subject?.task_id ?? null,
          machine_id: selfId,
          machine_name: self,
          // The conclusion is about the record named by `task_id`; the fields below repeat enough of it
          // that a reader does not have to join two lines to know what is being talked about.
          about: subject === null
            ? null
            : { argv: subject.argv ?? null, exit_code: subject.exit_code ?? null, at: subject.at ?? null },
          conclusion: conclusionText,
          tags: [],
        });
        return JSON.stringify(
          {
            ok: written.ok === true,
            scope: 'local',
            recorded: written.ok === true,
            task_id: subject?.task_id ?? null,
            conclusion: conclusionText,
            path: written.ok === true ? written.path : null,
            ...(written.ok === true ? {} : { reason_code: written.error }),
            notes: [
              subject === null
                ? 'no task has been recorded here yet, so this conclusion names no task; it is still kept, with about: null'
                : `recorded against task ${subject.task_id}`,
              'appended, never rewritten: the original record is left as it was written',
            ],
          },
          null,
          2,
        );
      }

      // A query about another machine is answered honestly rather than with an empty list, which would
      // read as "that machine has done nothing" -- the opposite conclusion from "this build cannot see".
      if (requested !== null && requested !== self && requested !== selfId) {
        return JSON.stringify(
          {
            ok: true,
            scope: 'remote',
            requested_machine: requested,
            self: { machine_id: selfId, machine_name: self },
            records: null,
            reason_code: 'MEMORY_REMOTE_NOT_READABLE',
            detail:
              `the individual memory of "${requested}" is kept on that machine, in its own state ` +
              'directory as memory.jsonl; this build reads only the local file, and the relay never ' +
              'receives it',
            how_to_read_it: [
              `run \`w2m_run\` on ${requested} with a command that prints the tail of its memory.jsonl`,
              'or read it directly over an administration channel to that machine',
            ],
            found: false,
          },
          null,
          2,
        );
      }

      const stateDir = cfg.stateDir ?? null;
      if (stateDir === null) {
        return JSON.stringify(
          {
            ok: true,
            scope: 'local',
            machine_id: selfId,
            machine_name: self,
            records: null,
            reason_code: 'MEMORY_NO_STATE_DIR',
            detail: 'this plugin has no stateDir configured, so there is nowhere the memory log would be',
            found: false,
          },
          null,
          2,
        );
      }

      const current = readMemorySync(stateDir, { limit });
      const previous = args?.include_previous === true ? readMemorySync(stateDir, { limit, previous: true }) : null;

      /**
       * A small summary before the records themselves.
       *
       * The question that sent someone here is usually "have we run this before, and did it work", and a
       * count answers it faster than reading twenty lines. The counts are of the records *returned*, not
       * of the whole file, and that is stated -- a summary that silently described a different set than
       * the one shown is how a reader learns to distrust the summary.
       */
      const tally = (records) => {
        const by = {};
        for (const r of records ?? []) {
          const key = r?.status ?? 'unknown';
          by[key] = (by[key] ?? 0) + 1;
        }
        return by;
      };

      return JSON.stringify(
        {
          ok: true,
          scope: 'local',
          machine_id: selfId,
          machine_name: self,
          state_dir: stateDir,
          memory_path: current.path,
          found: current.path !== null && (current.records.length > 0 || previous !== null),
          count: current.records.length,
          skipped_lines: current.skipped,
          truncated: current.truncated,
          status_tally: tally(current.records),
          records: current.records,
          view: renderMemoryView(current.records),
          ...(previous === null
            ? {}
            : {
                previous: {
                  path: previous.path,
                  count: previous.records.length,
                  skipped_lines: previous.skipped,
                  status_tally: tally(previous.records),
                  records: previous.records,
                },
              }),
          notes: [
            current.path === null
              ? 'no memory has been written here yet: the log is created when a task finishes'
              : null,
            current.skipped > 0
              ? `${current.skipped} line(s) could not be parsed and were skipped; a partially written final line is the expected cause`
              : null,
            'conclusion is null until something records what a result meant; the machine only stores the fact',
            'the relay keeps hashes and never this text, so this file is the only durable copy of the output',
          ].filter((n) => n !== null),
        },
        null,
        2,
      );
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `w2m memory${typeof args?.machine === 'string' ? ` ${args.machine}` : ''}`,
      kind: 'read',
      rawInput: {},
    }),
  }));
}

  /**
   * v1.1.17: fleet chat, one session at a time. The text never travels over the notification stream -- this tool reads
   * it through the endpoint that checks who is asking, and the author of a sent message is the token holder.
   */
export function registerChat(ctx, deps) {
  const { askStore, cfg, defineTool, jsonOutput } = deps;
  ctx.tools.register(defineTool({
    name: 'w2m_chat',
    description:
      'Fleet chat for one session: send plain text to the machines in this conversation, or read what was said. ' +
      'A refused write comes back with its named reason (quota, size, or non-text) rather than as a bare failure.',
    parameters: {
      action: {
        type: 'string',
        enum: ['send', 'list', 'ask', 'await', 'asks'],
        description: 'send posts text; ask posts a question and returns its message id; await waits for a reply to it; list reads the flow (default).',
        default: 'list',
      },
      session_id: { type: 'string', description: 'Which conversation. Chat is scoped to a session, not a machine.' },
      text: { type: 'string', description: 'The message for send. Plain text, UTF-8, at most 4 KiB.' },
      since_ms: { type: 'number', description: 'For list: only messages newer than this relay timestamp.' },
      limit: { type: 'number', description: 'For list: how many of the newest messages (default 50).' },
      to: { type: 'string', description: 'For send/ask: "all" (the fleet group, the default) or one machine_id.' },
      thread_id: { type: 'string', description: 'For send/ask: group this message into a named thread (at most 64 characters).' },
      reply_to: { type: 'string', description: 'For send/ask: the message_id this message answers. For await: the message_id to wait for a reply to.' },
      mentions: {
        type: 'array',
        items: { type: 'string' },
        description: 'For send/ask: machine ids to alert (at most 10). A mention is a notification hint, not a delivery mechanism -- the message still has one row.',
      },
      idempotency_key: {
        type: 'string',
        description: 'For send/ask: replay protection. A retry with the same key returns the first message instead of posting the same sentence twice.',
      },
      reply_state: {
        type: 'string',
        description: 'For send/ask: answer the turn as "answered" or "refused". A refusal is a state the awaiter reads, not a wording it has to guess from.',
      },
      timeout_ms: { type: 'number', description: 'For await: how long to wait before reporting a timeout (default 60000, capped at 300000). A timeout is a value, not an error.' },
    },
    output: jsonOutput,
    presentCall: (args) => ({ card: 'generic', title: 'w2m chat ' + (typeof args?.action === 'string' ? args.action : 'list'), kind: args?.action === 'send' ? 'write' : 'read', rawInput: {} }),
    async execute(args, exec) {
      throwIfAborted(exec?.signal);
      const action = typeof args?.action === 'string' ? args.action : 'list';
      const sessionId = typeof args?.session_id === 'string' ? args.session_id.trim() : '';
      if (sessionId === '') throw new W2MError('W2M_CHAT_SESSION', 'W2M_CHAT_SESSION: session_id is required', { hint: 'chat is scoped to a conversation' });
      // v1.2.7: expire stale turns on every entry, so `asks` reports the truth after downtime.
      askStore.expireDue();
      if (action === 'asks') {
        // The persisted questions for this conversation, in the states they are in. A read, so it needs no relay.
        return JSON.stringify({ ok: true, action, session_id: sessionId, ...askStore.list({ sessionId }) });
      }
      if (action === 'cursor') {
        const cursors = await readChatCursors(cfg.stateDir);
        return JSON.stringify({ ok: true, action, session_id: sessionId, cursor: Object.prototype.hasOwnProperty.call(cursors, sessionId) ? cursors[sessionId] : null, spool_count: (await readChatSpool(cfg.stateDir)).length });
      }
      const rabbitUrl = cfg.rabbitUrl ?? null;
      if (rabbitUrl === null) throw new W2MError('W2M_NO_RELAY', 'W2M_NO_RELAY: no relay is configured, so chat cannot be reached', { hint: 'set rabbitUrl in the profile patch' });
      // resolveToken, not readDevice: readDevice returns an empty identity whenever `stateDir` is
      // unset, even though this machine's device.json exists at the default DSH_HOME path — every
      // other device-authenticated tool goes through resolveToken for exactly that reason, and this
      // one reported W2M_NO_TOKEN on a machine that was paired and answering every other call.
      const token = await resolveToken(cfg);
      if (token === null) throw new W2MError('W2M_NO_TOKEN', 'W2M_NO_TOKEN: this machine has no device token, so chat cannot be authenticated', { hint: 'pair this machine first (autoStartAgent or a pairing code), then retry' });
      const stateDir = typeof cfg.stateDir === 'string' ? cfg.stateDir : '';
      // v1.2.6 reliability: try to deliver what the last unreachable attempt had to leave behind, before doing anything else.
      let spool = await readChatSpool(stateDir);
      let spoolDelivered = 0;
      if (spool.length > 0) {
        const remaining = [];
        for (const entry of spool) {
          try {
            const replayed = await request({ rabbitUrl, token, signal: exec?.signal, method: 'POST', pathname: '/v1/fleet/messages', body: entry.body });
            if (replayed?.ok === true) { spoolDelivered += 1; continue; }
          } catch { /* still unreachable: keep it for next time */ }
          remaining.push(entry);
        }
        spool = remaining;
        await writeChatSpool(stateDir, spool);
      }
      // Addressing + correlation travel only when the caller supplied them, so a plain broadcast stays byte-identical.
      const addressing = {};
      if (typeof args?.to === 'string' && args.to.trim() !== '') {
        const to = args.to.trim();
        if (to !== 'all' && (to.length > 64 || /\s/.test(to))) {
          throw new W2MError('W2M_CHAT_ADDRESS', 'W2M_CHAT_ADDRESS: to must be "all" or a machine id', { hint: 'a recipient is either the whole fleet or one machine listed by w2m_devices' });
        }
        addressing.to = to;
      }
      if (typeof args?.thread_id === 'string' && args.thread_id.trim() !== '') addressing.thread_id = args.thread_id.trim().slice(0, 64);
      if (typeof args?.reply_to === 'string' && args.reply_to.trim() !== '') addressing.reply_to = args.reply_to.trim();

      if (action === 'await') {
        // v1.2.7: waiting is a persisted turn, not a poll loop.
        //
        // The question is written to the ask store when it is ASKED; await attaches to that record, so a restart in between
        // does not lose the question or turn a late answer into silence. The event stream is tried first (the reply arrives
        // when it is posted, not up to a poll interval later), and polling remains the fallback for a relay or proxy that
        // cannot stream -- an old relay must not break awaiting.
        const target = typeof args?.reply_to === 'string' ? args.reply_to.trim() : '';
        if (target === '') throw new W2MError('W2M_CHAT_AWAIT', 'W2M_CHAT_AWAIT: reply_to is required for await', { hint: 'pass reply_to: <message_id of the question>' });
        const timeoutMs = Number.isFinite(args?.timeout_ms) ? Math.max(1000, Math.min(args.timeout_ms, 300000)) : 60000;
        const startedAt = Date.now();
        askStore.expireDue();
        let turn = askStore.list({ sessionId }).asks.find((ask) => (ask.state === 'open' || ask.state === 'timeout') && ask.message_id === target) ?? null;
        if (turn === null) {
          const opened = askStore.openAsk({ sessionId, messageId: target, timeoutMs });
          turn = opened.ok === true ? opened.ask : null;
        }
        const ownMachineId = cfg.machineId ?? null;
        const findReply = async () => {
          const listed = await request({ rabbitUrl, token, signal: exec?.signal, method: 'GET', pathname: '/v1/fleet/messages', query: { session_id: sessionId, limit: 200 } });
          const rows = Array.isArray(listed?.json?.messages) ? listed.json.messages : [];
          return rows.find((message) => message.reply_to === target && message.machine_id !== ownMachineId) ?? null;
        };
        const finish = (replyMessage, via) => {
          const verdict = replyMessage?.reply_state === 'refused' ? 'refused' : 'answered';
          if (turn !== null) askStore.settle(turn.ask_id, verdict, { messageId: replyMessage?.message_id ?? null });
          const recorded = turn === null ? null : (askStore.list({ sessionId }).asks.find((ask) => ask.ask_id === turn.ask_id) ?? null);
          return JSON.stringify({ ok: true, action, state: verdict, via, reply_to: target, reply: replyMessage, replies: replyMessage === null ? [] : [replyMessage], ask: recorded });
        };
        // 1) stream first -- and RE-subscribe while the budget remains: a dropped stream is not the end of the wait.
        let emptyStreams = 0;
        while (Date.now() - startedAt < timeoutMs) {
          const remaining = timeoutMs - (Date.now() - startedAt);
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), Math.min(remaining, 30000));
          let reachable = false;
          let gotEvent = false;
          try {
            const streamUrl = joinUrl(rabbitUrl, '/v1/fleet/messages/stream') + '?session_id=' + encodeURIComponent(sessionId);
            const response = await fetch(streamUrl, { headers: { authorization: 'Bearer ' + token }, signal: controller.signal });
            if (response.ok === true && response.body !== null) {
              reachable = true;
              const reader = response.body.getReader();
              const decoder = new TextDecoder();
              let buffer = '';
              for (;;) {
                const { value, done } = await reader.read();
                if (done === true) break;
                buffer += decoder.decode(value, { stream: true });
                const parts = buffer.split('\n\n');
                buffer = parts.pop() ?? '';
                for (const part of parts) {
                  const line = part.split('\n').find((entry) => entry.startsWith('data: '));
                  if (line === undefined) continue;
                  gotEvent = true;
                  const reply = await findReply();
                  if (reply !== null) return finish(reply, 'stream');
                }
              }
            }
          } catch (error) {
            if (error?.name === 'AbortError' && Date.now() - startedAt >= timeoutMs) break;
          } finally { clearTimeout(timer); }
          if (reachable !== true) break; // a relay that will not stream at all: polling is the contract
          emptyStreams = gotEvent === true ? 0 : emptyStreams + 1;
          if (emptyStreams >= 2) break; // two streams that end immediately will not deliver this reply
          await new Promise((resolve) => { setTimeout(resolve, 100); });
        }
        // 2) polling fallback
        for (;;) {
          throwIfAborted(exec?.signal);
          const reply = await findReply();
          if (reply !== null) return finish(reply, 'poll');
          if (Date.now() - startedAt >= timeoutMs) {
            if (turn !== null) askStore.expire(turn.ask_id);
            const recorded = turn === null ? null : (askStore.list({ sessionId }).asks.find((ask) => ask.ask_id === turn.ask_id) ?? null);
            return JSON.stringify({ ok: true, action, state: 'timeout', reply_to: target, waited_ms: Date.now() - startedAt, ask: recorded, hint: 'the question stays in the flow and can still be answered later' });
          }
          await new Promise((resolve) => { setTimeout(resolve, 1000); });
        }
      }
      if (action === 'send' || action === 'ask') {
        const mentions = Array.isArray(args?.mentions) ? args.mentions.filter((id) => typeof id === 'string' && id !== '') : [];
        /**
         * v1.2.6: the chat is end-to-end encrypted when a fleet key is available (configured, or derived from the account join).
         * Without one the tool keeps sending plaintext rather than refusing: a fleet that has not joined yet is a normal state,
         * and a silent refusal would read as a broken chat.
         */
        const chatKey = deriveChatKey(cfg.fleetKey ?? resolvedFleetKey.value ?? null);
        const plainText = typeof args?.text === 'string' ? args.text : '';
        const idempotencyKey = typeof args?.idempotency_key === 'string' && args.idempotency_key.trim() !== ''
          ? args.idempotency_key.trim()
          : 'spool-' + Date.now() + '-' + Math.random().toString(36).slice(2);
        // A7: v2 only when the relay advertises chat-enc-v2 AND this machine has an id to bind. Otherwise
        // send v1 (every relay accepts it) rather than an unverifiable v2 envelope.
        const canV2 = chatKey !== null && typeof cfg.machineId === 'string' && cfg.machineId !== ''
          && await chatEncV2Supported({ rabbitUrl: cfg.rabbitUrl ?? null });
        const sealed = chatKey === null
          ? null
          : (canV2
            ? encryptChatTextV2(chatKey, plainText, { sessionId, machineId: cfg.machineId, messageId: idempotencyKey })
            : encryptChatText(chatKey, plainText));
        /**
         * v1.2.6 reliability: an unreachable Rabbit does not lose the message. The exact body that could not be sent is
         * spooled to disk and replayed with the SAME idempotency key next time, so a message the relay actually received
         * before the connection died is not posted twice.
         */
        const messageBody = {
          session_id: sessionId,
          text: sealed !== null && sealed.ok === true ? sealed.text : plainText,
          ...(sealed !== null && sealed.ok === true ? { enc: sealed.enc } : {}),
          ...addressing,
          ...(mentions.length === 0 ? {} : { mentions }),
          ...{ idempotency_key: idempotencyKey },
            ...(typeof args?.reply_state === 'string' && (args.reply_state === 'answered' || args.reply_state === 'refused') ? { reply_state: args.reply_state } : {}),
        };
        let posted = null;
        try {
          posted = await request({ rabbitUrl, token, signal: exec?.signal, method: 'POST', pathname: '/v1/fleet/messages', body: messageBody });
        } catch (error) {
          if (error?.code === 'W2M_UNREACHABLE') {
            spool.push({ body: messageBody, created_at: new Date().toISOString() });
            await writeChatSpool(stateDir, spool);
            return JSON.stringify({ ok: true, action, spooled: true, spool_count: spool.length, encrypted: sealed !== null && sealed.ok === true });
          }
          throw error;
        }
        if (posted?.ok !== true) {
          const code = posted?.json?.error?.code ?? posted?.error?.code ?? 'W2M_CHAT_SEND';
          throw new W2MError('W2M_CHAT_SEND', code + ': the message was refused', { reason_code: code, hint: 'quota, size and non-text each need a different answer' });
        }
        let ask = null;
        if (action === 'ask' && posted.json?.message?.message_id !== undefined) {
          // v1.2.7: the question becomes a turn on disk the moment it is asked, so a later await (in this process or after a
          // restart) settles the same record instead of opening a second one.
          const opened = askStore.openAsk({
            sessionId,
            messageId: posted.json.message.message_id,
            threadId: typeof args?.thread_id === 'string' ? args.thread_id : null,
            to: typeof args?.to === 'string' ? args.to : null,
            timeoutMs: Number.isFinite(args?.timeout_ms) ? args.timeout_ms : 60000,
          });
          if (opened.ok === true) ask = opened.ask;
        }
        return JSON.stringify({
          ok: true, action, message: posted.json?.message ?? null, message_id: posted.json?.message?.message_id ?? null,
          encrypted: sealed !== null && sealed.ok === true,
          ...(ask === null ? {} : { ask }),
          ...(posted.json?.deduped === true ? { deduped: true } : {}),
        });
      }
      const query = { session_id: sessionId };
      // v1.2.6 reliability: continue where the last page ended, unless the caller asked for an explicit start.
      const cursors = await readChatCursors(stateDir);
      const storedCursor = Object.prototype.hasOwnProperty.call(cursors, sessionId) ? cursors[sessionId] : null;
      if (!Number.isFinite(args?.since_ms) && storedCursor !== null && Number.isFinite(storedCursor.at_ms)) query.since_ms = String(storedCursor.at_ms);
      if (typeof args?.thread_id === 'string' && args.thread_id.trim() !== '') query.thread_id = args.thread_id.trim();
      if (typeof args?.to === 'string' && args.to.trim() !== '') query.to = args.to.trim();
      if (Number.isFinite(args?.since_ms)) query.since_ms = String(args.since_ms);
      if (Number.isInteger(args?.limit)) query.limit = String(args.limit);
      const listed = await request({ rabbitUrl, token, signal: exec?.signal, method: 'GET', pathname: '/v1/fleet/messages', query });
      if (listed?.ok !== true) throw new W2MError('W2M_CHAT_LIST', 'W2M_CHAT_LIST: the relay refused the read', { hint: 'check the relay and this machine token' });
      const rawMessages = listed.json?.messages ?? [];
      /**
       * v1.2.6: a reader decrypts what its key covers and marks the rest. An undecryptable message keeps its ciphertext and its
       * reason instead of failing the page -- the relay is allowed to hold a message this machine cannot open.
       */
      const listKey = deriveChatKey(cfg.fleetKey ?? resolvedFleetKey.value ?? null);
      const messages = rawMessages.map((message) => {
        if (!isEncrypted(message)) return message;
        const opened = decryptChatMessage(listKey, message, { sessionId: String(query.session_id ?? message.session_id ?? ''), machineId: typeof message.machine_id === 'string' ? message.machine_id : undefined });
        if (opened.ok === true) return { ...message, text: opened.text, decrypted: true };
        return { ...message, text: '', decrypted: false, encrypted: true, decrypt_error: opened.code };
      });
      const encryptedCount = messages.filter((message) => message.encrypted === true || message.decrypted === true).length;
      // The cursor advances only over what was actually read, so a page that failed mid-way does not skip messages.
      const newestAt = messages.reduce((max, message) => (Number.isFinite(message?.at_ms) && message.at_ms > max ? message.at_ms : max), 0);
      let cursor = storedCursor;
      if (newestAt > 0 && (storedCursor === null || newestAt > storedCursor.at_ms)) {
        cursor = { at_ms: newestAt, message_id: messages.filter((message) => message.at_ms === newestAt)[0]?.message_id ?? null };
        await writeChatCursors(stateDir, { ...cursors, [sessionId]: cursor });
      }
      // v1.2.4: the page is annotated with turns derived from the relay's own numbering, so a reader does not have to order
      // replies by arrival time.
      const turns = deriveTurns(messages);
      return JSON.stringify({ ok: true, action, session_id: sessionId, messages, count: messages.length, encrypted_count: encryptedCount, cursor, spooled: spoolDelivered, turns: turns.threads ?? [], inferred_turns: turns.inferred_turns ?? [] });
    },
  }));
}

  /**
   * v1.2.2: structured intents -- the deterministic half of "say it in words, run it on the machine".
   *
   * The caller is the model, and it turns language into one of a CLOSED set of intents; this tool maps that intent to an
   * allow-listed argv or refuses it by name. Free text is deliberately not interpreted here: a remote machine runs an
   * allow-list, and a model inventing a command on its behalf is exactly what the list exists to stop.
   */
export function registerIntent(ctx, deps) {
  const { cfg, defineTool, jsonOutput } = deps;
  ctx.tools.register(defineTool({
    name: 'w2m_intent',
    description:
      'Map a structured intent to an allow-listed command. Actions: run-tests, node-version, git-status, git-head, ' +
      'fleet-facts, shard-probe. Unknown actions and unknown parameters are refused by name rather than guessed, and a ' +
      'command the machine allow-list does not carry is refused with the list it checked.',
    parameters: {
      action: { type: 'string', description: 'The catalog action; call with action:"list" to read the catalog.' },
      params: {
        type: 'object',
        additionalProperties: true,
        description: 'Action parameters, for example { n: 3 } for shard-probe.',
      },
    },
    output: jsonOutput,
    presentCall: (args) => ({ card: 'generic', title: 'w2m intent ' + (typeof args?.action === 'string' ? args.action : '?'), kind: 'read', rawInput: {} }),
    async execute(args, exec) {
      throwIfAborted(exec?.signal);
      const action = typeof args?.action === 'string' ? args.action.trim() : '';
      if (action === '' || action === 'list') {
        return JSON.stringify({ ok: true, action: 'list', intents: listIntents() });
      }
      const resolved = resolveIntent({ action, params: args?.params }, { allowedCommands: cfg.allowedCommands ?? null });
      if (resolved.ok !== true) {
        return JSON.stringify({ ok: false, action, code: resolved.code, detail: resolved.detail ?? null, hint: resolved.hint });
      }
      return JSON.stringify({ ok: true, action, argv: resolved.argv, command: resolved.command, risk: resolved.risk });
    },
  }));
}
