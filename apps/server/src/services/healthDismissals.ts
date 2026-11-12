import { eq } from 'drizzle-orm';
import { healthFindingKey, type HealthFindingRef } from '@relay/shared';
import type { AppDb } from '../db';
import { healthDismissals } from '../db/schema';

/**
 * Sync Health findings marked as false positives (local only). A dismissed finding is left out of the report's
 * verdicts and counts, so notifications, badges and XP ignore it too. Restoring deletes the row.
 */

/** Finding key → when it was marked. */
export function loadDismissals(app: AppDb): Map<string, number> {
  return new Map(
    app.db
      .select({ key: healthDismissals.key, at: healthDismissals.createdAt })
      .from(healthDismissals)
      .all()
      .map((r) => [r.key, r.at] as const),
  );
}

export function dismissFinding(app: AppDb, ref: HealthFindingRef, now: number): void {
  app.db
    .insert(healthDismissals)
    .values({
      key: healthFindingKey(ref),
      ruleId: ref.ruleId,
      cardId: ref.cardId,
      repoId: ref.repoId,
      mrIid: ref.mrIid,
      createdAt: now,
    })
    .onConflictDoNothing()
    .run();
}

export function restoreFinding(app: AppDb, ref: HealthFindingRef): void {
  app.db
    .delete(healthDismissals)
    .where(eq(healthDismissals.key, healthFindingKey(ref)))
    .run();
}
