# Relay guide

How to install Relay, set it up, and use each part of it. [REFERENCE.md](REFERENCE.md) covers the details of tokens, ngrok and backups; this guide is the walk-through.

The dashboard runs on your own machine. There are no accounts and nothing is hosted: it listens on `127.0.0.1` only, and your tokens are encrypted on your disk.

## 1. What you need

| Needed for      | Install                                                                           |
| --------------- | --------------------------------------------------------------------------------- |
| Everything      | Node 22+, pnpm 12 (`corepack enable`), git                                        |
| Release scripts | `glab` (GitLab CLI, logged in), `jq`. Flutter apps: `flutter` or `fvm`            |
| Builds          | Flutter (or fvm) and the Android SDK                                              |
| Test Bench      | The Figma desktop app (see section 7), an Android phone with USB debugging, `adb` |
| Cockpit         | The Claude CLI (`claude`, your own subscription) or Cursor's CLI                  |

Only the first row is required. Everything else is detected: a missing tool turns its feature into a plain "not installed" note, never a crash.

## 2. First start

```bash
pnpm install
cp .env.example .env && chmod 600 .env
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"   # paste as MASTER_KEY in .env
pnpm build && pnpm start
```

Open `http://127.0.0.1:3000` (use `127.0.0.1`, not `localhost`).

1. **Do you release and build a mobile app?** The first screen asks once, and shows the flow it means: bump the version, open and merge the version MR, tag, build, upload for QA. **Yes** switches Release and Builds on; **No** switches them off, since web and backend teams usually ship through CI/CD. Change it any time in Settings > General > Features.
2. **Dry-run is on** at first start (Settings > General > Safety & engine). Writes to GitLab, Notion and Drive are only recorded in Audit until you switch it off.
3. **Connect GitLab** (Settings > Connections): the host and your username. Then add your repos under Settings > Repos, each with a project access token.
4. **Notion is optional.** Without it the Board, Sync Health, KPI and Sprints say that they need Notion; the merge request features work without it.

Keep `MASTER_KEY` somewhere safe. Without it the saved tokens cannot be read.

## 3. Switch off what you do not use

Settings > General > Features has one switch per feature. A switched-off feature leaves the sidebar, the command palette (`Cmd/Ctrl K`), the `g` shortcuts and the workspace menu. Its data stays, so switching it back on loses nothing.

A freelancer without KPIs might switch off KPI and Sprints. KPI presets (points as hours, research quota, bug ratio) have their own switches in Settings > Planning. A reviewer who never releases might switch off Release and Builds.

## 4. The features

| Feature              | Where                | What it is for                                                                                    |
| -------------------- | -------------------- | ------------------------------------------------------------------------------------------------- |
| Workspace / Overview | `/`, `/overview`     | What needs you today, at a glance                                                                 |
| Board                | `/board`             | Your Notion cards by status, with their merge requests                                            |
| MR Inbox             | `/mrs`               | Merge requests of your repos, sorted by what needs you; open one for threads, approvals and merge |
| Code Review          | `/review`            | Read the diff of an MR or two branches; comment on lines, approve                                 |
| Reviews              | `/reviews`           | MRs in any project where you are a reviewer or were mentioned (section 5)                         |
| Cockpit              | `/cockpit`           | Coding-agent sessions on your cards, each in its own git worktree                                 |
| Test Bench           | `/test-bench/<repo>` | Your app on a phone next to its Figma frames (section 7)                                          |
| Release              | `/release`           | Version MR, merge, tag, build: the native engine, or the release scripts (section 6)              |
| Builds               | `/builds`            | Flutter builds and uploads                                                                        |
| Sync Health          | `/sync`              | Cards and MRs that disagree, with fixes                                                           |
| KPI, Sprints         | `/kpi`, `/sprints`   | Points, effort and capacity, for teams that track them                                            |
| Notifications        | `/notifications`     | Everything the dashboard told you; Web Push and ntfy channels                                     |
| Audit                | `/audit`             | Every write, real or dry-run; undo where possible                                                 |

