/**
 * Values the repo wizard works out so nobody types them: the repo id, a Drive folder id from a pasted link, a clean
 * WhatsApp number, and previews of the release names and the QA message.
 */

/** Same rule as the server's `REPO_ID_RE`: a-z, 0-9 and "-", starting with a letter or digit, at most 63. */
const REPO_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export const isRepoId = (s: string) => REPO_ID_RE.test(s);

/** `Team/My_App.Mobile` -> `my-app-mobile`; never empty. */
export function slugRepoId(source: string): string {
  const slug = source
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/, '');
  return slug || 'repo';
}

/** The slug, with `-2`, `-3`… when another repo already has it. */
export function uniqueRepoId(source: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = slugRepoId(source);
  if (!used.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const suffix = `-${n}`;
    const id = `${base.slice(0, 63 - suffix.length).replace(/-+$/, '')}${suffix}`;
    if (!used.has(id)) return id;
  }
  return `${base.slice(0, 50)}-${Date.now().toString(36)}`;
}

/** Drive's folder ids, as the server checks them. */
const FOLDER_ID_RE = /^[A-Za-z0-9_-]{5,100}$/;

/**
 * A folder id from what was pasted: the folder's link (`…/folders/<id>`, `…?id=<id>`, with `/u/0/` or a
 * `resourcekey`) or the bare id. Null when it is neither.
 */
export function parseDriveFolder(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  if (FOLDER_ID_RE.test(s)) return s;
  try {
    const u = new URL(s);
    if (!/(^|\.)google\.com$/.test(u.hostname)) return null;
    const m = /\/folders\/([A-Za-z0-9_-]{5,100})/.exec(u.pathname);
    const id = m?.[1] ?? u.searchParams.get('id') ?? '';
    return FOLDER_ID_RE.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** `+62 812-3456 7890` -> `6281234567890`; a leading local `0` is left for the person to fix. */
export const cleanWhatsapp = (s: string) => s.replace(/\D+/g, '');

/** What Relay sends QA, with sample values in the placeholders. */
export function previewQaMessage(template: string, repo: string, qa: string): string {
  const sample: Record<string, string> = {
    qa: qa || 'QA',
    repo: repo || 'app',
    version: '1.4.0',
    drive: 'https://drive.google.com/…',
    changes: '- Fix the login crash\n- New checkout screen',
  };
  return template.replace(
    /\{(qa|repo|version|drive|changes)\}/g,
    (_, k: string) => sample[k] ?? '',
  );
}

export const QA_PLACEHOLDERS = ['qa', 'repo', 'version', 'drive', 'changes'] as const;

/** Release names from the prefix and tag format, for the preview. */
export function previewRelease(prefix: string, tagFormat: string) {
  return {
    branch: `${prefix}1.4.0`,
    tag: tagFormat.replaceAll('{commitVersion}', '1.4.0'),
  };
}

/** `git@host:group/app.git`, `https://…`, `ssh://…`, `file://…` or an absolute path, like the server allows. */
export const isCloneUrl = (s: string) =>
  /^(?:https?:\/\/|ssh:\/\/|file:\/\/|git@[A-Za-z0-9.-]+:|\/)[^\s]+$/.test(s.trim());
