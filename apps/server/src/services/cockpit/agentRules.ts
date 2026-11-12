import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { git, guardFile } from './workspaceFs';

/**
 * The user's standing rules for agents, carried into every workspace: `CLAUDE.local.md` for Claude Code and a Cursor
 * rule for cursor-agent. Both are listed in `.git/info/exclude`, so they are never committed and `.gitignore` stays
 * untouched. Safe to repeat: nothing is written when a file is already up to date.
 */

const RULES = `# Tests: skip for now
Until the user says otherwise:
- Do not create, update, or run tests.
- Do not check whether a failure already exists on HEAD or the base branch. Skip worktree, stash, or checkout comparisons for this purpose.
- Do not re-check files or results already established in the session unless they have changed.
- Typecheck, lint, and running the app are still allowed when the task needs them.
- In reports and PR descriptions, say plainly that tests were not run. Never imply they passed.
`;

const CLAUDE_FILE = 'CLAUDE.local.md';
// The marker names keep the name from before the rename to Relay, so blocks already written into workspaces are found.
const CURSOR_FILE = '.cursor/rules/core-dashboard-no-tests.mdc';
const BEGIN = '<!-- core-dashboard:agent-rules -->';
const END = '<!-- /core-dashboard:agent-rules -->';
const CURSOR_RULE = `---
description: Standing rules from Relay
alwaysApply: true
---

${RULES}`;

/** `existing` with the rules block added or refreshed; everything else in the file is kept. Pure. */
export function withRulesBlock(existing: string | null): string {
  const block = `${BEGIN}\n${RULES}${END}\n`;
  if (!existing) return block;
  const start = existing.indexOf(BEGIN);
  const end = existing.indexOf(END, start);
  if (start !== -1 && end !== -1) {
    return `${existing.slice(0, start)}${block}${existing.slice(end + END.length).replace(/^\n/, '')}`;
  }
  return `${existing.replace(/\n*$/, '\n\n')}${block}`;
}

/** `content` plus any of `patterns` it lacks as a whole line. Pure. */
export function withExcludes(content: string, patterns: readonly string[]): string {
  const lines = new Set(content.split('\n').map((l) => l.trim()));
  const missing = patterns.filter((p) => !lines.has(p));
  if (missing.length === 0) return content;
  const base = content && !content.endsWith('\n') ? `${content}\n` : content;
  return `${base}${missing.join('\n')}\n`;
}

async function writeIfChanged(abs: string, content: string): Promise<void> {
  const current = await readFile(abs, 'utf8').catch(() => null);
  if (current === content) return;
  const tmp = `${abs}.cockpit-${process.pid}-${Date.now()}`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, abs);
}

/** Puts the rules into the workspace. A file the repository already tracks is left alone: editing it could be committed. */
export async function ensureAgentRules(cwd: string): Promise<void> {
  // Excluded first, so the files never show up as untracked in a checkpoint or `git status`.
  const excludePath = resolve(
    cwd,
    (await git(cwd, ['rev-parse', '--git-path', 'info/exclude'])).trim(),
  );
  await mkdir(dirname(excludePath), { recursive: true });
  const exclude = await readFile(excludePath, 'utf8').catch(() => '');
  await writeIfChanged(excludePath, withExcludes(exclude, [`/${CLAUDE_FILE}`, `/${CURSOR_FILE}`]));

  const tracked = (rel: string) =>
    git(cwd, ['ls-files', '--', rel]).then((out) => out.trim().length > 0);

  if (!(await tracked(CLAUDE_FILE))) {
    const abs = await guardFile(cwd, CLAUDE_FILE, false);
    await writeIfChanged(abs, withRulesBlock(await readFile(abs, 'utf8').catch(() => null)));
  }
  if (!(await tracked(CURSOR_FILE))) {
    await mkdir(resolve(cwd, dirname(CURSOR_FILE)), { recursive: true });
    await writeIfChanged(await guardFile(cwd, CURSOR_FILE, false), CURSOR_RULE);
  }
}
