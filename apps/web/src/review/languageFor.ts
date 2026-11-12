/** File path → shiki language id (only the grammars `highlight.ts` can load). null = plain text. */

export const LANGS = [
  'typescript',
  'tsx',
  'javascript',
  'jsx',
  'json',
  'dart',
  'kotlin',
  'swift',
  'java',
  'groovy',
  'go',
  'python',
  'ruby',
  'rust',
  'php',
  'c',
  'cpp',
  'csharp',
  'css',
  'scss',
  'html',
  'vue',
  'xml',
  'markdown',
  'yaml',
  'toml',
  'shellscript',
  'sql',
  'dockerfile',
] as const;
export type Lang = (typeof LANGS)[number];

const BY_EXT: Record<string, Lang> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  json: 'json',
  jsonc: 'json',
  arb: 'json',
  dart: 'dart',
  kt: 'kotlin',
  kts: 'kotlin',
  swift: 'swift',
  java: 'java',
  gradle: 'groovy',
  groovy: 'groovy',
  go: 'go',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  php: 'php',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  hpp: 'cpp',
  m: 'c',
  mm: 'cpp',
  cs: 'csharp',
  css: 'css',
  scss: 'scss',
  html: 'html',
  htm: 'html',
  vue: 'vue',
  xml: 'xml',
  plist: 'xml',
  svg: 'xml',
  md: 'markdown',
  markdown: 'markdown',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  sql: 'sql',
};

const BY_NAME: Record<string, Lang> = {
  dockerfile: 'dockerfile',
  podfile: 'ruby',
  gemfile: 'ruby',
  fastfile: 'ruby',
  makefile: 'shellscript',
};

export function languageFor(path: string): Lang | null {
  const name = (path.split('/').pop() ?? '').toLowerCase();
  if (BY_NAME[name]) return BY_NAME[name];
  if (name.startsWith('dockerfile')) return 'dockerfile';
  const dot = name.lastIndexOf('.');
  if (dot < 0) return null;
  return BY_EXT[name.slice(dot + 1)] ?? null;
}
