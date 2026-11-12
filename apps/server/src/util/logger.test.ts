import { describe, expect, it } from 'vitest';
import { createLogger, redactPaths } from './logger';

function capture() {
  const lines: string[] = [];
  const destination = { write: (s: string) => void lines.push(s) };
  return { lines, logger: createLogger({ level: 'trace', destination }) };
}

describe('logger redaction (secrets are never logged)', () => {
  it('redacts secret keys at several depths', () => {
    const { logger, lines } = capture();
    logger.info({
      token: 'glpat-TOP',
      repo: { gitlab: { token: 'glpat-NESTED', webhookSecret: 'whsec-NESTED' } },
      headers: { authorization: 'Bearer ntn_HEADER', 'x-gitlab-token': 'hook-HEADER' },
      req: { headers: { authorization: 'Bearer ntn_REQ' } },
      a: { b: { secrets: 'enc-blob' } },
      env: { MASTER_KEY: 'master-key-value' },
      push: { keys: { p256dh: 'p-key', auth: 'a-key' } },
    });
    const out = lines.join('');
    for (const s of [
      'glpat-TOP',
      'glpat-NESTED',
      'whsec-NESTED',
      'ntn_HEADER',
      'hook-HEADER',
      'ntn_REQ',
      'enc-blob',
      'master-key-value',
      'p-key',
      'a-key',
    ]) {
      expect(out, s).not.toContain(s);
    }
    expect(out).toContain('[REDACTED]');
  });

  it('keeps non-secret fields intact', () => {
    const { logger, lines } = capture();
    logger.info({ repoId: 'app-a', mrIid: 7 }, 'hello');
    const rec = JSON.parse(lines[0] ?? '{}');
    expect(rec).toMatchObject({ repoId: 'app-a', mrIid: 7, msg: 'hello' });
  });

  it('generates valid, unique redact paths', () => {
    const paths = redactPaths();
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths).toContain('token');
    expect(paths).toContain('*.*.webhookSecret');
    expect(paths).toContain('["x-gitlab-token"]');
    expect(paths).toContain('*.["x-gitlab-token"]');
  });
});
