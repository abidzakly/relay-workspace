# Relay

Relay is a workspace for developers who live in GitLab. It gathers your merge requests, the reviews people are waiting on, your release flow and (if you use Notion) your task cards into one calm page that runs on your own machine.

- **Merge requests and reviews**: an inbox sorted by what needs you, a diff reader with comments and approval, and a reviewer's desk across any GitLab project, live through webhooks where they exist.
- **Releases**: version merge request, merge, tag, build and hand-off to QA, with the built-in engine or your own release script.
- **Notion, if you want it**: a board of your cards next to their merge requests, a check for cards and MRs that disagree, KPI and sprint views.
- **Agents and devices**: coding-agent sessions on your cards in their own worktrees, that can read the real API endpoints from Postrack, and a test bench that puts your app on a phone next to its Figma frames.

Everything you do not use can be switched off. Nothing is hosted: there are no accounts, and your tokens never leave your machine except to talk to the services you connected.

## Five-minute setup

You need Node 22 or newer and git.

```bash
git clone https://github.com/abidzakly/relay-workspace.git relay
cd relay
corepack enable
pnpm install

cp .env.example .env && chmod 600 .env
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"   # paste it as MASTER_KEY in .env

pnpm build && pnpm start
```

Open http://127.0.0.1:3000 (use `127.0.0.1`, not `localhost`). Then:

1. Answer the first-start question: do you release and build a mobile app? It switches the release pages on or off.
2. In **Settings > Connections**, enter your GitLab host and username. In **Settings > Repos**, add a repo with a project access token (scope `api`).
3. Look around with dry-run on (it is on at first start): every write is only recorded in **Audit**. Switch it off in **Settings > General > Safety & engine** when you are ready.

Keep `MASTER_KEY` safe: without it, saved tokens cannot be read. On Windows, see [the guide](docs/GUIDE.md#10-windows) (WSL is recommended). Docker is optional: see [Reference > Docker](docs/REFERENCE.md#docker).

## How it stays safe

Relay is a local app for one person. The dashboard listens on `127.0.0.1` only, refuses other hosts and origins, and needs a CSRF header on every write. If you want GitLab webhooks, you give GitLab a public URL through a tunnel such as ngrok, and that URL reaches only `POST /webhook/<repo-id>`, checked against each repo's secret. Tokens are encrypted at rest with your `MASTER_KEY`. Every write to GitLab, Notion or Drive needs your confirmation and lands in the audit log, with undo where GitLab or Notion allows it.

Report security problems privately, as described in [SECURITY.md](SECURITY.md). The full checklist and the accepted risks are in [docs/SECURITY.md](docs/SECURITY.md).

## Documentation

- [Guide](docs/GUIDE.md): first start, every feature, Reviews, the release scripts, the Figma bridge, Postrack, Docker, Windows.
- [Reference](docs/REFERENCE.md): tokens, webhooks, Google Drive, Web Push, environment variables, backups, troubleshooting.
- [Editions](editions/README.md): presets that set a team's defaults.
- [Contributing](CONTRIBUTING.md).

## Credits

Created by Amru Abid Zakly. Released under the [MIT license](LICENSE).

Relay uses, among others, Fastify, React, three.js, Drizzle and the [Figma MCP bridge](https://github.com/gethopp/figma-mcp-bridge). The name has nothing to do with Meta's GraphQL client of the same name.
