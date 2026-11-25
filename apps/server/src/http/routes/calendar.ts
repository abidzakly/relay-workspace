import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CalendarConfigUpdateSchema, MeetingPriorityBodySchema } from '@relay/shared';
import type { AuditWriter } from '../../audit/auditLog';
import { OAuthStateError, type CalendarService } from '../../services/calendar/calendarService';
import { GoogleError } from '../../services/calendar/googleCalendar';
import { HttpError, parseWith } from '../errors';

const DismissBody = z.object({
  id: z.string().min(1).max(600),
  dismissed: z.boolean().default(true),
});
const CallbackQuery = z.object({
  code: z.string().min(1).max(2048).optional(),
  state: z.string().min(1).max(200).optional(),
  error: z.string().max(200).optional(),
});

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The page Google's redirect lands on. No script (CSP): it only says what happened and links back. */
function callbackPage(ok: boolean, message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Relay · Google Calendar</title></head>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f3ee;color:#121212;font:15px/1.5 'Inter Tight',system-ui,sans-serif">
<main style="max-width:26rem;padding:2rem;text-align:center">
<p style="margin:0 0 .5rem;font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:${ok ? '#3f3aa8' : '#a8261c'}">${ok ? 'Connected' : 'Not connected'}</p>
<h1 style="margin:0 0 .75rem;font-size:22px;letter-spacing:-.02em">${escapeHtml(message)}</h1>
<p style="margin:0 0 1.5rem;color:#5b5a55">${ok ? 'You can close this tab. Relay now watches your meetings.' : 'Go back to Relay and try again.'}</p>
<a href="/settings#google" style="color:inherit">Back to Relay settings</a>
</main></body></html>`;
}

/**
 * Google Calendar (private listener; CSRF + Host checks apply to every write):
 *  GET  /api/calendar/status               connection + settings (never a secret)
 *  PUT  /api/calendar/config               client id / secret, calendars, lead time
 *  POST /api/calendar/connect              -> { url } of Google's consent page
 *  GET  /api/calendar/oauth/callback       Google's redirect (a plain GET, checked by its one-time `state`)
 *  POST /api/calendar/disconnect           forget (and revoke) the refresh token
 *  GET  /api/calendar/meetings             today's meetings for the floating alert
 *  POST /api/calendar/refresh              re-read Google now
 *  POST /api/calendar/meetings/dismiss     { id, dismissed } local only
 *  POST /api/calendar/meetings/priority    { id, calendarId, seriesId, scope, level } local only
 */
export function registerCalendarRoutes(
  app: FastifyInstance,
  deps: { calendar: CalendarService; audit: AuditWriter },
): void {
  const { calendar } = deps;
  const audit = (action: string, after: unknown = null) =>
    deps.audit.write({
      actor: 'user',
      action,
      targetType: 'settings',
      targetId: 'calendar',
      before: null,
      after,
    });

  app.get('/api/calendar/status', async () => calendar.status());

  app.put('/api/calendar/config', async (req) => {
    const body = parseWith(CalendarConfigUpdateSchema, req.body);
    const status = await calendar.saveConfig(body);
    audit('calendar.configSaved', { calendarIds: status.config.calendarIds });
    return status;
  });

  app.post('/api/calendar/connect', async () => {
    try {
      return { url: calendar.beginConnect() };
    } catch (e) {
      if (e instanceof OAuthStateError) throw new HttpError(422, 'calendar_not_ready', e.message);
      throw e;
    }
  });

  app.get('/api/calendar/oauth/callback', async (req, reply) => {
    const q = parseWith(CallbackQuery, req.query);
    void reply.type('text/html; charset=utf-8');
    if (q.error || !q.code || !q.state) {
      return callbackPage(
        false,
        q.error === 'access_denied' ? 'You declined access.' : 'Google did not sign you in.',
      );
    }
    try {
      const { email } = await calendar.completeConnect(q.code, q.state);
      audit('calendar.connected', { email });
      return callbackPage(true, email ? `Signed in as ${email}` : 'Google Calendar connected');
    } catch (e) {
      void reply.code(400);
      const msg =
        e instanceof OAuthStateError || e instanceof GoogleError
          ? e.message
          : 'Something went wrong while connecting.';
      return callbackPage(false, msg);
    }
  });

  app.post('/api/calendar/disconnect', async () => {
    const status = await calendar.disconnect();
    audit('calendar.disconnected');
    return status;
  });

  app.get('/api/calendar/meetings', async () => calendar.list());

  app.post('/api/calendar/refresh', async () => {
    await calendar.refresh();
    return calendar.list();
  });

  app.post('/api/calendar/meetings/dismiss', async (req) => {
    const { id, dismissed } = parseWith(DismissBody, req.body);
    return calendar.dismiss(id, dismissed);
  });

  app.post('/api/calendar/meetings/priority', async (req) => {
    const body = parseWith(MeetingPriorityBodySchema, req.body);
    const list = calendar.setPriority(body);
    audit('calendar.priority', { scope: body.scope, level: body.level });
    return list;
  });
}
