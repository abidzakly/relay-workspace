import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CryptoError, SecretBox, parseMasterKey } from './crypto';

const key = randomBytes(32);
const box = new SecretBox(key);

describe('parseMasterKey', () => {
  it('accepts hex, base64 and base64url of 32 bytes', () => {
    expect(parseMasterKey(key.toString('hex')).equals(key)).toBe(true);
    expect(parseMasterKey(key.toString('base64')).equals(key)).toBe(true);
    expect(parseMasterKey(key.toString('base64url')).equals(key)).toBe(true);
    expect(parseMasterKey(`  ${key.toString('hex')}\n`).equals(key)).toBe(true);
  });
  it('rejects missing, short, long and non-key strings without echoing them', () => {
    for (const bad of [
      undefined,
      '',
      '   ',
      'short',
      randomBytes(16).toString('hex'),
      'x'.repeat(64),
    ]) {
      expect(() => parseMasterKey(bad)).toThrow(CryptoError);
    }
    try {
      parseMasterKey('super-secret-but-wrong');
    } catch (e) {
      expect(String(e)).not.toContain('super-secret');
    }
  });
});

describe('SecretBox (AES-256-GCM)', () => {
  it('round-trips, including unicode and empty-ish strings', () => {
    for (const s of ['glpat-abc', 'ünï©ode ✓ 🚀', 'x'.repeat(5000), ' ']) {
      expect(box.decrypt(box.encrypt(s, 'ctx'), 'ctx')).toBe(s);
    }
  });
  it('is versioned and does not contain the plaintext', () => {
    const p = box.encrypt('glpat-PLAINTEXT', 'ctx');
    expect(p.startsWith('v1:')).toBe(true);
    expect(p).not.toContain('PLAINTEXT');
    expect(Buffer.from(p.slice(3), 'base64url').toString('latin1')).not.toContain('PLAINTEXT');
  });
  it('uses a fresh random IV per call (same input -> different payloads)', () => {
    const set = new Set(Array.from({ length: 50 }, () => box.encrypt('same', 'ctx')));
    expect(set.size).toBe(50);
    const ivs = new Set(
      [...set].map((p) => Buffer.from(p.slice(3), 'base64url').subarray(0, 12).toString('hex')),
    );
    expect(ivs.size).toBe(50);
  });
  it('fails with a different key', () => {
    const other = new SecretBox(randomBytes(32));
    expect(() => other.decrypt(box.encrypt('s', 'ctx'), 'ctx')).toThrow('decryption failed');
  });
  it('binds the context (AAD): a blob moved to another row does not decrypt', () => {
    expect(() => box.decrypt(box.encrypt('s', 'repo:a:secrets'), 'repo:b:secrets')).toThrow(
      'decryption failed',
    );
  });
  it('detects tampering of any byte region (iv, tag, ciphertext)', () => {
    const p = box.encrypt('hello world', 'ctx');
    const raw = Buffer.from(p.slice(3), 'base64url');
    for (const i of [0, 12, 28, raw.length - 1]) {
      const t = Buffer.from(raw);
      t[i] = (t[i] ?? 0) ^ 0x01;
      expect(() => box.decrypt(`v1:${t.toString('base64url')}`, 'ctx')).toThrow(CryptoError);
    }
  });
  it('rejects unknown versions and malformed payloads', () => {
    expect(() => box.decrypt('v2:AAAA', 'ctx')).toThrow('unsupported');
    expect(() => box.decrypt('nonsense', 'ctx')).toThrow('unsupported');
    expect(() => box.decrypt('v1:AAAA', 'ctx')).toThrow('malformed');
  });
  it('rejects a wrong-sized master key', () => {
    expect(() => new SecretBox(randomBytes(16))).toThrow(CryptoError);
  });
});
