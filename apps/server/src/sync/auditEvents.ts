import type { AuditEntry } from '@relay/shared';
import type { EventBus } from './eventBus';

/**
 * Bridges audit rows to the bus: every row emits `audit.added`; rows that change configuration
 * (`settings.*`, `repo.*`) also emit `settings.changed`. Ids only, never the before/after content.
 */
export function auditToBus(bus: EventBus): (entry: AuditEntry) => void {
  return (entry) => {
    bus.emit({ type: 'audit.added', auditId: entry.id });
    if (entry.action.startsWith('settings.') || entry.action.startsWith('repo.')) {
      bus.emit({ type: 'settings.changed' });
    }
  };
}
