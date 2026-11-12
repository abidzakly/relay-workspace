import { z } from 'zod';
import { EpochMsSchema, RepoIdSchema } from './common';
import { NotificationEventSchema } from './config';
import { isSafeAppPath } from './push';

/**
 * Notification center. A stored notification holds FACTS only: what happened and what it was about (`subject`).
 * What can be done about it (`live`) is worked out again on every read from the current state, so an old row can
 * never offer "Merge now" on an MR that has been merged since.
 */

export const NotificationSubjectSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('mr'),
    repoId: RepoIdSchema,
    iid: z.number().int().positive(),
    /** Comment / reply: the thread it belongs to. */
    discussionId: z.string().nullable().default(null),
    /** Pipeline failure: the pipeline that failed. */
    pipelineId: z.number().int().nullable().default(null),
  }),
  z.object({ kind: z.literal('card'), cardId: z.string(), deadline: z.number() }),
  z.object({ kind: z.literal('job'), jobId: z.string() }),
  z.object({ kind: z.literal('branch'), repoId: RepoIdSchema, branch: z.string() }),
  z.object({ kind: z.literal('session'), sessionId: z.string(), hasFiles: z.boolean() }),
  z.object({ kind: z.literal('mismatch'), key: z.string() }),
  z.object({ kind: z.literal('month'), month: z.string() }),
]);
export type NotificationSubject = z.infer<typeof NotificationSubjectSchema>;

export const NOTIFICATION_LIVE_STATUSES = ['actionable', 'info', 'resolved'] as const;

/** A button. It only ever navigates: writes stay behind their own gates and confirmations. */
export const NotificationActionSchema = z.object({
  label: z.string(),
  url: z.string().refine(isSafeAppPath, 'url must be a dashboard path'),
  /** Open the MR's merge dialog on arrival (only if the live gate allows; merging still needs Confirm). */
  openMerge: z.boolean().optional(),
});
export type NotificationAction = z.infer<typeof NotificationActionSchema>;

export const NotificationLiveSchema = z.object({
  status: z.enum(NOTIFICATION_LIVE_STATUSES),
  /** Where things stand now, e.g. "Merged 2h ago". */
  note: z.string().nullable(),
  actions: z.array(NotificationActionSchema),
});
export type NotificationLive = z.infer<typeof NotificationLiveSchema>;

export const NOTIFICATION_PRIORITIES = ['urgent', 'high', 'normal', 'low'] as const;
export const NotificationPrioritySchema = z.enum(NOTIFICATION_PRIORITIES);
export type NotificationPriority = z.infer<typeof NotificationPrioritySchema>;

export const NOTIFICATION_CATEGORIES = [
  'mr',
  'pipeline',
  'sla',
  'build',
  'agent',
  'system',
] as const;
export const NotificationCategorySchema = z.enum(NOTIFICATION_CATEGORIES);
export type NotificationCategory = z.infer<typeof NotificationCategorySchema>;

/**
 * Where a notification stands: still needs you, went stale (old, or its source cannot be checked), was dealt with
 * somewhere other than this page (`resolved` live status), or is only for information.
 */
export const NOTIFICATION_LIFECYCLES = [
  'needs_action',
  'stale',
  'handled_elsewhere',
  'info',
] as const;
export const NotificationLifecycleSchema = z.enum(NOTIFICATION_LIFECYCLES);
export type NotificationLifecycle = z.infer<typeof NotificationLifecycleSchema>;

export const NotificationItemSchema = z.object({
  id: z.number().int().positive(),
  event: z.union([NotificationEventSchema, z.literal('test')]),
  title: z.string(),
  body: z.string(),
  repoId: RepoIdSchema.nullable(),
  at: EpochMsSchema,
  readAt: EpochMsSchema.nullable(),
  live: NotificationLiveSchema,
  priority: NotificationPrioritySchema,
  category: NotificationCategorySchema,
  lifecycle: NotificationLifecycleSchema,
});
export type NotificationItem = z.infer<typeof NotificationItemSchema>;

export const NOTIFICATION_FILTERS = ['all', 'unread', 'actionable'] as const;
export const NotificationFilterSchema = z.enum(NOTIFICATION_FILTERS);
export type NotificationFilter = z.infer<typeof NotificationFilterSchema>;

/** `a,b` in a query string -> `['a', 'b']`. Empty / absent = no filter. */
const csv = <T extends z.ZodType>(item: T) =>
  z.preprocess(
    (v) => (typeof v === 'string' ? v.split(',').filter(Boolean) : v),
    z.array(item).default([]),
  );

export const NotificationFacetsSchema = z.object({
  lifecycle: csv(NotificationLifecycleSchema),
  priority: csv(NotificationPrioritySchema),
  category: csv(NotificationCategorySchema),
  repoId: RepoIdSchema.optional(),
});
export type NotificationFacets = z.infer<typeof NotificationFacetsSchema>;

export const NotificationListQuerySchema = NotificationFacetsSchema.extend({
  /** `actionable` stays as an alias of `lifecycle=needs_action`. */
  filter: NotificationFilterSchema.default('all'),
  /** The `nextCursor` of the previous page. */
  cursor: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export type NotificationListQuery = z.infer<typeof NotificationListQuerySchema>;

export const NotificationListSchema = z.object({
  items: z.array(NotificationItemSchema),
  nextCursor: z.number().int().positive().nullable(),
});
export type NotificationList = z.infer<typeof NotificationListSchema>;

export const NotificationUnreadSchema = z.object({
  unread: z.number().int().nonnegative(),
  /** Of the newest unread rows, those that still need you (bounded scan). */
  needsAction: z.number().int().nonnegative(),
});
export type NotificationUnread = z.infer<typeof NotificationUnreadSchema>;

export const NotificationSummaryQuerySchema = NotificationFacetsSchema.pick({ repoId: true });

/** Counts for the filter tabs. A scan is capped: `capped` = at least these many. */
export const NotificationSummarySchema = z.object({
  lifecycle: z.record(NotificationLifecycleSchema, z.number().int().nonnegative()),
  /** The same counts over unread rows only: what "Clear stale and handled" would still clear. */
  unreadLifecycle: z.record(NotificationLifecycleSchema, z.number().int().nonnegative()),
  unread: z.number().int().nonnegative(),
  unreadNeedsAction: z.number().int().nonnegative(),
  capped: z.boolean(),
});
export type NotificationSummary = z.infer<typeof NotificationSummarySchema>;
