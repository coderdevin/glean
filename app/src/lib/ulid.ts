/**
 * Crockford base32 ULID — 26-char timestamp-prefixed sortable ID.
 *
 * We dropped the `ulid` npm package because in Cloudflare's Workers v8 runtime
 * its (older) module-load path threw on some platform builds. This is a tiny
 * self-contained implementation: 48-bit big-endian timestamp + 80 random bits,
 * base32-encoded.
 */

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // length 32

export function ulid(): string {
  const time = Date.now();
  const timeChars = encodeBase32(time, 10); // 10 chars × 5 bits = 50 bits, top covers ms

  // 80 random bits → 16 chars
  const buf = new Uint8Array(10);
  crypto.getRandomValues(buf);
  let randBits = "";
  for (const b of buf) randBits += b.toString(2).padStart(8, "0");
  let randChars = "";
  for (let i = 0; i < 16; i++) {
    const slice = randBits.slice(i * 5, i * 5 + 5).padEnd(5, "0");
    randChars += CROCKFORD[parseInt(slice, 2)];
  }
  return timeChars + randChars;
}

function encodeBase32(n: number, len: number): string {
  let out = "";
  for (let i = len - 1; i >= 0; i--) {
    out = CROCKFORD[n & 31] + out;
    n = Math.floor(n / 32);
  }
  return out;
}
