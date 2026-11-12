import { describe, expect, it } from 'vitest';
import { resolveStatus } from './notionCard';

const groups = {
  complete: ['Complete', 'Completed'],
  done: [],
  inactive: [],
  uncommitted: [],
};

describe('resolveStatus', () => {
  it("resolves Complete to the workspace's spelling", () => {
    expect(resolveStatus('Complete', ['In Progress', 'Completed'], groups)).toBe('Completed');
  });

  it('prefers an exact match over another spelling of Complete', () => {
    expect(resolveStatus('complete', ['Completed', 'Complete'], groups)).toBe('Complete');
  });

  it('returns the configured spelling of any other status', () => {
    expect(resolveStatus(' in progress ', ['In Progress'], groups)).toBe('In Progress');
  });

  it('refuses a status the board does not have', () => {
    expect(resolveStatus('Nope', ['In Progress', 'Completed'], groups)).toBeNull();
    expect(resolveStatus('Complete', ['In Progress'], groups)).toBeNull();
  });
});
