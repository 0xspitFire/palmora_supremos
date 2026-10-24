import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * T-061 (D-063 item 6): authenticator-app codes (RFC 6238: HMAC-SHA1, 30-second steps, 6 digits), the kind every phone
 * authenticator app produces. The shared secret lives only in the host secret store.
 */
export const TOTP_STEP_SECONDS = 30;
const DIGITS = 6;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=-]/g, '').toUpperCase();
  if (clean.length === 0 || /[^A-Z2-7]/.test(clean)) throw new Error('TOTP_SECRET_INVALID');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    value = (value << 5) | ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** A new 160-bit secret, as the base32 text an authenticator app accepts. */
export function newTotpSecret(): string { return base32Encode(randomBytes(20)); }

/** The secret must be at least 128 bits. */
export function parseTotpSecret(text: string | undefined): Buffer {
  if (!text) throw new Error('TOTP_SECRET_MISSING');
  const key = base32Decode(text);
  if (key.length < 16) throw new Error('TOTP_SECRET_TOO_SHORT');
  return key;
}

export function totpCode(key: Buffer, timeStep: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(timeStep));
  const mac = createHmac('sha1', key).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return (binary % 10 ** DIGITS).toString().padStart(DIGITS, '0');
}

export function timeStepAt(now: Date): number { return Math.floor(now.getTime() / 1000 / TOTP_STEP_SECONDS); }

/**
 * The time step the code belongs to (the current step or one either side, for clock drift), or undefined when it matches none.
 * The caller refuses a step that was already used, so a code works once.
 */
export function matchTotp(key: Buffer, code: string, now: Date): number | undefined {
  if (!/^\d{6}$/.test(code)) return undefined;
  const current = timeStepAt(now);
  let matched: number | undefined;
  for (const step of [current - 1, current, current + 1]) {
    const expected = Buffer.from(totpCode(key, step));
    // Every candidate is compared, in constant time, so the timing does not show which one matched.
    if (timingSafeEqual(expected, Buffer.from(code)) && matched === undefined) matched = step;
  }
  return matched;
}

/** The link an authenticator app can import (as a QR code or a tap on the phone). Shown only on the host. */
export function totpUri(secret: string, account = 'owner'): string {
  return `otpauth://totp/MintBot:${encodeURIComponent(account)}?secret=${secret}&issuer=MintBot&algorithm=SHA1&digits=${DIGITS}&period=${TOTP_STEP_SECONDS}`;
}
