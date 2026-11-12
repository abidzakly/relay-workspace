import type { FastifyInstance } from 'fastify';
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from '@relay/shared';
import { HttpError } from './errors';

/** CSP for the dashboard: no inline/eval scripts, nothing from other origins. */
export const CSP = [
  "default-src 'self'",
  // WebAssembly compile only (not JS eval): three's meshopt decoder unpacks the compressed crystals with it.
  "script-src 'self' 'wasm-unsafe-eval'",
  // React/R3F set style attributes at runtime; styles cannot run script.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface SecurityOptions {
  /** Port the dashboard listens on (Host/Origin allowlist). */
  port: number;
  /** Extra UI dev-server port (Vite) whose proxied requests are allowed. */
  devUiPort?: number;
  /**
   * Hostnames a TLS reverse proxy on this machine serves the dashboard under (`tailscale serve`, say), from
   * `DASHBOARD_TLS_HOSTS`. They are allowed only on https, port 443.
   */
  tlsHosts?: readonly string[];
  /**
   * Tailscale logins allowed through `tlsHosts` (`DASHBOARD_TLS_USERS`). `tailscale serve` sets `Tailscale-User-Login`
   * itself and drops any the client sent, so a request on a TLS host without an allowed login is refused. This keeps
   * other members of a shared tailnet out. Requests on the loopback hosts are not checked.
   */
  tlsUsers?: readonly string[];
}

const TS_LOGIN_HEADER = 'tailscale-user-login';

function loopbackHosts(o: SecurityOptions): string[] {
  const ports = [o.port, ...(o.devUiPort ? [o.devUiPort] : [])];
  return ports.flatMap((p) => [`127.0.0.1:${p}`, `localhost:${p}`]);
}

export function allowedHosts(o: SecurityOptions): Set<string> {
  const tls = (o.tlsHosts ?? []).flatMap((h) => [h, `${h}:443`]);
  return new Set([...loopbackHosts(o), ...tls]);
}

export function allowedOrigins(o: SecurityOptions): Set<string> {
  return new Set([
    ...loopbackHosts(o).map((h) => `http://${h}`),
    ...(o.tlsHosts ?? []).map((h) => `https://${h}`),
  ]);
}

/**
 * Registers the dashboard's browser-facing protections:
 *  - Host allowlist (blocks DNS-rebinding: a hostile site resolving to 127.0.0.1)
 *  - CSP + hardening headers, `no-store` on /api
 *  - CSRF: every POST/PUT/PATCH/DELETE needs `X-Requested-With: relay` (a custom header forces a
 *    CORS preflight, which this server never approves) and, when the browser sends one, an allowed Origin.
 *    There are no cookies/sessions yet, so SameSite has nothing to protect. No live sample was checked.
 */
export function installSecurity(app: FastifyInstance, o: SecurityOptions): void {
  const hosts = allowedHosts(o);
  const origins = allowedOrigins(o);
  const tlsHosts = new Set((o.tlsHosts ?? []).flatMap((h) => [h, `${h}:443`]));
  const tlsUsers = new Set((o.tlsUsers ?? []).map((u) => u.toLowerCase()));

  app.addHook('onRequest', (req, _reply, done) => {
    const host = (req.headers.host ?? '').toLowerCase();
    if (!hosts.has(host)) return done(new HttpError(403, 'bad_host'));
    if (tlsHosts.has(host)) {
      const login = req.headers[TS_LOGIN_HEADER];
      if (typeof login !== 'string' || !tlsUsers.has(login.toLowerCase())) {
        return done(new HttpError(403, 'bad_user'));
      }
    }

    if (STATE_CHANGING.has(req.method)) {
      const origin = req.headers.origin;
      if (origin !== undefined && !origins.has(origin.toLowerCase())) {
        return done(new HttpError(403, 'bad_origin'));
      }
      if (req.headers[CSRF_HEADER_NAME] !== CSRF_HEADER_VALUE) {
        return done(new HttpError(403, 'csrf'));
      }
    }
    done();
  });

  app.addHook('onSend', (req, reply, payload, done) => {
    void reply.header('Content-Security-Policy', CSP);
    void reply.header('X-Content-Type-Options', 'nosniff');
    void reply.header('X-Frame-Options', 'DENY');
    void reply.header('Referrer-Policy', 'no-referrer');
    void reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    void reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    if (req.url.startsWith('/api/')) void reply.header('Cache-Control', 'no-store');
    done(null, payload);
  });
}
