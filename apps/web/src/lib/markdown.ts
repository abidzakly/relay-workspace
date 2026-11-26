import DOMPurify from 'dompurify';
import { Marked, type Tokens, type TokenizerAndRendererExtension } from 'marked';
import type { MrRef } from '@relay/shared';
import { SIZE_VALUE_RE, sizeAttrs } from './imageSize';

/**
 * Markdown from GitLab (MR descriptions, comments) is USER CONTENT: `marked` -> DOMPurify -> render.
 *
 *  1. `marked` turns markdown into HTML (raw HTML in the source is passed through, as GitLab allows it).
 *  2. DOMPurify keeps only an ALLOW-LIST of tags and attributes (no script / style / iframe / form / svg / math;
 *     no `on*` handlers, no `data-*`, no `style`; `class` only from our own short list).
 *  3. Links: only http(s), mailto and our own MR paths survive (no `javascript:`, `data:`, relative GitLab paths);
 *     every outside link opens in a new tab with `rel="noopener noreferrer nofollow"`.
 *  4. Images: only GitLab comment uploads of the current repo are shown, through our same-origin proxy
 *     (`/api/mrs/:repo/uploads/…`, the CSP allows `img-src 'self'` only). Any other image becomes a plain link.
 *     GitLab's size block (`![x](url){width=300}`) becomes `width` / `height` on the image.
 *  5. `!123` (another MR of the same repo) links to its drawer; `@user` is highlighted. Both skip code.
 */

