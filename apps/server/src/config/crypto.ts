import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM secret box.
 *
 * Payload (text, safe for a TEXT column):  `v1:<base64url(iv ‖ tag ‖ ciphertext)>`
 *  - `v1`   : format/key version, so the scheme can change without guessing.
 *  - iv     : 12 random bytes per encryption (never reused).
 *  - tag    : 16-byte GCM auth tag.
 *  - AAD    : a caller-supplied context string (e.g. `repo:app-a:secrets`) is authenticated but not
 *             stored, so a blob copied into another row/key fails to decrypt.
 *
 * The AES key is HKDF-SHA256(MASTER_KEY, info="core-dashboard/secrets/v1"), not the raw master key. The info string
 * keeps the name from before the rename to Relay on purpose: changing it would make every stored secret unreadable.
 */

export const PAYLOAD_VERSION = 'v1';
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const HKDF_INFO = 'core-dashboard/secrets/v1';

export class CryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CryptoError';
  }
}

/**
 * Parses MASTER_KEY: 32 random bytes as hex (64 chars) or base64/base64url (43-44 chars).
 * Error messages never contain the key material.
 */
export function parseMasterKey(raw: string | undefined): Buffer {
  const s = raw?.trim();
  if (!s) throw new CryptoError('MASTER_KEY is not set');
  let key: Buffer | undefined;
  if (/^[0-9a-fA-F]{64}$/.test(s)) {
    key = Buffer.from(s, 'hex');
  } else if (/^[A-Za-z0-9+/_-]{42,44}={0,2}$/.test(s)) {
    key = Buffer.from(s, 'base64'); // Node accepts both base64 and base64url alphabets
  }
  if (key?.length !== KEY_LEN) {
    throw new CryptoError('MASTER_KEY must be 32 random bytes encoded as hex or base64');
  }
  return key;
}

export class SecretBox {
  private readonly key: Buffer;

  constructor(masterKey: Buffer) {
    if (masterKey.length !== KEY_LEN) throw new CryptoError('master key must be 32 bytes');
    this.key = Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), HKDF_INFO, KEY_LEN));
  }

  static fromEnv(raw: string | undefined): SecretBox {
    return new SecretBox(parseMasterKey(raw));
  }

  encrypt(plaintext: string, context: string): string {
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv, { authTagLength: TAG_LEN });
    cipher.setAAD(Buffer.from(context, 'utf8'));
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${PAYLOAD_VERSION}:${Buffer.concat([iv, tag, ct]).toString('base64url')}`;
  }

  decrypt(payload: string, context: string): string {
    const sep = payload.indexOf(':');
    if (sep < 0 || payload.slice(0, sep) !== PAYLOAD_VERSION) {
      throw new CryptoError('unsupported secret payload version');
    }
    const raw = Buffer.from(payload.slice(sep + 1), 'base64url');
    if (raw.length < IV_LEN + TAG_LEN) throw new CryptoError('malformed secret payload');
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, IV_LEN), {
        authTagLength: TAG_LEN,
      });
      decipher.setAAD(Buffer.from(context, 'utf8'));
      decipher.setAuthTag(raw.subarray(IV_LEN, IV_LEN + TAG_LEN));
      return Buffer.concat([
        decipher.update(raw.subarray(IV_LEN + TAG_LEN)),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      // wrong key, wrong context or tampered data: no detail on purpose
      throw new CryptoError('decryption failed');
    }
  }
}
