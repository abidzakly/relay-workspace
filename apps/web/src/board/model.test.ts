import { describe, expect, it } from 'vitest';
import type { StateCard, StateMr } from '@relay/shared';
import { columnFor, matchesFilters, NO_FILTER, type CardTileModel } from './model';

const tile = (domainRepoId: string | null, mrRepoId: string | null): CardTileModel =>
  ({
    card: {
      assignees: [],
      type: null,
      domainRepoIds: domainRepoId ? [domainRepoId] : [],
    } as unknown as StateCard,
    mr: mrRepoId ? ({ repoId: mrRepoId } as StateMr) : null,
  }) as CardTileModel;

const repo = (r: string) => ({ repo: r, assignee: NO_FILTER, type: NO_FILTER });

describe('columnFor', () => {
  const column = (status: string, complete?: readonly string[]) =>
    columnFor({ status } as StateCard, 'Ready to Test', complete);

  it('puts a configured spelling of Complete in the Complete column', () => {
    expect(column('Completed', ['Complete', 'Completed'])).toBe('Complete');
    expect(column(' completed ', ['Complete', 'Completed'])).toBe('Complete');
  });

  it('keeps the canonical name working without any configured spelling', () => {
    expect(column('Complete', undefined)).toBe('Complete');
  });

  it('leaves a spelling that is not configured outside the flow', () => {
    expect(column('Completed', ['Complete'])).toBe('Other status');
    expect(column('Completed', undefined)).toBe('Other status');
  });
});

describe('matchesFilters: repo', () => {
  it('matches a card through its Product Domain even without an MR', () => {
    expect(matchesFilters(tile('app-a', null), repo('app-a'))).toBe(true);
  });

  it('matches a card through its linked MR', () => {
    expect(matchesFilters(tile(null, 'app-a'), repo('app-a'))).toBe(true);
    expect(matchesFilters(tile('app-b', 'app-a'), repo('app-a'))).toBe(true);
  });

  it("matches every repo sharing the card's Product Domain", () => {
    const t = {
      ...tile(null, null),
      card: { ...tile(null, null).card, domainRepoIds: ['app-a', 'app-b'] },
    };
    expect(matchesFilters(t, repo('app-a'))).toBe(true);
    expect(matchesFilters(t, repo('app-b'))).toBe(true);
    expect(matchesFilters(t, repo('app-c'))).toBe(false);
  });

  it('hides a card tied to neither', () => {
    expect(matchesFilters(tile('app-b', null), repo('app-a'))).toBe(false);
    expect(matchesFilters(tile(null, null), repo('app-a'))).toBe(false);
  });
});
