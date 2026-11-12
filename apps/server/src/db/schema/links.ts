import {
  check,
  foreignKey,
  index,
  integer,
  sqliteTable,
  text,
  unique,
} from 'drizzle-orm/sqlite-core';
import { MATCH_BY } from '@relay/shared';
import { createdAtCol, inList } from './_helpers';
import { cards } from './cards';
import { mrs } from './gitlab';

/**
 * card ↔ MR links. Deliberately NOT unique per card or per MR so that
 * duplicates and mismatches are representable (flagged, never auto-resolved).
 * Unique per (card, MR) pair only.
 */
export const links = sqliteTable(
  'links',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    cardId: text('card_id')
      .notNull()
      .references(() => cards.id, { onDelete: 'cascade' }),
    repoId: text('repo_id').notNull(),
    mrIid: integer('mr_iid').notNull(),
    matchBy: text('match_by').notNull(),
    conflict: integer('conflict', { mode: 'boolean' }).notNull().default(false),
    createdAt: createdAtCol(),
  },
  (t) => [
    foreignKey({ columns: [t.repoId, t.mrIid], foreignColumns: [mrs.repoId, mrs.iid] }).onDelete(
      'cascade',
    ),
    unique('links_card_mr_uq').on(t.cardId, t.repoId, t.mrIid),
    check('links_match_by_chk', inList(t.matchBy, MATCH_BY)),
    index('links_card_idx').on(t.cardId),
    index('links_mr_idx').on(t.repoId, t.mrIid),
  ],
);
