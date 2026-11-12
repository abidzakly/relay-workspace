import { cockpitAttachments } from '../../db/schema';
import type { AppDb } from '../../db/open';

export type AttachmentKind = 'card' | 'thread' | 'finding';

export interface AttachmentRecord {
  group: string;
  workspaceId: string;
  kind: AttachmentKind;
  /** Card id, `<repoId>!<iid>#<discussionId>`, or finding id. */
  refId: string;
}

/** Remembers what an attachment folder belongs to; the first record wins (a group is reused per thread/finding). */
export function recordAttachments(app: AppDb, a: AttachmentRecord, now = Date.now()): void {
  app.db
    .insert(cockpitAttachments)
    .values({ ...a, createdAt: now })
    .onConflictDoNothing()
    .run();
}
