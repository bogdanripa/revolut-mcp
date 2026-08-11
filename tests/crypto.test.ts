import { decrypt, encrypt, keyFromHex } from '../src/tenants/crypto.js';

const KEY_HEX = 'a'.repeat(64);

describe('token encryption', () => {
  const key = keyFromHex(KEY_HEX);

  it('round-trips a payload', () => {
    const payload = JSON.stringify({ accessToken: 'oa_prod_secret', expiresAt: 123 });
    expect(decrypt(encrypt(payload, key), key)).toBe(payload);
  });

  it('produces a different ciphertext each time (random IV)', () => {
    expect(encrypt('same', key)).not.toBe(encrypt('same', key));
  });

  it('rejects a key that is not 32 bytes of hex', () => {
    expect(() => keyFromHex(undefined)).toThrow(/64 hex/);
    expect(() => keyFromHex('abc')).toThrow(/64 hex/);
    expect(() => keyFromHex('z'.repeat(64))).toThrow(/64 hex/);
  });

  it('refuses to decrypt with the wrong key', () => {
    const other = keyFromHex('b'.repeat(64));
    expect(() => decrypt(encrypt('secret', key), other)).toThrow();
  });

  it('refuses a tampered ciphertext', () => {
    const raw = Buffer.from(encrypt('secret', key), 'base64');
    raw[raw.length - 1] ^= 0xff;
    expect(() => decrypt(raw.toString('base64'), key)).toThrow();
  });

  it('rejects a payload too short to hold an IV and tag', () => {
    expect(() => decrypt(Buffer.alloc(8).toString('base64'), key)).toThrow(/too short/);
  });
});
