/**
 * Patch artifact tests (M3, v1.3.10-beta.6 slice).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { describePatchArtifact, workspaceEvidence } from '../src/agent/patch-artifact.mjs';

const BASE = 'a'.repeat(40);
const PATCH = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-base\n+changed\n';

describe('patch artifact', () => {
  it('names the bytes by sha256 and records the base commit', () => {
    const artifact = describePatchArtifact({ patch: PATCH, baseCommit: BASE, headCommit: BASE, filesChanged: ['a.txt'] });
    assert.equal(artifact.ok, true);
    assert.equal(artifact.outcome, 'changed');
    assert.equal(artifact.baseCommit, BASE);
    assert.equal(artifact.bytes, Buffer.byteLength(PATCH, 'utf8'));
    assert.match(artifact.sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(artifact.filesChanged, ['a.txt']);
  });

  it('refuses a missing patch and an invalid base commit', () => {
    assert.equal(describePatchArtifact({ baseCommit: BASE }).code, 'PATCH_REQUIRED');
    assert.equal(describePatchArtifact({ patch: PATCH, baseCommit: 'not-a-commit' }).code, 'BASE_COMMIT_INVALID');
  });

  it('treats an empty patch as no_change rather than a failure', () => {
    const artifact = describePatchArtifact({ patch: '\n', baseCommit: BASE });
    assert.equal(artifact.ok, true);
    assert.equal(artifact.empty, true);
    assert.equal(artifact.outcome, 'no_change');
    assert.equal(artifact.sha256, null);
    const evidence = workspaceEvidence({ workspace: { cleaned: true }, patchArtifact: artifact });
    assert.deepEqual(evidence.artifacts, []);
  });

  it('marks blob output when the patch is too large to inline', () => {
    const artifact = describePatchArtifact({ patch: PATCH, baseCommit: BASE, outputMode: 'blob' });
    assert.equal(artifact.outputMode, 'blob');
    const evidence = workspaceEvidence({ workspace: { cleaned: true }, patchArtifact: artifact });
    assert.equal(evidence.artifacts[0].output_mode, 'blob');
    assert.equal(evidence.artifacts[0].sha256, artifact.sha256);
  });

  it('is byte-accurate for non-ASCII patches', () => {
    const unicode = 'diff --git a/x b/x\n+中文内容\n';
    const artifact = describePatchArtifact({ patch: unicode, baseCommit: BASE, outputMode: 'blob' });
    assert.equal(artifact.bytes, Buffer.byteLength(unicode, 'utf8'));
    assert.notEqual(artifact.bytes, unicode.length);
  });
});
