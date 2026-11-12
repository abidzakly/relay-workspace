import { describe, expect, it } from 'vitest';
import { domainResolver } from './domain';

describe('domainResolver', () => {
  const resolve = domainResolver([
    { id: 'app-a', name: 'Vessel Monitoring', productDomains: [] },
    { id: 'app-b', name: 'App B', productDomains: ['Fleet  Tracking'] },
    { id: 'app-c', name: 'App C', productDomains: ['fleet tracking', 'Crew'] },
  ]);

  it('maps a configured Product Domain to its repo (case/space-insensitive)', () => {
    expect(resolve('Crew')).toEqual({ state: 'connected', repoIds: ['app-c'], repoId: 'app-c' });
  });

  it('one Product Domain can be shared by several repos', () => {
    expect(resolve('FLEET tracking')).toEqual({
      state: 'connected',
      repoIds: ['app-b', 'app-c'],
      repoId: 'app-b',
    });
  });

  it('a repo with no Product Domain (None) matches no card, not even by its name', () => {
    expect(resolve('Vessel Monitoring')).toEqual({
      state: 'unconnected',
      repoIds: [],
      repoId: null,
    });
  });

  it('a card without a Product Domain is unknown', () => {
    expect(resolve(null)).toEqual({ state: 'unknown', repoIds: [], repoId: null });
    expect(resolve('  ')).toEqual({ state: 'unknown', repoIds: [], repoId: null });
  });
});
