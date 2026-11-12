import { describe, expect, it } from 'vitest';
import type { DeckSource } from '@relay/shared';
import { deckPath, deckSourceFrom } from './deckApi';

describe('deck paths', () => {
  it.each<DeckSource>([
    { kind: 'mr', repoId: 'app', iid: 12 },
    { kind: 'compare', repoId: 'app', from: 'main', to: 'feat/x' },
    { kind: 'local', workspaceId: 'ws1', mode: 'turn', base: '3' },
  ])('round-trips %o', (s) => {
    const url = new URL(deckPath(s), 'http://x');
    const [, , kind, id] = url.pathname.split('/');
    expect(deckSourceFrom(kind, decodeURIComponent(id!), url.searchParams)).toEqual(s);
  });
});
