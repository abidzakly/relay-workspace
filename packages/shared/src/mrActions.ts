import { z } from 'zod';
import { DiscussionNoteSchema } from './inbox';

/**
 * MR discussion writes (MR Detail):
 *   POST /api/mrs/:repo/:iid/reply    { discussionId, body }
 *   POST /api/mrs/:repo/:iid/resolve  { discussionId, resolved }
 *   POST /api/audit/:id/undo          (only `mr.resolve` is undoable so far)
 */

/**
 * GitLab discussion ids are 40-char hex SHAs (documented). Validated before they reach a URL path,
 * so a request body can never smuggle `/`, `?` or `..` into the GitLab call.
 */
export const DISCUSSION_ID_RE = /^[0-9a-f]{8,64}$/i;
export const DiscussionIdSchema = z.string().regex(DISCUSSION_ID_RE, 'invalid discussion id');

/** Comfortably below GitLab's own note limit; a reply this long is almost certainly a paste mistake. */
export const REPLY_BODY_MAX = 20_000;

export const MrReplyRequestSchema = z.object({
  discussionId: DiscussionIdSchema,
  body: z
    .string()
    .max(REPLY_BODY_MAX, `reply is longer than ${REPLY_BODY_MAX} characters`)
    .refine((s) => s.trim().length > 0, 'reply is empty'),
});
export type MrReplyRequest = z.infer<typeof MrReplyRequestSchema>;

/** `POST /api/mrs/:repo/:iid/note`: a new top-level comment on the MR. */
export const MrNoteRequestSchema = z.object({
  body: z
    .string()
    .max(REPLY_BODY_MAX, `comment is longer than ${REPLY_BODY_MAX} characters`)
    .refine((s) => s.trim().length > 0, 'comment is empty'),
});
export type MrNoteRequest = z.infer<typeof MrNoteRequestSchema>;

export const MrNoteResultSchema = z.object({
  dryRun: z.boolean(),
  auditId: z.number().int().positive(),
  /** The new thread's id; null in dry-run (or if GitLab's answer was unreadable). */
  discussionId: z.string().nullable(),
  note: DiscussionNoteSchema.nullable(),
});
export type MrNoteResult = z.infer<typeof MrNoteResultSchema>;

/** Images a comment may carry. SVG is left out on purpose: it can hold script. */
export const UPLOAD_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export const UPLOAD_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
/** A GitLab upload secret (32 hex) and a plain file name: both end up in URL paths. */
export const UPLOAD_SECRET_RE = /^[0-9a-f]{32}$/;
export const UPLOAD_FILENAME_RE = /^[\w.() -]{1,120}$/;

/** `POST /api/mrs/:repo/:iid/upload`: an image for a comment, base64 (the API takes JSON only). */
export const MrUploadRequestSchema = z.object({
  filename: z.string().regex(UPLOAD_FILENAME_RE, 'invalid file name'),
  type: z.enum(UPLOAD_IMAGE_TYPES),
  /** base64 of at most `UPLOAD_IMAGE_MAX_BYTES`. */
  data: z
    .string()
    .max(Math.ceil(UPLOAD_IMAGE_MAX_BYTES / 3) * 4, 'image is larger than 5 MB')
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'invalid image data'),
});
export type MrUploadRequest = z.infer<typeof MrUploadRequestSchema>;

export const MrUploadResultSchema = z.object({
  dryRun: z.boolean(),
  auditId: z.number().int().positive(),
  /** GitLab's markdown for the file (`![name](/uploads/<secret>/<name>)`); null in dry-run. */
  markdown: z.string().nullable(),
});
export type MrUploadResult = z.infer<typeof MrUploadResultSchema>;

export const MrResolveRequestSchema = z.object({
  discussionId: DiscussionIdSchema,
  resolved: z.boolean(),
});
export type MrResolveRequest = z.infer<typeof MrResolveRequestSchema>;

export const MrReplyResultSchema = z.object({
  /** true = simulated (global dry-run): nothing was sent to GitLab, the audit row says so. */
  dryRun: z.boolean(),
  auditId: z.number().int().positive(),
  discussionId: z.string(),
  /** The created note as GitLab returned it; null in dry-run (or if GitLab's answer was unreadable). */
  note: DiscussionNoteSchema.nullable(),
});
export type MrReplyResult = z.infer<typeof MrReplyResultSchema>;

export const MrResolveResultSchema = z.object({
  dryRun: z.boolean(),
  auditId: z.number().int().positive(),
  discussionId: z.string(),
  /** The state that was requested (dry-run) or that GitLab reported back (live). */
  resolved: z.boolean(),
  /** true = the audit row carries an undo token (`POST /api/audit/:auditId/undo`). Never in dry-run. */
  undoable: z.boolean(),
});
export type MrResolveResult = z.infer<typeof MrResolveResultSchema>;

/** `POST /api/mrs/:repo/:iid/close` and `/reopen`. The value is GitLab's `state_event`. */
export const MR_STATE_EVENTS = ['close', 'reopen'] as const;
export type MrStateEvent = (typeof MR_STATE_EVENTS)[number];

export const MrStateChangeResultSchema = z.object({
  /** true = simulated (global dry-run): nothing was sent to GitLab. */
  dryRun: z.boolean(),
  auditId: z.number().int().positive(),
  event: z.enum(MR_STATE_EVENTS),
  /** GitLab reports the MR in the requested state. false in dry-run, or when GitLab accepted but did not apply it. */
  applied: z.boolean(),
});
export type MrStateChangeResult = z.infer<typeof MrStateChangeResultSchema>;

/** `POST /api/mrs/:repo/:iid/draft` and `/ready`: toggles the MR's draft flag (GitLab's `Draft:` title prefix). */
export const MR_DRAFT_EVENTS = ['draft', 'ready'] as const;
export type MrDraftEvent = (typeof MR_DRAFT_EVENTS)[number];

export const MrDraftResultSchema = z.object({
  dryRun: z.boolean(),
  auditId: z.number().int().positive(),
  event: z.enum(MR_DRAFT_EVENTS),
  /** GitLab reports the MR in the requested draft state. false in dry-run. */
  applied: z.boolean(),
});
export type MrDraftResult = z.infer<typeof MrDraftResultSchema>;

export const UndoResultSchema = z.object({
  dryRun: z.boolean(),
  /** The audit row that was reverted. */
  undoneId: z.number().int().positive(),
  /** The new `undo` audit row. */
  auditId: z.number().int().positive(),
  action: z.string(),
  /**
   * Only for a batch undo ("Undo bulk"). Cards in `blocked` were left alone (edited elsewhere since, or Notion refused);
   * the batch stays undoable for them. Absent for single-target undos.
   */
  batch: z
    .object({
      restored: z.array(
        z.object({ cardId: z.string(), title: z.string(), status: z.string().nullable() }),
      ),
      blocked: z.array(
        z.object({ cardId: z.string(), title: z.string(), code: z.string(), message: z.string() }),
      ),
    })
    .optional(),
});
export type UndoResult = z.infer<typeof UndoResultSchema>;
