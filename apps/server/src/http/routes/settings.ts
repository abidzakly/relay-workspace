import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { GlobalConfigStoredSchema, SECRET_MASK, SecretSchema } from '@relay/shared';
import type { AuditWriter } from '../../audit/auditLog';
import type { ConfigStore } from '../../config/store';
import { identityKey } from '../../services/notionStore';
import { parseWith } from '../errors';

export interface SettingsRouteDeps {
  store: ConfigStore;
  audit: AuditWriter;
  /** Starts a sync without waiting. Called when the "me" settings change, so cards are re-checked at once. */
  refreshSync?: () => Promise<unknown>;
}

const identityOf = (s: {
  notion: { props: { assignee: string }; assigneeAliases: readonly string[] };
  gitlab: { myUsername?: string | undefined };
}) =>
  identityKey({
    assigneeProp: s.notion.props.assignee,
    myUsername: s.gitlab.myUsername,
    aliases: s.notion.assigneeAliases,
  });

/** `notion.token`: new secret, the UI's mask / omitted (= unchanged), or `null` (= clear). */
const NotionTokenField = z.union([z.literal(SECRET_MASK), SecretSchema, z.null()]).optional();

export function registerSettingsRoutes(
  app: FastifyInstance,
  { store, audit, refreshSync }: SettingsRouteDeps,
): void {
  app.get('/api/settings', async () => ({ settings: store.getGlobalPublic() }));

  // Full replace of the non-secret settings (omitted fields take their defaults); the token is separate.
  app.put('/api/settings', async (req) => {
    const rawToken = (req.body as { notion?: { token?: unknown } } | null)?.notion?.token;
    const token = parseWith(NotionTokenField, rawToken);
    const stored = parseWith(GlobalConfigStoredSchema, req.body);
    const before = store.getGlobalPublic();
    const settings = store.saveGlobal(stored, token);
    audit.write({
      actor: 'user',
      action: before.dryRun !== settings.dryRun ? 'settings.dryRun' : 'settings.update',
      targetType: 'settings',
      targetId: 'global',
      before,
      after: { ...settings, notionTokenChanged: token !== undefined && token !== SECRET_MASK },
    });
    // The sync notices the new identity itself and runs a full baseline; this only makes it start now.
    if (refreshSync && identityOf(before) !== identityOf(settings)) {
      void refreshSync().catch(() => undefined);
    }
    return { settings };
  });
}
