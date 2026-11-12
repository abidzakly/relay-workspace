import { z } from 'zod';
import { EpochMsSchema, NotionIdSchema, RepoIdSchema } from './common';
import { NotificationEventSchema } from './config';
import { JobModeSchema, JobStatusSchema, JobStepNameSchema } from './jobs';

/**
 * GitLab webhook `object_kind` values we subscribe to:
 * merge_requests_events, note_events, pipeline_events, push_events.
 */
export const WEBHOOK_KINDS = ['merge_request', 'note', 'pipeline', 'push'] as const;
export const WebhookKindSchema = z.enum(WEBHOOK_KINDS);
export type WebhookKind = z.infer<typeof WebhookKindSchema>;

/** Lifecycle of a stored webhook delivery. */
export const WEBHOOK_EVENT_STATUSES = ['received', 'processed', 'ignored', 'failed'] as const;
export const WebhookEventStatusSchema = z.enum(WEBHOOK_EVENT_STATUSES);
export type WebhookEventStatus = z.infer<typeof WebhookEventStatusSchema>;

/**
 * Server → browser SSE events (UI is push-driven). Most are cache-invalidation hints
 * for TanStack Query; payloads stay small and never carry secrets.
 */
export const AppEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ping'), at: EpochMsSchema }),
  z.object({ type: z.literal('cards.changed'), cardIds: z.array(NotionIdSchema) }),
  z.object({
    type: z.literal('mrs.changed'),
    repoId: RepoIdSchema,
    iids: z.array(z.number().int().positive()),
  }),
  z.object({ type: z.literal('links.changed') }),
  /** Mobile Dev Cockpit state moved: ready-for-MR list, agent sessions, workspaces. */
  z.object({
    type: z.literal('cockpit.changed'),
    what: z.enum(['ready', 'sessions', 'workspaces']),
    /** Session id for `sessions` (agent finished / waits), when one session is meant. */
    id: z.string().max(64).optional(),
  }),
  /** Test Bench state of a branch moved (ticks, findings, a run). `runId` when an AI run reports progress. */
  z.object({
    type: z.literal('testbench.changed'),
    repoId: z.string().max(100),
    branch: z.string().max(255),
    runId: z.string().max(64).optional(),
  }),
  z.object({ type: z.literal('health.changed') }),
  z.object({ type: z.literal('settings.changed') }),
  /** The Reviews desk was re-read or a local mark changed. */
  z.object({ type: z.literal('reviews.changed') }),
  z.object({ type: z.literal('audit.added'), auditId: z.number().int().positive() }),
  z.object({
    type: z.literal('webhook.received'),
    repoId: RepoIdSchema,
    kind: WebhookKindSchema,
    at: EpochMsSchema,
  }),
  z.object({
    type: z.literal('job.updated'),
    jobId: z.string().min(1),
    status: JobStatusSchema,
    currentStep: JobStepNameSchema.nullable(),
  }),
  z.object({
    type: z.literal('job.log'),
    jobId: z.string().min(1),
    step: JobStepNameSchema.nullable(),
    line: z.string(),
    at: EpochMsSchema,
  }),
  z.object({
    type: z.literal('build.upload'),
    jobId: z.string().min(1),
    sentBytes: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative(),
  }),
  /**
   * A release reached DONE (Parts 7.5, 7.6). Consumers must ignore `dryRun: true`, and key on `jobId`: a resume of a job
   * cut off during DONE emits it again. Notion may not be confirmed yet, since that does not hold the job up.
   */
  z.object({
    type: z.literal('release.done'),
    jobId: z.string().min(1),
    repoId: RepoIdSchema,
    mode: JobModeSchema,
    version: z.string().nullable(),
    dryRun: z.boolean(),
    at: EpochMsSchema,
  }),
  /**
   * Something happened on an MR, whatever the user's notification toggles and `ignoreOwn` say. Comes from the
   * webhook rules of the notifier, plus the dashboard's own merge. Polling alone never produces it.
   */
  z.object({
    type: z.literal('mr.activity'),
    repoId: RepoIdSchema,
    iid: z.number().int().positive(),
    activity: z.enum(['comment', 'approval', 'merge']),
  }),
  /** The gamification ledger gained a row. */
  z.object({ type: z.literal('gamification.changed') }),
  /** Notifications were marked read (other tabs update their list and badge). */
  z.object({ type: z.literal('notifications.changed') }),
  z.object({
    type: z.literal('notification'),
    event: NotificationEventSchema,
    title: z.string(),
    body: z.string(),
    repoId: RepoIdSchema.nullable(),
    url: z.string().nullable(),
  }),
]);
export type AppEvent = z.infer<typeof AppEventSchema>;
export type AppEventType = AppEvent['type'];
