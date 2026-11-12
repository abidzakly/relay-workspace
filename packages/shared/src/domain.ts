import { z } from 'zod';

/** Product Domain → repo state of a card. */
export const DOMAIN_STATES = ['connected', 'unconnected', 'unknown'] as const;
export const DomainStateSchema = z.enum(DOMAIN_STATES);
export type DomainState = z.infer<typeof DomainStateSchema>;

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

export interface DomainRepo {
  id: string;
  name: string;
  productDomains?: readonly string[];
}

/** The Product Domains a repo answers to. Empty = the repo has no Product Domain (it matches no card). */
export function repoDomainNames(repo: DomainRepo): string[] {
  return [...(repo.productDomains ?? [])];
}

export interface DomainResolution {
  state: DomainState;
  /** Every repo serving the domain, in registration order. One Product Domain may be shared by several repos. */
  repoIds: string[];
  /** The first of `repoIds` (null when none). */
  repoId: string | null;
}

/** Builds a resolver from Product Domain → repo ids (one domain may map to several repos). */
export function domainResolver(repos: readonly DomainRepo[]) {
  const byName = new Map<string, string[]>();
  for (const r of repos)
    for (const n of new Set(repoDomainNames(r).map(norm))) {
      const ids = byName.get(n);
      if (ids) ids.push(r.id);
      else byName.set(n, [r.id]);
    }
  return (domain: string | null | undefined): DomainResolution => {
    if (!domain || !domain.trim()) return { state: 'unknown', repoIds: [], repoId: null };
    const repoIds = [...(byName.get(norm(domain)) ?? [])];
    return {
      state: repoIds.length > 0 ? 'connected' : 'unconnected',
      repoIds,
      repoId: repoIds[0] ?? null,
    };
  };
}
