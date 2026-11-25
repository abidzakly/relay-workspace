import { eq } from 'drizzle-orm';
import type { Card } from '@relay/shared';
import type { ConfigStore } from '../config/store';
import type { AppDb } from '../db';
import { settings } from '../db/schema';
import { listCards } from './notionStore';

/**
 * Branch → Notion card links made in Relay. A card normally finds its branch through its "Branch formula"; a branch
 * pushed from elsewhere (IDE, terminal, a colleague) has no such card, and a formula cannot be written. The user links
 * the branch to an existing card instead, and that link wins over the formula everywhere a card is looked up by
 * branch (Create MR, Test Bench, Review).
 *
 * Kept as a `state.cardLinks` settings row (no migration): `{ [repoId]: { [branch]: cardId } }`.
 */

const STATE = 'cardLinks';
type Links = Record<string, Record<string, string>>;

/** Read straight from the settings table so services without a ConfigStore can resolve links too. */
export function readCardLinks(app: AppDb): Links {
  const row = app.db
    .select()
    .from(settings)
    .where(eq(settings.key, `state.${STATE}`))
    .get();
  if (!row) return {};
  try {
    const v = JSON.parse(row.value) as unknown;
    return typeof v === 'object' && v !== null ? (v as Links) : {};
  } catch {
    return {};
  }
}

export function linkedCardId(app: AppDb, branch: string, repoId?: string): string | null {
  const links = readCardLinks(app);
  if (repoId) return links[repoId]?.[branch] ?? null;
  for (const byBranch of Object.values(links)) if (byBranch[branch]) return byBranch[branch]!;
  return null;
}

/**
 * The card for a branch: a link made in Relay first, else the card whose Branch formula is the branch. `repoId`
 * narrows links to one repository (callers that know it should pass it).
 */
export function cardForBranch(
  app: AppDb,
  branch: string,
  repoId?: string,
  cards: readonly Card[] = listCards(app),
): { card: Card; linked: boolean } | null {
  const id = linkedCardId(app, branch, repoId);
  if (id) {
    const linked = cards.find((c) => c.id === id);
    if (linked) return { card: linked, linked: true };
  }
  const byFormula = cards.find((c) => c.branchName?.trim() === branch);
  return byFormula ? { card: byFormula, linked: false } : null;
}

export function setCardLink(
  config: ConfigStore,
  repoId: string,
  branch: string,
  cardId: string,
): void {
  const links = config.getState<Links>(STATE) ?? {};
  config.setState(STATE, { ...links, [repoId]: { ...(links[repoId] ?? {}), [branch]: cardId } });
}

export function removeCardLink(config: ConfigStore, repoId: string, branch: string): boolean {
  const links = config.getState<Links>(STATE) ?? {};
  if (!links[repoId]?.[branch]) return false;
  const { [branch]: _gone, ...rest } = links[repoId];
  const next = { ...links };
  if (Object.keys(rest).length > 0) next[repoId] = rest;
  else delete next[repoId];
  config.setState(STATE, next);
  return true;
}
