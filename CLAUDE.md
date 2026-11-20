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
