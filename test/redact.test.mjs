/**
 * Output redaction: both what it must catch, and the two properties that keep it honest -- structure survives, hashes do not
 * move.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { REDACTABLE_FIELDS, redactEnvelope, redactText } from '../src/util/redact.mjs';

describe('redactText', () => {
  it('replaces an API key in place, keeping the surrounding line', () => {
    const result = redactText('token: sk-abcdefghijklmnop1234\nsecond line');
    assert.equal(result.text, 'token: [redacted:api-key]\nsecond line');
    assert.deepEqual(result.replaced, [{ cls: 'api-key', count: 1 }]);
  });

  it('catches the classes the operator named', () => {
    for (const [text, cls] of [
      ['npm_abcdefghijklmnopqrstuvwxyz', 'api-key'],
      ['github_pat_abcdefghijklmnopqrstuvwxyz012345', 'api-key'],
      ['AKIAABCDEFGHIJKLMNOP', 'aws-key'],
    ]) {
      const result = redactText(text);
      assert.ok(result.text.includes('[redacted:' + cls + ']'), text);
      assert.equal(result.text.includes(text), false, 'the secret must be gone');
    }
  });

  it('replaces a whole private-key block and preserves the lines around it', () => {
    const text = 'before\n-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----\nafter';
    const result = redactText(text);
    assert.equal(result.text, 'before\n[redacted:private-key]\nafter');
  });

  it('leaves text with no secret untouched, and never throws on a non-string', () => {
    assert.deepEqual(redactText('just output'), { text: 'just output', replaced: [] });
    assert.deepEqual(redactText(null), { text: '', replaced: [] });
  });
});

describe('redactEnvelope', () => {
  const envelope = () => ({
    stdout_sha256: 'a'.repeat(64),
    stdout_bytes: 1000,
    stdout_head: 'secret sk-abcdefghijklmnop1234 here',
    stderr_tail: 'clean',
    status: 'ok',
  });

  it('filters the readable fields and names what it filtered', () => {
    const { envelope: out, redacted } = redactEnvelope(envelope());
    assert.equal(out.stdout_head, 'secret [redacted:api-key] here');
    assert.deepEqual(redacted, [{ field: 'stdout_head', cls: 'api-key', count: 1 }]);
    assert.equal(out.redacted.length, 1);
  });

  it('never touches the hashes or the byte count', () => {
    const input = envelope();
    const { envelope: out } = redactEnvelope(input);
    assert.equal(out.stdout_sha256, input.stdout_sha256);
    assert.equal(out.stdout_bytes, input.stdout_bytes);
    assert.deepEqual(Object.keys(out).filter((k) => REDACTABLE_FIELDS.includes(k)).sort(), ['stdout_head', 'stderr_tail'].sort().filter((k) => k in input));
  });

  it('marks the envelope unredacted when it is switched off, instead of silently doing nothing', () => {
    const { envelope: out } = redactEnvelope(envelope(), { enabled: false });
    assert.equal(out.stdout_head, 'secret sk-abcdefghijklmnop1234 here');
    assert.equal(out.unredacted, true);
  });
});
