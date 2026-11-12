import pino, { type DestinationStream, type Logger } from 'pino';

/**
 * Keys whose values must never reach a log line (secrets never logged).
 * Redaction is applied at depth 0-3 for each key.
 */
const SECRET_KEYS = [
  'token',
  'secret',
  'secrets',
  'secretsEnc',
  'secrets_enc',
  'webhookSecret',
  'password',
  'passphrase',
  'authorization',
  'privateKey',
  'private_key',
  'masterKey',
  'MASTER_KEY',
  'VAPID_PRIVATE_KEY',
  'x-gitlab-token',
  'cookie',
  'p256dh',
  'auth',
] as const;

export function redactPaths(): string[] {
  const paths: string[] = [];
  for (const key of SECRET_KEYS) {
    const plain = /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
    for (const prefix of ['', '*.', '*.*.', '*.*.*.']) {
      if (plain) paths.push(`${prefix}${key}`);
      else paths.push(prefix === '' ? `["${key}"]` : `${prefix}["${key}"]`);
    }
  }
  return paths;
}

export interface LoggerOptions {
  level?: string;
  /** Human-readable output via pino-pretty (dev only). */
  pretty?: boolean;
  /** Custom destination (tests). */
  destination?: DestinationStream;
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const base = {
    level: opts.level ?? 'info',
    redact: { paths: redactPaths(), censor: '[REDACTED]' },
  };
  if (opts.destination) return pino(base, opts.destination);
  if (opts.pretty) {
    return pino({ ...base, transport: { target: 'pino-pretty', options: { colorize: true } } });
  }
  return pino(base);
}

export type { Logger };
