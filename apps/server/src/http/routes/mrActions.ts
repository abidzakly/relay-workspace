import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  MR_DRAFT_EVENTS,
  MR_STATE_EVENTS,
  MrMergeRequestSchema,
  MrNoteRequestSchema,
  MrUploadRequestSchema,
  MrReplyRequestSchema,
  MrResolveRequestSchema,
  RepoIdSchema,
  ReviewRepoIdSchema,
  MrApproveRequestSchema,
  ReviewCommentRequestSchema,
} from '@relay/shared';
import type { MrActions } from '../../services/mrActions';
import { parseWith, wrapAction as wrap } from '../errors';

const ParamsSchema = z.object({ repo: RepoIdSchema, iid: z.coerce.number().int().positive() });
/** Discussion writes and approvals also reach Reviews projects (`~<projectId>`); merge and state changes do not. */
const ReviewParamsSchema = z.object({
  repo: ReviewRepoIdSchema,
  iid: z.coerce.number().int().positive(),
});

/**
 * MR discussion writes. Private listener only; CSRF header + Host/Origin checks apply to
 * every POST. Each handler IS the user's explicit action (`confirmed` is set inside the service).
 *  - POST /api/mrs/:repo/:iid/reply    { discussionId, body }
 *  - POST /api/mrs/:repo/:iid/resolve  { discussionId, resolved }
 *  - POST /api/mrs/:repo/:iid/comment  { position, body }  (new thread on a diff line, Code Reviewer)
 *  - POST /api/mrs/:repo/:iid/note     { body }            (new top-level comment, MR drawer)
 *  - POST /api/mrs/:repo/:iid/upload   { filename, type, data }  (an image for a comment, base64)
 *  - POST /api/mrs/:repo/:iid/close    (no body; 409 `mr_state_changed` when it is not open any more)
 *  - POST /api/mrs/:repo/:iid/reopen   (no body; 409 `mr_state_changed` when it is not closed any more)
 *  - POST /api/mrs/:repo/:iid/approve  { approved }        (approve / revoke mine, per the repo's approvalMode)
 *  - POST /api/mrs/:repo/:iid/merge    (no body or `{}`; the server re-checks the gate LIVE, 409 `merge_blocked`
 *                                       with `details.gate` when it fails)
 */
export function registerMrActionRoutes(app: FastifyInstance, deps: { actions: MrActions }): void {
  app.post('/api/mrs/:repo/:iid/reply', async (req) => {
    const { repo, iid } = parseWith(ReviewParamsSchema, req.params);
    const body = parseWith(MrReplyRequestSchema, req.body);
    return wrap(() => deps.actions.reply(repo, iid, body));
  });

  app.post('/api/mrs/:repo/:iid/resolve', async (req) => {
    const { repo, iid } = parseWith(ReviewParamsSchema, req.params);
    const body = parseWith(MrResolveRequestSchema, req.body);
    return wrap(() => deps.actions.resolve(repo, iid, body));
  });

  app.post('/api/mrs/:repo/:iid/comment', async (req) => {
    const { repo, iid } = parseWith(ReviewParamsSchema, req.params);
    const body = parseWith(ReviewCommentRequestSchema, req.body);
    return wrap(() => deps.actions.comment(repo, iid, body));
  });

  app.post('/api/mrs/:repo/:iid/note', async (req) => {
    const { repo, iid } = parseWith(ReviewParamsSchema, req.params);
    const body = parseWith(MrNoteRequestSchema, req.body);
    return wrap(() => deps.actions.note(repo, iid, body));
  });

  // An image is up to 5 MB, ~6.7 MB as base64 JSON: above the app's 1 MB default.
  app.post('/api/mrs/:repo/:iid/upload', { bodyLimit: 8 * 1024 * 1024 }, async (req) => {
    const { repo, iid } = parseWith(ReviewParamsSchema, req.params);
    const body = parseWith(MrUploadRequestSchema, req.body);
    return wrap(() => deps.actions.upload(repo, iid, body));
  });

  app.post('/api/mrs/:repo/:iid/approve', async (req) => {
    const { repo, iid } = parseWith(ReviewParamsSchema, req.params);
    const body = parseWith(MrApproveRequestSchema, req.body);
    return wrap(() => deps.actions.approve(repo, iid, body));
  });

  app.post('/api/mrs/:repo/:iid/merge', async (req) => {
    const { repo, iid } = parseWith(ParamsSchema, req.params);
    // No options are accepted (the server always sends squash:false + delete source branch); anything else is a 400.
    parseWith(MrMergeRequestSchema, req.body ?? {});
    return wrap(() => deps.actions.merge(repo, iid));
  });

  // Close / reopen: no body; the server re-reads the state live and writes through `guardedWrite`.
  for (const event of MR_STATE_EVENTS) {
    app.post(`/api/mrs/:repo/:iid/${event}`, async (req) => {
      const { repo, iid } = parseWith(ParamsSchema, req.params);
      return wrap(() => deps.actions.setOpenState(repo, iid, event));
    });
  }

  // Set draft / mark ready: no body; toggles the `Draft:` title prefix after a live re-read.
  for (const event of MR_DRAFT_EVENTS) {
    app.post(`/api/mrs/:repo/:iid/${event}`, async (req) => {
      const { repo, iid } = parseWith(ParamsSchema, req.params);
      return wrap(() => deps.actions.setDraft(repo, iid, event));
    });
  }

  // "Turn off squash": turns the MR's own squash flag off. No body.
  app.post('/api/mrs/:repo/:iid/squash-off', async (req) => {
    const { repo, iid } = parseWith(ParamsSchema, req.params);
    return wrap(() => deps.actions.disableSquash(repo, iid));
  });
}
