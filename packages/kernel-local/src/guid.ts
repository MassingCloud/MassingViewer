import { type Guid, asGuid } from "@massing/core";

/**
 * IFC GlobalId minting.
 *
 * ## These are compressed UUIDs, not 22 random characters
 *
 * `IfcGloballyUniqueId` is a 128-bit UUID encoded in a base64 variant, and the encoding is part of the
 * standard rather than an implementation detail: other tools decompress it back to a UUID to match elements
 * across files and against external databases. Emitting 22 characters that merely *look* right passes a length
 * check, passes most viewers, and then fails silently in the one place it matters — a federated model or a COBie
 * export where two disciplines are matched by GlobalId.
 *
 * The grouping is 1 byte then five 3-byte groups: `2 + 5×4 = 22` characters. The first character is therefore
 * always `0`–`3`, which is a useful smell test on any real IFC file.
 *
 * ## Uniqueness is per-element and permanent
 *
 * Minted once, at creation, and never recomputed. `expressID` changes when a file is rewritten; a GlobalId must
 * not, because it is the only identifier this product persists — markup anchors, plan↔3D links, schedules and
 * issues all resolve through it. See `docs/adr/0008-local-kernel-geometry-stack.md`.
 */

/** The IFC base64 alphabet. Note the order: digits first, then upper, lower, `_`, `$`. */
const B64 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$";

/** Encode `n` as `width` base64 characters, most significant first. */
function encode(n: number, width: number): string {
  let out = "";
  for (let i = width - 1; i >= 0; i--) out = B64[(n >>> (6 * (width - 1 - i))) & 63] + out;
  return out;
}

/** Compress 16 bytes of UUID into the 22-character IFC form. */
export function compressUuid(bytes: Uint8Array): Guid {
  if (bytes.length !== 16) throw new RangeError(`a UUID is 16 bytes, got ${bytes.length}`);
  // First group is one byte in two characters; the remaining five are three bytes in four characters each.
  let out = encode(bytes[0]!, 2);
  for (let i = 1; i < 16; i += 3) {
    out += encode((bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!, 4);
  }
  return asGuid(out);
}

/** Expand the 22-character form back to 16 bytes. Exists so the round-trip is testable, and it is tested. */
export function decompressUuid(guid: string): Uint8Array {
  if (guid.length !== 22) throw new RangeError(`an IFC GlobalId is 22 characters, got ${guid.length}`);
  const value = (s: string): number => {
    let n = 0;
    for (const ch of s) {
      const d = B64.indexOf(ch);
      if (d < 0) throw new RangeError(`"${ch}" is not in the IFC base64 alphabet`);
      n = n * 64 + d;
    }
    return n;
  };
  const bytes = new Uint8Array(16);
  bytes[0] = value(guid.slice(0, 2));
  for (let g = 0; g < 5; g++) {
    const n = value(guid.slice(2 + g * 4, 6 + g * 4));
    bytes[1 + g * 3] = (n >>> 16) & 0xff;
    bytes[2 + g * 3] = (n >>> 8) & 0xff;
    bytes[3 + g * 3] = n & 0xff;
  }
  return bytes;
}

/** Mints GlobalIds. Injectable so tests can be deterministic without the production path being fake. */
export type GuidMinter = () => Guid;

/**
 * The real minter: a random version-4 UUID, compressed.
 *
 * `crypto.getRandomValues` is present in browsers, Workers and Node ≥19, which is every environment this
 * package supports. There is deliberately no `Math.random` fallback: a GlobalId collision is unrecoverable —
 * two elements become one element everywhere downstream, forever — so a weak source is worse than a hard
 * failure at startup that names the problem.
 */
export function randomGuidMinter(): GuidMinter {
  if (typeof globalThis.crypto?.getRandomValues !== "function") {
    throw new Error(
      "no cryptographic random source: crypto.getRandomValues is unavailable. GlobalIds must not be minted " +
        "from a weak source — a collision merges two elements everywhere downstream and cannot be undone.",
    );
  }
  return () => {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    // Version 4, variant RFC 4122 — so the value decompresses to a well-formed UUID rather than 16 loose bytes.
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    return compressUuid(bytes);
  };
}

/**
 * A deterministic minter, for tests and reproducible fixtures.
 *
 * Sequential rather than hashed: when a test fails, "the third element created" is immediately legible, and
 * that is worth more here than ids that look plausible.
 */
export function countingGuidMinter(seed = 1): GuidMinter {
  let n = seed;
  return () => {
    const bytes = new Uint8Array(16);
    const value = n++;
    for (let i = 0; i < 8; i++) bytes[15 - i] = (value / 256 ** i) & 0xff;
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    return compressUuid(bytes);
  };
}
