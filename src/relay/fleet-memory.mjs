/**
 * Shared fleet memory: an append-only record log with compare-and-swap.
 *
 * ## What this is for
 *
 * The fleet memory was read/publish only. Two machines writing meant last-writer-wins over a whole document, so a record
 * added by one could vanish because the other had an older copy. Here the unit of change is a RECORD and the guard is a
 * revision number: a writer says which revision it saw, and a stale one is refused with the current revision and a diff
 * summary instead of being applied on top of something it never read.
 *
 * ## Refusals are values
 *
 * `REVISION_CONFLICT` is a normal answer, not an error: the caller re-reads, decides, and retries. Automatic retry is
 * deliberately NOT implemented here -- retrying in the transport would turn a visible conflict into a silent overwrite.
 */
export class FleetMemoryConflict extends Error {}

/**
 * @param {{now?: () => number, maxRecords?: number}} [options]
 */
export function createFleetMemory(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const maxRecords = Number.isInteger(options.maxRecords) && options.maxRecords > 0 ? options.maxRecords : 10_000;
  /** doc -> { revision, records: [{ at_ms, author_machine_id, text }] } */
  const docs = new Map();

  const stateOf = (doc) => docs.get(doc) ?? { revision: 0, records: [] };

  /**
   * @param {string} doc
   * @returns {{ok: true, revision: number, records: object[], count: number}}
   */
  function get(doc) {
    const state = stateOf(doc);
    return { ok: true, revision: state.revision, records: state.records.map((r) => ({ ...r })), count: state.records.length };
  }

  /**
   * Append records, guarded by the revision the caller saw.
   *
   * @param {{doc: string, if_revision?: number|null, author_machine_id: string, records: string[]}} input
   * @returns {{ok: true, revision: number, appended: number} |
   *           {ok: false, code: string, detail?: object}}
   */
  function append(input) {
    const doc = typeof input?.doc === 'string' && input.doc.trim() !== '' ? input.doc.trim() : null;
    if (doc === null) return { ok: false, code: 'BAD_DOC' };
    const author = typeof input?.author_machine_id === 'string' && input.author_machine_id !== '' ? input.author_machine_id : null;
    if (author === null) return { ok: false, code: 'BAD_AUTHOR' };
    const incoming = Array.isArray(input?.records) ? input.records : null;
    if (incoming === null) return { ok: false, code: 'NO_RECORDS' };
    const texts = incoming.filter((r) => typeof r === 'string' && r.trim() !== '');
    if (texts.length === 0) return { ok: false, code: 'NO_RECORDS' };
    if (texts.length !== incoming.length) return { ok: false, code: 'BAD_RECORD' };

    const state = stateOf(doc);
    const seen = Number.isInteger(input?.if_revision) ? input.if_revision : null;
    if (seen !== null && seen !== state.revision) {
      // The diff is what the caller needs to decide: how far ahead the document is, and what it has not read yet.
      const missing = state.records.slice(Math.max(0, seen < 0 ? 0 : seen));
      return {
        ok: false,
        code: 'REVISION_CONFLICT',
        detail: {
          if_revision: seen,
          revision: state.revision,
          behind_by: state.revision - seen,
          unread_records: missing.length,
          sample: missing.slice(0, 3).map((r) => ({ author: r.author_machine_id, text: r.text.slice(0, 80) })),
        },
      };
    }
    if (state.records.length + texts.length > maxRecords) {
      return { ok: false, code: 'MEMORY_FULL', detail: { count: state.records.length, maxRecords } };
    }

    const at = now();
    const added = texts.map((text) => ({ at_ms: at, author_machine_id: author, text }));
    const next = { revision: state.revision + 1, records: [...state.records, ...added] };
    docs.set(doc, next);
    return { ok: true, revision: next.revision, appended: added.length };
  }

  return { get, append, _docs: docs };
}
