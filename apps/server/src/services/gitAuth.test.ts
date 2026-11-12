import { describe, expect, it } from 'vitest';
import { gitAuthEnv, redactSecrets } from './gitExec';

describe('gitAuthEnv', () => {
  it('scopes a Basic header to the https host', () => {
    const { env, secrets } = gitAuthEnv(
      'https://gitlab.example.com/group/app.git',
      'glpat-abcdefgh1234',
    );
    expect(env.GIT_CONFIG_COUNT).toBe('1');
    expect(env.GIT_CONFIG_KEY_0).toBe('http.https://gitlab.example.com/.extraHeader');
    const basic = Buffer.from('oauth2:glpat-abcdefgh1234').toString('base64'); // gitleaks:allow (fake)
    expect(env.GIT_CONFIG_VALUE_0).toBe(`Authorization: Basic ${basic}`);
    expect(secrets).toEqual(['glpat-abcdefgh1234', basic]);
    expect(redactSecrets(`header ${basic} token glpat-abcdefgh1234`, secrets)).not.toMatch(
      /glpat|oauth2/,
    );
  });

  it('gives nothing for ssh URLs or without a token', () => {
    expect(gitAuthEnv('git@gitlab.example.com:group/app.git', 'glpat-x').env).toEqual({});
    expect(gitAuthEnv('ssh://git@gitlab.example.com/group/app.git', 'glpat-x').env).toEqual({});
    expect(gitAuthEnv('https://gitlab.example.com/group/app.git', undefined).env).toEqual({});
  });
});
