import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, matchTotp, newTotpSecret, parseTotpSecret, timeStepAt, totpCode, totpUri } from './totp.js';

// RFC 6238 appendix B (SHA-1): the ASCII secret "12345678901234567890"; the 6-digit codes are the last six of the 8-digit values.
const RFC_KEY = Buffer.from('12345678901234567890', 'ascii');

describe('authenticator codes (T-061, D-063 item 6)', () => {
  it('matches the RFC 6238 test values', () => {
    expect(totpCode(RFC_KEY, timeStepAt(new Date(59_000)))).toBe('287082');
    expect(totpCode(RFC_KEY, timeStepAt(new Date(1_111_111_109_000)))).toBe('081804');
    expect(totpCode(RFC_KEY, timeStepAt(new Date(1_234_567_890_000)))).toBe('005924');
  });

  it('base32 round-trips, and a new secret is 160 bits an authenticator app accepts', () => {
    const secret = newTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(secret)).toHaveLength(20);
    expect(base32Encode(base32Decode('JBSWY3DPEHPK3PXP'))).toBe('JBSWY3DPEHPK3PXP');
    expect(totpUri(secret)).toBe(`otpauth://totp/MintBot:owner?secret=${secret}&issuer=MintBot&algorithm=SHA1&digits=6&period=30`);
  });

  it('accepts the current step and one either side, and returns which step matched', () => {
    const now = new Date(1_700_000_000_000);
    const step = timeStepAt(now);
    expect(matchTotp(RFC_KEY, totpCode(RFC_KEY, step), now)).toBe(step);
    expect(matchTotp(RFC_KEY, totpCode(RFC_KEY, step - 1), now)).toBe(step - 1);
    expect(matchTotp(RFC_KEY, totpCode(RFC_KEY, step + 1), now)).toBe(step + 1);
  });

  it('refuses old codes, wrong codes and anything that is not six digits (fail closed)', () => {
    const now = new Date(1_700_000_000_000);
    const step = timeStepAt(now);
    expect(matchTotp(RFC_KEY, totpCode(RFC_KEY, step - 2), now)).toBeUndefined();
    expect(matchTotp(RFC_KEY, totpCode(RFC_KEY, step + 2), now)).toBeUndefined();
    for (const bad of ['', '12345', '1234567', 'abcdef', ' 12345', '123 45']) expect(matchTotp(RFC_KEY, bad, now)).toBeUndefined();
  });

  it('refuses a missing, malformed or short secret (fail closed)', () => {
    expect(() => parseTotpSecret(undefined)).toThrow('TOTP_SECRET_MISSING');
    expect(() => parseTotpSecret('not base32!')).toThrow('TOTP_SECRET_INVALID');
    expect(() => parseTotpSecret('JBSWY3DPEHPK3PXP')).toThrow('TOTP_SECRET_TOO_SHORT');
    expect(parseTotpSecret(newTotpSecret())).toHaveLength(20);
  });
});
