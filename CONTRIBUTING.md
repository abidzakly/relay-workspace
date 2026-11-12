# Contributing to Relay

Thank you for helping. Bug reports, fixes and new ideas are all welcome.

## Local setup

You need Node 22 or newer and pnpm (the version pinned in `package.json`).

```bash
corepack enable
pnpm install
cp .env.example .env && chmod 600 .env   # then set MASTER_KEY, see docs/GUIDE.md
pnpm dev                                  # server and web app with reload
```

Open http://127.0.0.1:5173. Data lives in `data/` (git-ignored), so you can delete it to start over.

Before you open a pull request, run:

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
```

## Pull requests

- Keep one change per pull request, and say what it changes for the person using Relay.
- Never commit real data: no tokens, `.env`, `data/`, company hosts, real people's names or screenshots of real work. Use `gitlab.example.com` and names such as `jane.doe` in tests and docs.
- UI text is short and plain: say what happened and what to do next.

## Sign your commits (DCO)

Every commit must carry a `Signed-off-by` line. It certifies that you wrote the change, or have the right to submit it under the project's MIT license, as described in the [Developer Certificate of Origin](https://developercertificate.org/).

```bash
git commit -s -m "fix: describe the change"
```

## Code of conduct

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md).