/** What the text is about: lets `!123` and comment images resolve. Without it, both stay plain. */
export interface MarkdownContext {
  repo?: string;
  /** Known MRs of `repo`, keyed by iid (state shown as "!166 (closed)"). */
  refs?: Readonly<Record<string, MrRef>>;
  /** Usernames that are "me" (their mentions are marked). */
  me?: readonly string[];
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A configured repo id, or a Reviews project (`~<projectId>`). */
const REPO_RE = /^(?:[a-z0-9-]+|~[1-9][0-9]{0,11})$/;
/** A GitLab comment upload, relative (`/uploads/…`) or under a project URL (`https://host/g/p/uploads/…`). */
const UPLOAD_RE = /(?:^|\/)uploads\/([0-9a-f]{32})\/([^/?#]+)$/;
/** Must match the server's `UPLOAD_FILENAME_RE`. */
const FILENAME_RE = /^[\w.() -]{1,120}$/;

/** Our proxy path for a GitLab upload of `repo`, or null when it is not one. */
export function uploadSrc(href: string, repo: string | undefined): string | null {
  if (!repo || !REPO_RE.test(repo)) return null;
  const m = UPLOAD_RE.exec(href.trim());
  if (!m) return null;
  let name: string;
  try {
    name = decodeURIComponent(m[2]!);
  } catch {
    return null;
  }
  if (!FILENAME_RE.test(name)) return null;
  return `/api/mrs/${repo}/uploads/${m[1]}/${encodeURIComponent(name)}`;
}

let ctx: MarkdownContext = {};

/** The last character before this token, when the previous token is plain text (`a!1` is not a ref). */
function prevChar(tokens: Tokens.Generic[]): string {
  const last = tokens[tokens.length - 1];
  if (!last || typeof last.raw !== 'string') return '';
  return last.raw.slice(-1);
}
const WORDISH = /[\w/&#!@.]/;

const mrRef: TokenizerAndRendererExtension = {
  name: 'mrRef',
  level: 'inline',
  start(src) {
    return /!\d/.exec(src)?.index;
  },
  tokenizer(src, tokens) {
    const m = /^!(\d{1,7})(?!\w)/.exec(src);
    if (!m || WORDISH.test(prevChar(tokens as Tokens.Generic[]))) return undefined;
    return { type: 'mrRef', raw: m[0], iid: m[1] };
  },
  renderer(token) {
    const iid = String(token.iid);
    const ref = ctx.refs?.[iid];
    if (!ctx.repo || !REPO_RE.test(ctx.repo)) return `!${iid}`;
    const state = ref && ref.state !== 'opened' ? ` (${escapeHtml(ref.state)})` : '';
    const title = ref ? ` title="${escapeHtml(ref.title)}"` : '';
    return `<a class="mr-ref" href="/mrs/${ctx.repo}/${iid}"${title}>!${iid}${state}</a>`;
  },
};

const mention: TokenizerAndRendererExtension = {
  name: 'mention',
  level: 'inline',
  start(src) {
    return /@[A-Za-z0-9_]/.exec(src)?.index;
  },
  tokenizer(src, tokens) {
    const m = /^@([A-Za-z0-9_][A-Za-z0-9_.-]{0,254}[A-Za-z0-9_]|[A-Za-z0-9_])/.exec(src);
    if (!m || WORDISH.test(prevChar(tokens as Tokens.Generic[]))) return undefined;
    return { type: 'mention', raw: m[0], user: m[1] };
  },
  renderer(token) {
    const user = String(token.user);
    const mine = ctx.me?.some((u) => u.toLowerCase() === user.toLowerCase());
    return `<span class="${mine ? 'mention mention-me' : 'mention'}">@${escapeHtml(user)}</span>`;
  },
};

function renderImage(
  href: string,
  title: string | null | undefined,
  text: string,
  size: { width: string | null; height: string | null } = { width: null, height: null },
): string {
  const label = escapeHtml(text || 'image');
  const t = title ? ` title="${escapeHtml(title)}"` : '';
  const src = uploadSrc(href, ctx.repo);
  if (!src) return `<a href="${escapeHtml(href)}"${t}>Image: ${label}</a>`;
  const w = size.width ? ` width="${size.width}"` : '';
  const h = size.height ? ` height="${size.height}"` : '';
  return `<img class="md-img" src="${src}" alt="${label}"${t}${w}${h} loading="lazy">`;
}

/** GitLab's `![alt](url){width=300 height=200}`: an image with a size block right after it. */
const sizedImage: TokenizerAndRendererExtension = {
  name: 'sizedImage',
  level: 'inline',
  start: (src) => {
    const i = src.indexOf('![');
    return i < 0 ? undefined : i;
  },
  tokenizer(src) {
    const m = /^!\[([^\]\n]*)\]\(([^()\s]+)(?:\s+"([^"\n]*)")?\)(\{[^}\n]*\})/.exec(src);
    if (!m) return undefined;
    const size = sizeAttrs(m[4]);
    if (!size.width && !size.height) return undefined;
    return {
      type: 'sizedImage',
      raw: m[0],
      alt: m[1] ?? '',
      href: m[2] ?? '',
      title: m[3] ?? null,
      ...size,
    };
  },
  renderer(t) {
    const tok = t as Tokens.Generic & {
      alt: string;
      href: string;
      title: string | null;
      width: string | null;
      height: string | null;
    };
    return renderImage(tok.href, tok.title, tok.alt, { width: tok.width, height: tok.height });
  },
};

const marked = new Marked({
  gfm: true,
  breaks: true,
  async: false,
  extensions: [sizedImage, mrRef, mention],
  renderer: {
    image({ href, title, text }) {
      return renderImage(href, title, text);
    },
  },
});

const ALLOWED_TAGS = [
  'a', 'p', 'br', 'hr', 'blockquote', 'pre', 'code', 'em', 'strong', 'del', 's', 'ins', 'mark', 'sub', 'sup',
  'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'details', 'summary', 'span', 'div', 'kbd', 'input', 'img',
]; // prettier-ignore

/** `input` is only kept for GFM task-list checkboxes (see hook below); everything else about it is stripped. */
const ALLOWED_ATTR = [
  'href',
  'title',
  'colspan',
  'rowspan',
  'align',
  'type',
  'checked',
  'disabled',
  'start',
  'src',
  'alt',
  'loading',
  'class',
  'width',
  'height',
];

const SAFE_HREF = /^(?:https?:\/\/|mailto:)/i;
/** Our own MR drawer path: opened in place (see `components/Markdown.tsx`), not in a new tab. */
const MR_HREF = /^\/mrs\/[a-z0-9-]+\/\d{1,7}$/;
/** Only our proxy paths may be an image source. */
const SAFE_SRC =
  /^\/api\/mrs\/(?:[a-z0-9-]+|~[1-9][0-9]{0,11})\/uploads\/[0-9a-f]{32}\/[\w.()%-]+$/;
const CLASSES = new Set(['mr-ref', 'mention', 'mention-me', 'md-img']);
const FENCE_LANG = /^language-[a-z0-9+#.-]{1,24}$/i;

let hooked = false;
function installHooks(): void {
  if (hooked) return;
  hooked = true;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    // A size only on images, and only a plain number or percentage.
    for (const a of ['width', 'height']) {
      const v = node.getAttribute(a);
      if (v !== null && (node.tagName !== 'IMG' || !SIZE_VALUE_RE.test(v))) node.removeAttribute(a);
    }
    const cls = node.getAttribute('class');
    if (cls !== null) {
      // `language-x` on fenced code survives so the Reader can highlight it; it carries no behavior.
      const kept = cls.split(/\s+/).filter((c) => CLASSES.has(c) || FENCE_LANG.test(c));
      if (kept.length) node.setAttribute('class', kept.join(' '));
      else node.removeAttribute('class');
    }
    if (node.tagName === 'A') {
      const href = node.getAttribute('href')?.trim() ?? null;
      if (href !== null && MR_HREF.test(href)) return;
      if (href !== null && !SAFE_HREF.test(href)) node.removeAttribute('href');
      if (node.hasAttribute('href')) {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer nofollow');
      }
    }
    if (node.tagName === 'IMG') {
      const src = node.getAttribute('src');
      if (src === null || !SAFE_SRC.test(src)) {
        // Raw HTML `<img>` pointing anywhere else: keep its alt text only.
        node.replaceWith(node.ownerDocument.createTextNode(node.getAttribute('alt') ?? ''));
        return;
      }
      node.setAttribute('loading', 'lazy');
      node.setAttribute('class', 'md-img');
    }
    if (node.tagName === 'INPUT') {
      // Task-list checkbox only, always inert.
      if (node.getAttribute('type') !== 'checkbox') node.remove();
      else node.setAttribute('disabled', '');
    }
  });
}

/** Sanitized HTML for already-rendered markup. Exposed separately so it can be reasoned about on its own. */
export function sanitizeHtml(html: string): string {
  installHooks();
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    ALLOW_UNKNOWN_PROTOCOLS: false,
    KEEP_CONTENT: true,
  });
}

/** Markdown -> sanitized HTML, safe for `dangerouslySetInnerHTML`. */
export function renderMarkdown(source: string, context: MarkdownContext = {}): string {
  ctx = context;
  try {
    return sanitizeHtml(marked.parse(source) as string);
  } finally {
    ctx = {};
  }
}

/**
 * The Reader's Markdown: plain CommonMark + GFM (a single newline is not a line break, unlike GitLab comments), no
 * `!123` / `@user` extensions. Same sanitizer. Images other than our upload proxy become their alt text, as above.
 */
const readerMarked = new Marked({
  gfm: true,
  breaks: false,
  async: false,
  renderer: {
    image({ href, text }) {
      const label = escapeHtml(text || 'image');
      return `<a href="${escapeHtml(href)}">Image: ${label}</a>`;
    },
  },
});

export function renderReaderMarkdown(source: string): string {
  return sanitizeHtml(readerMarked.parse(source) as string);
}
