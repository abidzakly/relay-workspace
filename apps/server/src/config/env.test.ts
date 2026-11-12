import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findRepoRoot, loadEnv, parseTlsHosts, resolveDataDir } from './env';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'core-env-'));
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages: []\n');
  mkdirSync(join(root, 'apps', 'server'), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('env', () => {
  it('loadEnv applies defaults and validates', () => {
    expect(loadEnv({}).LOG_LEVEL).toBe('info');
    expect(loadEnv({ LOG_LEVEL: 'debug' }).LOG_LEVEL).toBe('debug');
    expect(() => loadEnv({ LOG_LEVEL: 'loud' })).toThrow();
    expect(() => loadEnv({ DATA_DIR: '' })).toThrow();
  });

  it('findRepoRoot walks up to pnpm-workspace.yaml', () => {
    expect(findRepoRoot(join(root, 'apps', 'server'))).toBe(root);
    expect(findRepoRoot(root)).toBe(root);
  });

  it('resolveDataDir: default, relative and absolute DATA_DIR', () => {
    const cwd = join(root, 'apps', 'server');
    expect(resolveDataDir({}, cwd)).toBe(join(root, 'data'));
    expect(resolveDataDir({ DATA_DIR: 'custom/dir' }, cwd)).toBe(join(root, 'custom', 'dir'));
    expect(resolveDataDir({ DATA_DIR: '/var/lib/core' }, cwd)).toBe('/var/lib/core');
  });

  it('DASHBOARD_TLS_HOSTS accepts hostnames only', () => {
    expect(parseTlsHosts(undefined)).toEqual([]);
    expect(parseTlsHosts(' Mac.Tail5b903e.ts.net. , other.example.com')).toEqual([
      'mac.tail5b903e.ts.net',
      'other.example.com',
    ]);
    for (const bad of [
      'https://mac.ts.net',
      'mac.ts.net:443',
      'mac.ts.net/x',
      '192.168.1.5',
      'localhost',
      '*.ts.net',
    ]) {
      expect(parseTlsHosts(bad)).toBeNull();
      expect(() => loadEnv({ DASHBOARD_TLS_HOSTS: bad })).toThrow();
    }
  });

  it('DASHBOARD_TLS_HOSTS requires DASHBOARD_TLS_USERS', () => {
    expect(() => loadEnv({ DASHBOARD_TLS_HOSTS: 'mac.ts.net' })).toThrow(/DASHBOARD_TLS_USERS/);
    expect(
      loadEnv({ DASHBOARD_TLS_HOSTS: 'mac.ts.net', DASHBOARD_TLS_USERS: 'me@x.com' })
        .DASHBOARD_TLS_USERS,
    ).toBe('me@x.com');
  });
});
