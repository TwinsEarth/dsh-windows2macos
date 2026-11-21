/**
 * An independent, deliberately simple ZIP **writer** for the official-session-export fixture.
 *
 * ## Why this is not `src/backup/zip.mjs`
 *
 * The importer under test reads with the production reader. Building its fixture with the production
 * writer would make the test pass even if both shared the same misreading of the format (`write` and
 * `read` agreeing with each other is not the same as agreeing with the ZIP specification). This helper
 * writes the simplest legal container instead: **stored** entries (method 0, no deflate), a literal local
 * header + central directory + EOCD, and CRC-32 from Node's own `zlib.crc32`. The production writer emits
 * deflated entries, so the two implementations also cover both compression methods the reader claims.
 *
 * It is a test fixture, never shipped.
 */

import { crc32 } from 'node:zlib';

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/**
 * Build a stored (uncompressed) ZIP.
 *
 * @param {Array<{name: string, data: Buffer|string}>} entries
 * @returns {Buffer}
 */
export function writeStoredZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const item of entries) {
    const name = String(item.name).replace(/\\/g, '/');
    const nameBytes = Buffer.from(name, 'utf8');
    const data = Buffer.isBuffer(item.data) ? item.data : Buffer.from(String(item.data), 'utf8');
    const checksum = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBytes, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBytes);

    offset += local.length + nameBytes.length + data.length;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

/**
 * A plaintext official-export session log.
 *
 * @param {object} header
 * @param {object[]} events
 * @returns {string}
 */
export function plaintextSession(header, events) {
  return `${[JSON.stringify(header), ...events.map((event) => JSON.stringify(event))].join('\n')}\n`;
}