Press `?` anywhere for the keyboard shortcuts.

## 5. Reviews

For anyone who reviews other people's merge requests, in projects you have not added as repos.

1. Create a personal access token in GitLab (Preferences > Access tokens). Scope `read_api` to read, or `api` to also comment, reply and approve from the dashboard.
2. Paste it in Settings > Connections > Reviewer access. It is checked with GitLab before it is saved.
3. Switch Reviews on in Settings > General > Features.

The desk sorts MRs into lanes: **Needs you**, **Changed since you looked**, **Mentioned**, **Waiting on the author**, **Approved** and **Snoozed**.

- **Mark reviewed** remembers the commit you read. When new commits arrive, the MR moves to "Changed since you looked", and **What changed** shows only the diff since that commit.
- **Snooze** hides an MR until later. It is local: GitLab is not told.
- **To-do done** marks the MR's GitLab to-dos as done. This one is a GitLab write, so dry-run applies.
- Open any MR to review it in the full diff view, with comments and approval, even for projects that are not your repos.

### Live or polled

Every row says how it reaches you:

- **Live**: its project sent a webhook recently, so changes show up within seconds. Your configured repos are live once their webhook works (Settings > Repos > Webhook health).
- **Polled**: no webhook reaches its project, so the dashboard checks your GitLab to-dos once a minute. The row says why and links to the fix. Projects with a working webhook are never polled.

