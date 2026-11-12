import { describe, expect, it } from 'vitest';
import { validateCommand } from './gitExec';

describe('git merge allowlist (QA preview)', () => {
  it('allows the two shapes the preview uses', () => {
    expect(() =>
      validateCommand('git', ['merge', '--no-ff', '--no-edit', 'origin/feat/x']),
    ).not.toThrow();
    expect(() => validateCommand('git', ['merge', '--abort'])).not.toThrow();
  });

  it('allows the braces some branch names carry', () => {
    expect(() =>
      validateCommand('git', ['merge', '--no-ff', '--no-edit', 'origin/Improvement/CRD-1/A/{MO}x']),
    ).not.toThrow();
  });

  it.each([
    [['merge', 'origin/feat/x']],
    [['merge', '--no-ff', '--no-edit', 'feat/x']],
    [['merge', '--no-ff', '--no-edit', '-s', 'ours', 'origin/x']],
    [['merge', '--no-ff', '--no-edit', 'origin/x', 'origin/y']],
    [['merge', '--exec=sh', '--no-edit', 'origin/x']],
  ])('refuses %j', (args) => {
    expect(() => validateCommand('git', args)).toThrow();
  });
});
