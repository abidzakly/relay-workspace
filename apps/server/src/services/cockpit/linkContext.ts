import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { HttpClient } from '../httpClient';

/**
 * Links a user pastes as extra context for "Explain": the server opens them (the AI engine runs headless and cannot)
 * and puts their text in the prompt. Only http(s); never a private address; redirects are not followed (see
 * `HttpClient`), so a public page cannot bounce us to an internal one.
 */

export const LINKS_MAX = 5;
const LINK_TEXT_MAX = 8_000;
const FETCH_TIMEOUT_MS = 8_000;

export interface OpenedLink {
  url: string;
  /** Page text, or why it could not be opened. */
  text: string;
  ok: boolean;
}

/** `https://…` URLs in free text, without the punctuation that clings to a pasted link. Deduped, in order. */
export function extractLinks(text: string, max = LINKS_MAX): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
    const url = m[0].replace(/[.,;:!?*_~|})\]]+$/, '');
    try {
      const u = new URL(url);
      u.hash = '';
      out.add(u.toString());
    } catch {
      /* not a URL */
    }
    if (out.size >= max) break;
  }
  return [...out];
}

/** Loopback, private, link-local, unique-local and unspecified addresses (IPv4 and IPv6). Pure. */
export function isPrivateAddress(ip: string): boolean {
  const v4 = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/i.exec(ip);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
}

/** True when the host is a public name or address. Resolves names, so a name pointing inside is refused too. */
export async function isPublicHost(
  hostname: string,
  resolve: (h: string) => Promise<string[]> = async (h) =>
    (await lookup(h, { all: true })).map((r) => r.address),
): Promise<boolean> {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    !h ||
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h.endsWith('.local') ||
    h.endsWith('.internal')
  )
    return false;
  if (isIP(h)) return !isPrivateAddress(h);
  if (!h.includes('.')) return false;
  try {
    const addrs = await resolve(h);
    return addrs.length > 0 && addrs.every((a) => !isPrivateAddress(a));
  } catch {
    return false;
  }
}

const clip = (s: string): string =>
  s.length > LINK_TEXT_MAX ? `${s.slice(0, LINK_TEXT_MAX)}\n[…cut]` : s;

/** Visible text of an HTML page: scripts and styles dropped, tags stripped. Good enough for context. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

export interface LinkOpenerDeps {
  http: HttpClient;
  /** The GitLab host (`https://gitlab.example.com`): its MR and issue links go through the authenticated API. */
  gitlabHost: string | null;
  /** Title + description of a GitLab MR or issue. */
  gitlabItem: (
    projectPath: string,
    kind: 'merge_requests' | 'issues',
    iid: number,
  ) => Promise<{ title: string; description: string; state: string }>;
  /** Tests inject. */
  isPublic?: (hostname: string) => Promise<boolean>;
}

export async function openLinks(urls: readonly string[], d: LinkOpenerDeps): Promise<OpenedLink[]> {
  return Promise.all(urls.map((u) => openLink(u, d)));
}

async function openLink(url: string, d: LinkOpenerDeps): Promise<OpenedLink> {
  const fail = (why: string): OpenedLink => ({ url, ok: false, text: `Could not open: ${why}` });
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return fail('not a valid URL');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return fail('only http(s) links');

  if (d.gitlabHost && u.host === new URL(d.gitlabHost).host) {
    const m = /^\/(.+?)\/-\/(merge_requests|issues)\/(\d+)/.exec(u.pathname);
    if (!m) return fail('this GitLab link is not a merge request or issue');
    try {
      const item = await d.gitlabItem(m[1]!, m[2] as 'merge_requests' | 'issues', Number(m[3]));
      return {
        url,
        ok: true,
        text: clip(`${item.title} [${item.state}]\n\n${item.description}`),
      };
    } catch {
      return fail('GitLab refused it or it does not exist');
    }
  }

  if (!(await (d.isPublic ?? isPublicHost)(u.hostname))) return fail('not a public address');
  try {
    const res = await d.http.send({
      url,
      headers: { accept: 'text/html,text/plain,application/json;q=0.8' },
      timeoutMs: FETCH_TIMEOUT_MS,
      maxRetries: 0,
    });
    if (res.status < 200 || res.status >= 300) {
      return fail(
        res.status >= 300 && res.status < 400
          ? 'it redirects (likely to a sign-in page)'
          : `HTTP ${res.status}`,
      );
    }
    const type = String(res.headers['content-type'] ?? '');
    if (/^(image|audio|video)\//i.test(type) || /octet-stream|pdf|zip/i.test(type)) {
      return fail(`unsupported content type ${type.split(';')[0]}`);
    }
    const text = /html/i.test(type) ? htmlToText(res.text) : res.text.trim();
    return text ? { url, ok: true, text: clip(text) } : fail('empty page');
  } catch {
    return fail('network error or timeout');
  }
}
