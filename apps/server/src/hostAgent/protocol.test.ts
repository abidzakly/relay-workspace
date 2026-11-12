import { describe, expect, it } from 'vitest';
import { appendGitConfig, gitAuthEnv } from '../services/gitExec';
import { vuArgs } from '../services/ptyEngine';
import { checkClientEnv, isVuArgs, readNdjson } from './protocol';

describe('isVuArgs', () => {
  it('accepts exactly what vuArgs builds', () => {
    expect(isVuArgs(vuArgs({ mode: 'staging', base: 'main', version: null }))).toBe(true);
    expect(isVuArgs(vuArgs({ mode: 'prod', base: 'release/2.2', version: '2.2.0+60' }))).toBe(true);
  });

  it('refuses anything else', () => {
    expect(isVuArgs(['staging', '-b', 'main', '-y'])).toBe(false);
    expect(isVuArgs(['staging', '-b', 'main', '-y', '--no-notion-scan', '--fresh'])).toBe(false);
    expect(isVuArgs(['staging', '-b', '--upload-pack=x', '-y', '--no-notion-scan'])).toBe(false);
    expect(
      isVuArgs(['staging', '-b', 'main', '-y', '--no-notion-scan', '--version', '$(id)']),
    ).toBe(false);
  });
});

describe('checkClientEnv', () => {
  const auth = gitAuthEnv('https://git.example.id/g/app.git', 'glpat-abcdefgh1234').env;

  it('accepts the token header and the PTY variables', () => {
    expect(checkClientEnv(auth, { pty: false, passEnv: [] })).toBeNull();
    expect(
      checkClientEnv({ ...auth, GITLAB_TOKEN: 't', VU_ASSIGNEE: 'me' }, { pty: true, passEnv: [] }),
    ).toBeNull();
    expect(
      checkClientEnv({ KEY_PASSWORD: 'x' }, { pty: false, passEnv: ['KEY_PASSWORD'] }),
    ).toBeNull();
  });

  it('refuses git config that could run a program, and unlisted variables', () => {
    const ssh = appendGitConfig({}, 'core.sshCommand', 'touch /tmp/pwned');
    expect(checkClientEnv(ssh, { pty: false, passEnv: [] })).toMatch(/not allowed/);
    expect(checkClientEnv({ PATH: '/tmp' }, { pty: true, passEnv: [] })).toMatch(/may not be set/);
    expect(checkClientEnv({ GITLAB_TOKEN: 't' }, { pty: false, passEnv: [] })).toMatch(/may not/);
    expect(checkClientEnv({ GIT_CONFIG_COUNT: '1' }, { pty: false, passEnv: [] })).toMatch(
      /incomplete/,
    );
  });
});

describe('appendGitConfig', () => {
  it('numbers pairs after the existing ones', () => {
    const env = appendGitConfig(appendGitConfig({}, 'a.b', '1'), 'c.d', '2');
    expect(env).toEqual({
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'a.b',
      GIT_CONFIG_VALUE_0: '1',
      GIT_CONFIG_KEY_1: 'c.d',
      GIT_CONFIG_VALUE_1: '2',
    });
  });
});

describe('readNdjson', () => {
  it('joins lines torn across chunks', async () => {
    const enc = new TextEncoder();
    async function* chunks() {
      yield enc.encode('{"t":"hb"}\n{"t":"li');
      yield enc.encode('ne","line":"x"}\n');
      yield enc.encode('{"t":"end"}');
    }
    const out: unknown[] = [];
    for await (const e of readNdjson(chunks())) out.push(e);
    expect(out).toEqual([{ t: 'hb' }, { t: 'line', line: 'x' }, { t: 'end' }]);
  });
});
