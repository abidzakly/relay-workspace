import { useEffect, useState } from 'react';
import type { HighlighterCore } from 'shiki/core';
import type { Token } from './intraline';
import { languageFor, type Lang } from './languageFor';

/**
 * Syntax highlighting for the Code Reviewer: one lazy shiki highlighter (JavaScript regex engine: the CSP has no
 * `wasm-unsafe-eval`), grammars loaded on first use. Light + dark colors come in one pass (`--shiki-dark`), so a
 * theme switch needs no re-highlight. Large inputs stay plain text: highlighting must never freeze a review.
 */

const LOADERS: Record<Lang, () => Promise<unknown>> = {
  typescript: () => import('shiki/langs/typescript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  dart: () => import('shiki/langs/dart.mjs'),
  kotlin: () => import('shiki/langs/kotlin.mjs'),
  swift: () => import('shiki/langs/swift.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  groovy: () => import('shiki/langs/groovy.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  ruby: () => import('shiki/langs/ruby.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  php: () => import('shiki/langs/php.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'),
  csharp: () => import('shiki/langs/csharp.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  scss: () => import('shiki/langs/scss.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  vue: () => import('shiki/langs/vue.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  shellscript: () => import('shiki/langs/shellscript.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  dockerfile: () => import('shiki/langs/dockerfile.mjs'),
};

const THEMES = { light: 'vitesse-light', dark: 'vitesse-dark' } as const;
/** Characters per side; past this the file is shown as plain text. */
const MAX_CHARS = 250_000;

let core: Promise<HighlighterCore> | null = null;
const loaded = new Map<Lang, Promise<void>>();

function highlighter(): Promise<HighlighterCore> {
  core ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
      import('shiki/core'),
      import('shiki/engine/javascript'),
    ]);
    return createHighlighterCore({
      themes: [import('shiki/themes/vitesse-light.mjs'), import('shiki/themes/vitesse-dark.mjs')],
      langs: [],
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    });
  })();
  return core;
}

async function ensureLang(h: HighlighterCore, lang: Lang): Promise<void> {
  let p = loaded.get(lang);
  if (!p) {
    p = LOADERS[lang]().then((m) =>
      h.loadLanguage((m as { default: Parameters<HighlighterCore['loadLanguage']>[0] }).default),
    );
    loaded.set(lang, p);
  }
  return p;
}

async function tokenize(text: string, lang: Lang): Promise<Token[][]> {
  const h = await highlighter();
  await ensureLang(h, lang);
  const r = h.codeToTokens(text, { lang, themes: THEMES });
  return r.tokens.map((line) =>
    line.map((t) => ({ content: t.content, ...(t.htmlStyle ? { style: t.htmlStyle } : {}) })),
  );
}

export interface SideTokens {
  old: Token[][] | null;
  new: Token[][] | null;
}

/** Tokens for the two sides of one file (indexes match `sides()`); null until ready or when plain text. */
export function useHighlight(
  path: string,
  oldText: string,
  newText: string,
  enabled: boolean,
): SideTokens {
  const [out, setOut] = useState<SideTokens>({ old: null, new: null });
  useEffect(() => {
    const lang = languageFor(path);
    if (!enabled || !lang || oldText.length > MAX_CHARS || newText.length > MAX_CHARS) {
      setOut({ old: null, new: null });
      return;
    }
    let alive = true;
    Promise.all([tokenize(oldText, lang), tokenize(newText, lang)])
      .then(([o, n]) => {
        if (alive) setOut({ old: o, new: n });
      })
      .catch(() => {
        // A grammar that fails to load or a pathological input: plain text is a fine fallback.
        if (alive) setOut({ old: null, new: null });
      });
    return () => {
      alive = false;
    };
  }, [path, oldText, newText, enabled]);
  return out;
}
