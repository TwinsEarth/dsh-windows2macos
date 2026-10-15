/**
 * The acceptance document's statuses, bound to the pre-flight that is supposed to enforce them.
 *
 * ## Why this exists
 *
 * `docs/1.0.0-ACCEPTANCE.md` §4 sorts every criterion into **ENFORCED** (the pre-flight goes red without it),
 * **MEASURED** (something checks and prints, the run stays green) or **UNVERIFIED**. That sorting is only
 * worth anything if it is true, and **a document restating what a check does is a second source of truth** —
 * this project has already paid for one of those, when `ROADMAP.md` carried three claims about shipping that
 * a single grep disproved.
 *
 * So the document's own load-bearing sentence — *"the pre-flight fails if this stops being true"* — is read
 * back out of the document and matched against `scripts/preflight.mjs`'s `DECLARED_CHECKS`. **A criterion
 * cannot quietly become unenforced while the file keeps claiming otherwise**, because the two are compared
 * here rather than trusted to agree.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DECLARED_CHECKS } from '../scripts/preflight.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DOC = readFileSync(resolve(HERE, '..', 'docs', '1.0.0-ACCEPTANCE.md'), 'utf8');

/** The pre-flight check names the document refers to by name, in its `The gate` and `Checked by` columns. */
export function namedChecks(text) {
  const found = new Set();
  for (const check of DECLARED_CHECKS) {
    // The document names a check by a distinctive fragment, not by its full parenthetical.
    const stem = check.split(' (')[0].trim();
    if (text.includes(stem)) found.add(check);
  }
  return [...found];
}

describe('acceptance document: the ENFORCED rows name checks that exist', () => {
  it('is about the pre-flight, not a parallel list beside it', () => {
    // The assertion that matters is the NEXT one -- that every gate the document names exists. This one only
    // checks it is engaged at all.
    //
    // The first two versions of it demanded `lint` and `mojibake`, and both were wrong: those are gates on the
    // CODE's tidiness and encoding, not criteria for what 1.0.0 must prove, so the document is right not to
    // list them. **Naming a check the document has no reason to cite is a test asserting its own assumption.**
    const named = namedChecks(DOC);
    assert.ok(named.length >= 5, `only ${named.length} pre-flight check(s) are named: ${named.join(' | ')}`);
    for (const must of ['packed tarball', 'claims']) {
      assert.ok(named.some((n) => n.includes(must)), `the document should name the ${must} check`);
    }
  });

  it('does not cite a source file as if it were a gate', () => {
    // A `.mjs` path is a thing the document may name freely; only backticked names that look like GATE names
    // are compared. The first version flagged `approval-gate.mjs` because the pattern matched the word "gate"
    // inside a filename -- the test was wrong, not the document.
    const cited = [...DOC.matchAll(/`([^`]+)`/g)]
      .map((m) => m[1])
      .filter((s) => !s.includes('.mjs') && !s.includes('/') && /\b(wiring|scan|suite|tarball|inventory|ledger|entry points|reachable or accepted|CHANGELOG shape)\b/.test(s));
    for (const c of cited) {
      const known = DECLARED_CHECKS.some((d) => d.includes(c) || c.includes(d.split(' (')[0].trim()));
      assert.ok(known, `the document cites \`${c}\` as a gate, and no declared check matches it`);
    }
  });

  it('defines all three statuses, so a reader can place any row', () => {
    for (const status of ['ENFORCED', 'MEASURED', 'UNVERIFIED']) {
      assert.match(DOC, new RegExp(`\\*\\*${status}\\*\\*`), `${status} is not defined in the document`);
    }
  });

  it('says how to tell MEASURED from ENFORCED, rather than leaving it to judgement', () => {
    // The one sentence the whole section rests on: a reader must be able to TEST the status, not interpret it.
    assert.match(DOC, /delete the thing and run `scripts\/preflight\.mjs`/);
    assert.match(DOC, /A check that cannot fail is a report/);
  });

  it('keeps the corrections section, because the pattern in it is the finding', () => {
    // Seven claims were written down and later disproved; four of them were about wiring or delivery. Tidying
    // the section away would remove the only evidence that this document's own claims get checked.
    const section = DOC.split('## 5. Claims this work corrected')[1] ?? '';
    assert.ok(section.length > 500, 'the corrections section is missing or emptied');
    const rows = section.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| Claim') && !l.startsWith('|---'));
    assert.ok(rows.length >= 7, `only ${rows.length} correction(s) survive; seven were made`);
  });

  it('records the two corrections the reachability work itself produced', () => {
    // Those two are the argument for the check: it was built BECAUSE the first claims had happened, and it
    // then found more. If either row is dropped the argument loses its evidence.
    assert.match(DOC, /the connection now exists/);
    assert.match(DOC, /FIELD-AUTHORITY|field-authority/);
  });
});