To make other projects live, add the **Reviews webhook** to their group (needs Owner) or project (needs Maintainer). The URL and secret are in Settings > Connections > Reviewer access. Tick _Comments_ and _Merge request events_. This needs a public URL (ngrok, see [REFERENCE.md](REFERENCE.md#ngrok)).

You can switch polling off in the same card. Polled projects then update only when you press Refresh.

## 6. Release scripts

The Release page has two engines (Settings > General > Safety & engine):

- **Built in** (default): the dashboard does the release itself through the GitLab API.
- **Custom release command**: the dashboard runs `vu` from `tools/bin` (or any executable with the same arguments, named by `RELEASE_COMMAND` in `.env`) in a terminal you can watch.

| Script             | Does                                                                  |
| ------------------ | --------------------------------------------------------------------- |
| `vu`               | Bumps the Flutter version, opens the version MR, merges, tags, builds |
| `mrc`              | Opens a merge request with `glab`                                     |
| `vcheck`           | Checks the Notion cards of the MRs in a release                       |
| `nts`              | Moves a Notion card to a status                                       |
| `reauthor`         | Rewrites commit authors to the right identity                         |
| `flutter-run-menu` | Builds or runs a Flutter flavor                                       |

### Their settings live in the dashboard

You do not edit the scripts. Most values come from what Settings already knows: the GitLab host and your username, each repo's token, version branch prefix, first reviewer and commit identity, and the Notion token and data source.

If a release still lacks something (usually the commit author name and email), the dashboard asks for it in a short form, saves it, and starts the release again. Without this, `vu` would stop and wait for an answer in a terminal nobody is watching.

To see or change everything at once, use Settings > Repos > Release scripts. A typed value overrides Settings; "Use Settings for all" forgets what you typed.

### Running them from a terminal

The dashboard writes the same values to `~/.config/relay/scripts.env` and the scripts read that file, so a terminal run behaves like a dashboard run. The file holds tokens in plain text, readable by your user only (mode 600), the same way `glab` keeps its own config.

```bash
export PATH="$PWD/tools/bin:$PATH"   # from the dashboard folder; add it to ~/.zshrc to keep it
vu staging                            # in your Flutter app's folder
```

A variable you set yourself always wins over the file: `VU_BRANCH_PREFIX=hotfix/v vu staging`.

If you already have your own `vu` in `~/bin`, the dashboard uses that one. To choose a folder explicitly, set `VU_BIN_DIR` in `.env`.

## 7. Test Bench and the Figma bridge

The Test Bench reads Figma frames through the open source [Figma MCP bridge](https://github.com/gethopp/figma-mcp-bridge) (MIT). The dashboard starts the bridge itself (`npx -y @gethopp/figma-mcp-bridge`). You only install its plugin in Figma, once:

1. Install the **Figma desktop app**. The browser version cannot import development plugins.
2. Download the plugin from the bridge's [latest release](https://github.com/gethopp/figma-mcp-bridge/releases).
3. In Figma: **Plugins > Development > Import plugin from manifest**, and choose the `manifest.json` from its `plugin/` folder.
4. Open the design file you test against and run the plugin. It connects to the bridge on `127.0.0.1:1994`.

To use another command for the bridge, set `FIGMA_BRIDGE_CMD` in `.env`.

For the phone mirror, run once: `pnpm --filter @relay/server device:setup` (it fetches the pinned scrcpy server), then plug in an Android phone with USB debugging on.

## 8. Docker and the host agent

You do not need Docker: `pnpm start` is the simplest way to run it. If you run the dashboard in Docker, the container cannot use your Mac's tools, so a small **host agent** does that work on the Mac:

```bash
pnpm agent    # on the Mac, next to the container; needs HOST_AGENT_TOKEN in .env (openssl rand -hex 32)
```

The agent runs, on the Mac:

- git and Flutter builds in the bot clones (`~/.relay/clones`)
- the release scripts in a terminal (custom release command), and writes their `scripts.env`
- the Figma bridge, so the Figma desktop plugin can reach it
- the phone mirror (scrcpy) and the Cockpit's agent sessions in your workspaces

It listens on `127.0.0.1:3002` only and refuses any request without the token. See [REFERENCE.md](REFERENCE.md#docker) for ngrok and Tailscale.

## 9. Windows

Relay runs on macOS, Linux and Windows. On Windows there are two ways:

|                                                                                        | Native Windows                                              | WSL (Linux inside Windows) |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------- | -------------------------- |
| MR Inbox, Code Review, Reviews, Board, Sync Health, KPI, Sprints, Notifications, Audit | Yes                                                         | Yes                        |
| Release, native engine                                                                 | Yes                                                         | Yes                        |
| Release scripts (custom release command), Builds, Cockpit, Test Bench                  | No: they run shell scripts and Flutter and Claude launchers | Yes                        |

On first start, Windows asks which you want. **Continue on Windows** switches the WSL-only features off; each one says why on its page and in Settings.

To use WSL:

1. In PowerShell as administrator, run `wsl --install`, then restart.
2. Open Ubuntu. Install Node 22, then `corepack enable` for pnpm.
3. Clone Relay inside your Linux home (for example `~/relay`), **not** under `/mnt/c`: file access across the boundary is slow and file permissions break.
4. `pnpm install`, `pnpm build && pnpm start`.
5. Open `http://127.0.0.1:3000` in your Windows browser. WSL forwards localhost to Windows.

Install the WSL-side tools there too: git, `glab`, `jq` and Flutter for releases and builds, and the Claude CLI for the Cockpit. The Figma desktop app stays on Windows; the bridge reaches it on `127.0.0.1:1994`.

Workspace and clone folders accept `~/…` on every system, and full paths such as `C:\Users\you\Work\app` on native Windows.

## 10. When something goes wrong

- **A feature is missing from the menu.** It is switched off: Settings > General > Features.
- **A Reviews row says Polled.** Read its "Why?". It links to the webhook that would make it live.
- **A release asks for values.** Fill them in once; they are kept in Settings > Repos > Release scripts.
- **Settings > Release scripts lists tools as "Not installed".** Install them (section 1) and reload.
- **A page says it cannot run here.** You are on Windows without WSL: see section 9.
- **Anything else.** The Troubleshooting section of [REFERENCE.md](REFERENCE.md#troubleshooting), and the Audit page for what was really sent.
