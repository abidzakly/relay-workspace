import { describe, expect, it } from 'vitest';
import { buildTestResult, normalizeName, summarizeChecks, type Check } from './connectionTest';

const c = (status: Check['status'], id = 'x'): Check => ({
  id,
  group: 'gitlab',
  label: id,
  status,
  message: '',
});

describe('connection test result', () => {
  it('summarizes every status', () => {
    expect(summarizeChecks([c('pass'), c('pass'), c('warn'), c('fail'), c('skip')])).toEqual({
      pass: 2,
      warn: 1,
      fail: 1,
      skip: 1,
    });
  });
  it('is ok with only pass/warn/skip, not ok with any fail', () => {
    expect(buildTestResult([c('pass'), c('warn'), c('skip')], 1).ok).toBe(true);
    expect(buildTestResult([c('pass'), c('fail')], 1).ok).toBe(false);
    expect(buildTestResult([], 1).ok).toBe(true);
  });
  it('carries notion detection only when given', () => {
    expect(buildTestResult([], 1)).not.toHaveProperty('notion');
    const r = buildTestResult([], 1, { notion: { statusOptions: [] } });
    expect(r.notion).toEqual({ statusOptions: [] });
  });
});

describe('normalizeName', () => {
  it('ignores case, outer and repeated whitespace, nbsp', () => {
    expect(normalizeName('  Ready   to Test ')).toBe('ready to test');
    expect(normalizeName('READY TO TEST')).toBe(normalizeName('ready to test'));
  });
  it('keeps different names different', () => {
    expect(normalizeName('Next Up')).not.toBe(normalizeName('NextUp'));
  });
});
