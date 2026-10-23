const twofa = require('../src/twofa');

const rfcSecret = twofa.base32Encode(Buffer.from('12345678901234567890'));

describe('twofa TOTP', () => {
  test.each([[59, '287082'], [1111111109, '081804'], [1234567890, '005924']])('RFC 6238 vector at t=%i', (t, expected) => {
    expect(twofa.totpAt(rfcSecret, Math.floor(t / 30))).toBe(expected);
  });
  test('base32 round-trips and rejects invalid input', () => {
    const buf = Buffer.from('hootowl-secret');
    expect(twofa.base32Decode(twofa.base32Encode(buf)).equals(buf)).toBe(true);
    expect(() => twofa.base32Decode('not*valid')).toThrow();
  });
  test('verifyTotp accepts adjacent steps and rejects far steps and malformed codes', () => {
    const now = 1111111109 * 1000;
    expect(twofa.verifyTotp(rfcSecret, '081804', now)).toBe(Math.floor(1111111109 / 30));
    expect(twofa.verifyTotp(rfcSecret, '081804', now + 30000)).not.toBeNull();
    expect(twofa.verifyTotp(rfcSecret, '081804', now + 120000)).toBeNull();
    for (const bad of ['', '12345', '1234567', 'abcdef', null, undefined]) expect(twofa.verifyTotp(rfcSecret, bad, now)).toBeNull();
  });
  test('generated secrets are unique and valid base32 of 160 bits', () => {
    const a = twofa.generateSecret(), b = twofa.generateSecret();
    expect(a).not.toBe(b);
    expect(twofa.base32Decode(a)).toHaveLength(20);
  });
  test('otpauth URI carries issuer and encodes the account', () => {
    const uri = twofa.otpauthUri('ABC', 'a+b@example.com');
    expect(uri).toContain('issuer=HootOwl');
    expect(uri).toContain('a%2Bb%40example.com');
  });
});

describe('twofa secret encryption', () => {
  const original = process.env.TWOFA_ENCRYPTION_KEY;
  afterEach(() => { process.env.TWOFA_ENCRYPTION_KEY = original; });
  test('encrypts with a random IV and decrypts', () => {
    process.env.TWOFA_ENCRYPTION_KEY = 'ab'.repeat(32);
    const one = twofa.encryptSecret('JBSWY3DPEHPK3PXP'), two = twofa.encryptSecret('JBSWY3DPEHPK3PXP');
    expect(one).not.toBe(two);
    expect(twofa.decryptSecret(one)).toBe('JBSWY3DPEHPK3PXP');
  });
  test('rejects tampering and a wrong key', () => {
    process.env.TWOFA_ENCRYPTION_KEY = 'ab'.repeat(32);
    const [iv, tag, enc] = twofa.encryptSecret('secret').split('.');
    expect(() => twofa.decryptSecret([iv, tag, Buffer.from('x').toString('base64')].join('.'))).toThrow();
    const stored = twofa.encryptSecret('secret');
    process.env.TWOFA_ENCRYPTION_KEY = 'cd'.repeat(32);
    expect(() => twofa.decryptSecret(stored)).toThrow();
    expect(enc).toBeTruthy();
  });
  test.each(['', 'short', 'zz'.repeat(32), 'ab'.repeat(31)])('refuses invalid key %p', (key) => {
    process.env.TWOFA_ENCRYPTION_KEY = key;
    expect(() => twofa.encryptSecret('x')).toThrow(/64 hex/);
  });
});

describe('recovery and sms codes', () => {
  test('recovery codes are unique and hash independent of formatting', () => {
    const codes = twofa.newRecoveryCodes(8);
    expect(new Set(codes).size).toBe(8);
    expect(twofa.recoveryHash(codes[0].toUpperCase())).toBe(twofa.recoveryHash(codes[0]));
    expect(twofa.recoveryHash(codes[0])).not.toBe(twofa.recoveryHash(codes[1]));
  });
  test('sms codes are 6 digits and bound to their challenge', () => {
    for (let i = 0; i < 50; i++) expect(twofa.smsCode()).toMatch(/^\d{6}$/);
    expect(twofa.smsHash('a', '123456')).not.toBe(twofa.smsHash('b', '123456'));
  });
});
