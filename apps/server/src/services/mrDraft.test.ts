import { describe, expect, it } from 'vitest';
import { titleWithDraft } from './gitlabMr';

describe('titleWithDraft', () => {
  it('adds the Draft: prefix', () => {
    expect(titleWithDraft('feat: x', true)).toBe('Draft: feat: x');
  });
  it('strips any draft marker', () => {
    expect(titleWithDraft('Draft: feat: x', false)).toBe('feat: x');
    expect(titleWithDraft('[WIP] feat: x', false)).toBe('feat: x');
    expect(titleWithDraft('(draft)   feat: x', false)).toBe('feat: x');
  });
  it('does not double the prefix', () => {
    expect(titleWithDraft('Draft: feat: x', true)).toBe('Draft: feat: x');
  });
  it('leaves a ready title alone', () => {
    expect(titleWithDraft('feat: x', false)).toBe('feat: x');
  });
});
