import { describe, expect, it } from 'vitest';
import { approvedAtFromNotes } from './gitlabMr';

const n = (author: string | null, system: boolean, body: string, createdAt: number) => ({
  author,
  system,
  body,
  createdAt,
});

describe('approvedAtFromNotes', () => {
  it('finds the system approval note', () => {
    expect(
      approvedAtFromNotes([n('Sam', true, 'approved this merge request', 5)], 'sam.reviewer'),
    ).toBe(5);
  });
  it('accepts a keyword note and picks the latest', () => {
    const notes = [n('a', false, 'LGTM', 3), n('a', true, 'approved this merge request', 9)];
    expect(approvedAtFromNotes(notes, 'a')).toBe(9);
  });
  it('returns null when none', () => {
    expect(
      approvedAtFromNotes(
        [n('a', false, 'looks odd', 1), n('b', true, 'approved this merge request', 2)],
        'a',
      ),
    ).toBeNull();
  });
});
