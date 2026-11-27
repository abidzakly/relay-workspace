# CLAUDE.md

Project rules for Claude Code in this repository. See also [CONTRIBUTING.md](CONTRIBUTING.md).

## Git workflow: every new piece of work ships through a PR

Never commit straight to `main`. For each new piece of work (feature, fix, docs, chore):

1. Start from an up-to-date `main`: `git checkout main && git pull --ff-only`.
2. Create a branch named for the change: `feat/<topic>`, `fix/<topic>`, `docs/<topic>`, `chore/<topic>`.
3. Commit with a sign-off (DCO, required by CONTRIBUTING.md): `git commit -s`. Use Conventional Commits
   (`feat(scope): summary`). One topic per commit and per PR; split unrelated changes into separate branches.
4. Push: `git push -u origin <branch>`.
5. Open a PR against `main`: `gh pr create --base main`. Say what changes for the person using Relay, and state
   plainly whether tests were run.
6. Merge it with a merge commit and delete the branch: `gh pr merge --merge --delete-branch`.
7. Return to `main` and pull before starting the next piece of work.

`main` is protected by a ruleset (pull requests only): no direct pushes and no force-pushes.

## UI text: English and Indonesian

The web app ships in English and Bahasa Indonesia (`react-i18next`, set in Settings → This browser → Appearance).
Every new or changed user-facing string in `apps/web` goes through it, never as a literal in a component:

1. Add the key to the right area file in `apps/web/src/i18n/locales/en/` (`nav`, `shell`, `palette`, `settings`,
   `overview`, …). For a new area, add a file in both `en/` and `id/` and register it in both `index.ts` files.
2. Add the Indonesian text under the same key in `apps/web/src/i18n/locales/id/`. Each `id` file is typed against its
   `en` twin, so `pnpm typecheck` fails when a key is missing or extra.
3. Use it with `const { t } = useTranslation()` and `t('area.key', { name })`. Use `<Trans>` when the text wraps
   markup. Use `_one` / `_other` keys with `count` for plurals. Indonesian gives both keys the same text.
4. Visible text, `aria-label`, `title` and `placeholder` all count.

Not translated: user content, AI output, and data from GitLab or Notion (card titles, statuses, repo names).
When you touch a page that still has English literals, move the strings you change into the locale files.
