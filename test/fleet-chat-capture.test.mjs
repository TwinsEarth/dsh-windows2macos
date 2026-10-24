/**
 * v1.6.10 guard for the fleet-chat transcript controls.
 *
 * Three user-visible promises, each a shape in the emitted client bundle:
 *   1. a screenshot button exists in the chat panel,
 *   2. Ctrl+P (Cmd+P on macOS) captures while the panel is open and prevents the browser print dialog,
 *   3. the transcript is selectable text (and each message offers a copy button).
 *
 * These are UI assertions, so the test reads the client source rather than mounting React: the bundle
 * test already proves the module evaluates, and this one proves the controls were not dropped.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const client = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8');

describe('fleet chat transcript controls (v1.6.10)', () => {
  it('offers a screenshot button that captures a picked screen', () => {
    assert.match(client, /w2mChat_shotButton/, 'the compose row must carry the screenshot button');
    assert.match(client, /getDisplayMedia/, 'capture must use the platform picker, not a silent grab');
    assert.match(client, /toBlob\(resolve, 'image\/png'\)/, 'the captured frame must be encoded as PNG');
    assert.match(client, /ClipboardItem\(\{ 'image\/png': blob \}\)/, 'the screenshot must be copied as an image when the clipboard allows it');
    assert.match(client, /w2mChat_shotPreview/, 'a preview (and a download fallback) must be offered');
  });

  it('binds Ctrl+P / Cmd+P while the panel is open and suppresses the print dialog', () => {
    assert.match(client, /event\.key\)\.toLowerCase\(\) === 'p'/, 'the shortcut must match p case-insensitively');
    assert.match(client, /event\.ctrlKey === true \|\| event\.metaKey === true/, 'Ctrl on Windows/Linux and Cmd on macOS');
    assert.match(client, /captureScreenshot\(\);/, 'the shortcut must invoke the same capture path as the button');
    assert.match(client, /addEventListener\('keydown', onKeyDown, true\)/, 'the shortcut is registered in the capture phase');
  });

  it('keeps the transcript selectable and per-message copyable', () => {
    assert.match(client, /user-select:text/, 'the transcript must not be pointer-only');
    assert.match(client, /w2mChat_copy/, 'each message needs a copy affordance');
    assert.match(client, /const copyText = React\.useCallback/, 'copy goes through one helper with a fallback');
    assert.match(client, /window\.getSelection/, 'clicking a message while text is selected must not open a reply');
  });
});
