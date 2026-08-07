/**
 * A minimal ZIP writer — stored (uncompressed) entries only.
 *
 * ## Why hand-rolled rather than a dependency
 *
 * BCF is a ZIP container (`.bcfzip`), so exporting BCF needs one. The alternatives were a compression library —
 * more transitive dependencies and licence surface in a package whose whole job is producing a 20 KB XML archive
 * — or this: about a hundred lines of a format that has been frozen since 1989 and is exhaustively specified.
 *
 * Stored rather than deflated is a deliberate trade. Deflate would need a compressor (the actual complexity);
 * STORE needs only CRC-32 and correct offsets. BCF payloads are small XML files, the archives are a few tens of
 * kilobytes either way, and **every** ZIP reader supports STORE — it is the one method that has never been
 * optional. A smaller file is not worth a compressor here.
 *
 * ## How this is verified
 *
 * Not by reading it back with our own reader, which would only prove we are self-consistent. The tests extract
 * the archive with an **independent implementation** — the operating system's own unzip — and compare the files
 * byte-for-byte. A ZIP writer that only its own reader accepts is the exact failure mode worth designing the
 * test against.
 */

/**
 * CRC-32 (IEEE 802.3), the checksum every ZIP entry carries.
 *
 * `0xEDB88320` is the reversed form of the standard polynomial. It is worth writing out because a typo here does
 * not throw, does not look wrong, and produces an archive that every reader rejects as corrupt — so the tests
 * check it against the canonical known answer, `crc32("123456789") === 0xCBF43926`, rather than only checking
 * that an archive round-trips.
 */
const CRC_POLYNOMIAL = 0xedb88320;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) === 1 ? CRC_POLYNOMIAL ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  /** Forward slashes, no leading slash — the only form the spec allows. */
  readonly path: string;
  readonly bytes: Uint8Array;
}

/** Little-endian writer, because every field in a ZIP is little-endian regardless of the host. */
class Writer {
  private readonly chunks: Uint8Array[] = [];
  private length = 0;

  get offset(): number {
    return this.length;
  }

  u16(value: number): void {
    this.push(new Uint8Array([value & 0xff, (value >>> 8) & 0xff]));
  }

  u32(value: number): void {
    this.push(new Uint8Array([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]));
  }

  push(bytes: Uint8Array): void {
    this.chunks.push(bytes);
    this.length += bytes.length;
  }

  finish(): Uint8Array {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  }
}

/**
 * Build a ZIP archive.
 *
 * Timestamps are fixed rather than taken from the clock. A BCF export whose bytes change every second cannot be
 * compared, cannot be a test fixture, and produces a diff on every run — the same reason `fixtures/sample.ifc`
 * is generated deterministically. The topic's own `CreationDate` carries the real time, in the XML, where a
 * reader will actually look for it.
 */
export function makeZip(entries: readonly ZipEntry[]): Uint8Array {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.path.startsWith("/") || entry.path.includes("\\")) {
      throw new RangeError(`ZIP paths use forward slashes and no leading slash: ${JSON.stringify(entry.path)}`);
    }
    if (seen.has(entry.path)) throw new RangeError(`duplicate entry ${entry.path}`);
    seen.add(entry.path);
  }

  const encoder = new TextEncoder();
  const w = new Writer();
  const directory: { path: Uint8Array; crc: number; size: number; offset: number }[] = [];

  // MS-DOS date/time for 1980-01-01 00:00:00, the earliest the format can express.
  const DOS_TIME = 0;
  const DOS_DATE = 33;

  for (const entry of entries) {
    const path = encoder.encode(entry.path);
    const crc = crc32(entry.bytes);
    const offset = w.offset;

    w.u32(0x04034b50); // local file header
    w.u16(20); // version needed: 2.0
    // Bit 11 marks the filename as UTF-8. Without it a reader falls back to CP437 and a topic title with an
    // accent in its folder name arrives mangled.
    w.u16(0x0800);
    w.u16(0); // method: stored
    w.u16(DOS_TIME);
    w.u16(DOS_DATE);
    w.u32(crc);
    w.u32(entry.bytes.length); // compressed size == uncompressed, for STORE
    w.u32(entry.bytes.length);
    w.u16(path.length);
    w.u16(0); // extra field length
    w.push(path);
    w.push(entry.bytes);

    directory.push({ path, crc, size: entry.bytes.length, offset });
  }

  const directoryStart = w.offset;
  for (const item of directory) {
    w.u32(0x02014b50); // central directory header
    w.u16(20); // version made by
    w.u16(20); // version needed
    w.u16(0x0800); // UTF-8 names
    w.u16(0); // stored
    w.u16(DOS_TIME);
    w.u16(DOS_DATE);
    w.u32(item.crc);
    w.u32(item.size);
    w.u32(item.size);
    w.u16(item.path.length);
    w.u16(0); // extra
    w.u16(0); // comment
    w.u16(0); // disk number
    w.u16(0); // internal attributes
    // External attributes: 0644 in the high word, which is what a Unix unzip uses for file mode. Zero here
    // produces files with no permission bits, and some tools then extract them as unreadable.
    w.u32(0o644 << 16);
    w.u32(item.offset);
    w.push(item.path);
  }
  const directorySize = w.offset - directoryStart;

  w.u32(0x06054b50); // end of central directory
  w.u16(0); // this disk
  w.u16(0); // disk with the directory
  w.u16(directory.length);
  w.u16(directory.length);
  w.u32(directorySize);
  w.u32(directoryStart);
  w.u16(0); // comment length

  return w.finish();
}
