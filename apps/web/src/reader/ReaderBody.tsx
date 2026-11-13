import { useEffect, useMemo, useRef } from 'react';
import { LANGS, languageFor, type Lang } from '@/review/languageFor';
import { codeBlockHtml } from '@/review/highlight';
import { renderReaderMarkdown } from '@/lib/markdown';
import { cn } from '@/lib/utils';

export interface Heading {
  id: string;
  text: string;
  level: number;
}

const ALIASES: Record<string, Lang> = {
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  shell: 'shellscript',
  console: 'shellscript',
  ts: 'typescript',
  js: 'javascript',
  yml: 'yaml',
  md: 'markdown',
  kt: 'kotlin',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  'c++': 'cpp',
  cs: 'csharp',
  docker: 'dockerfile',
};

/** A fence's language tag as a grammar `highlight.ts` can load, or null for plain text. */
function fenceLang(tag: string): Lang | null {
  const t = tag.toLowerCase();
  if ((LANGS as readonly string[]).includes(t)) return t as Lang;
  return ALIASES[t] ?? languageFor(`x.${t}`);
}

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'section';

/**
 * A document's body: sanitized Markdown (or plain text), then two passes on the inserted DOM: heading ids for the
 * table of contents (set here, never taken from the document), and shiki for fenced code.
 */
export function ReaderBody({
  body,
  format,
  onHeadings,
  className,
}: {
  body: string;
  format: 'md' | 'txt';
  onHeadings: (h: Heading[]) => void;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const html = useMemo(() => (format === 'md' ? renderReaderMarkdown(body) : null), [body, format]);

  useEffect(() => {
    const root = ref.current;
    if (!root || html === null) {
      onHeadings([]);
      return;
    }
    const used = new Map<string, number>();
    const heads: Heading[] = [];
    for (const h of root.querySelectorAll<HTMLHeadingElement>('h1, h2, h3')) {
      const text = h.textContent?.trim() ?? '';
      const base = slug(text);
      const n = used.get(base) ?? 0;
      used.set(base, n + 1);
      h.id = n ? `${base}-${n}` : base;
      heads.push({ id: h.id, text, level: Number(h.tagName[1]) });
    }
    onHeadings(heads);

    let alive = true;
    for (const code of root.querySelectorAll<HTMLElement>('pre > code')) {
      const tag = [...code.classList].find((c) => c.startsWith('language-'))?.slice(9);
      const lang = tag ? fenceLang(tag) : null;
      const pre = code.parentElement;
      if (!lang || !pre) continue;
      void codeBlockHtml(code.textContent ?? '', lang)
        .then((out) => {
          if (!alive || !out || !pre.isConnected) return;
          const tpl = document.createElement('template');
          tpl.innerHTML = out;
          const next = tpl.content.firstElementChild;
          if (next) pre.replaceWith(next);
        })
        .catch(() => undefined);
    }
    return () => {
      alive = false;
    };
  }, [html, onHeadings]);

  if (html === null) {
    return (
      <div ref={ref} className={cn('md md-reader whitespace-pre-wrap', className)}>
        {body}
      </div>
    );
  }
  return (
    <div
      ref={ref}
      className={cn('md md-reader', className)}
      // Sanitized by `renderReaderMarkdown` (lib/markdown.ts).
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
