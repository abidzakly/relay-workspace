# Reference

The details behind [the README](../README.md) and [the guide](GUIDE.md): tokens, webhooks, Drive, push, environment variables, Docker, backups and troubleshooting.

## Setup details

- `pnpm-workspace.yaml` already allows the two packages with build scripts: `esbuild`, and `node-pty` for the custom release command. `node-pty` is optional: without it, the rest works and the custom release command shows as unavailable.
- `MASTER_KEY` encrypts your tokens at rest, and the server will not start without a valid one. **Do not lose it, and do not change it casually.** Stored tokens cannot be decrypted without it, so you would have to enter them all again. Keep a copy somewhere other than your database backups.
- `pnpm build && pnpm start` (port 3000) is for daily use: only this mode serves pages with the Content Security Policy. `pnpm dev` (port 5173) is for developing Relay; if you change `DASHBOARD_PORT`, its proxy stops working, as it expects port 3000.
- Use `127.0.0.1` rather than `localhost`, because `localhost` can resolve to the IPv6 address, which the server does not listen on.
- Dry-run is on at first start: writes to GitLab, Notion and Drive are recorded in the Audit view but not sent. Press the connection tests in Settings, try a merge, a card status change and a release, read what the Audit view says each would do, then switch dry-run off and do your first real write on a test project. The custom release command runs a real script, which cannot simulate, so it refuses to start during dry-run.
- The bot clones in `~/.relay/clones` use your own git login, so the clone URL needs SSH keys or a credential helper to work. The dashboard refuses a clone URL with a username and token inside it.

## Tokens

**Rotate first.** Any token you have pasted in a chat, a ticket or a screenshot is compromised. Replace it before first use.

**Rotate regularly too.** Set a reminder, and a GitLab expiry date, for every 90 days or so. To rotate, create the new token, paste it in Settings, press the connection test, then revoke the old one.

Give each token only what it needs:

| Service | Scope                                                            |
| ------- | ---------------------------------------------------------------- |
| GitLab  | `api`. Comments, merges, webhooks and branches all need it.      |
| Notion  | An internal integration, shared with the one database only.      |
| Drive   | A service account that is a member of the one Shared Drive only. |

Tokens are never shown again after you save them.

## ngrok

GitLab reaches the dashboard through a public URL that has to stay the same, so use a static domain. With Docker, the `ngrok` service does steps 1–2 for you (see [Docker](#docker)).

1. Create a free static domain in the ngrok dashboard, and run `ngrok config add-authtoken <token>`.
2. Forward it to the **webhook port only**:

   ```bash
   ngrok http 3001 --url https://your-domain.ngrok-free.app
   ```

3. In **Settings > GitLab**, enter `https://your-domain.ngrok-free.app` as the **Public base URL**.
4. In **Settings > Webhook health**, press **Check public URL**, then **Re-register all**. Do this with dry-run off, or nothing is sent to GitLab.

**Never point ngrok at port 3000.** That is the private dashboard, which has no login. On port 3001 the only route is `POST /webhook/:repoId`, and everything else gets a 404.

Webhooks are optional. Without them the dashboard still syncs on its schedule: Notion about every 45 seconds, and everything every 10 minutes.

## Google Drive

Staging APKs go to a Shared Drive, because a service account has no storage of its own and cannot upload to a personal My Drive folder.

1. In Google Cloud, create a project, enable the **Google Drive API**, and create a **service account**. No roles are needed.
2. Create a JSON key for it and save the file outside this repo, or inside the git-ignored `data/`. Then run `chmod 600` on it.
3. In Google Drive, create a **Shared Drive**. This needs Google Workspace.
4. Add the service account's email to that Shared Drive as **Content manager**. Share nothing else with it.
5. Create a folder per repo, and copy the ID from its URL.
6. In **Settings > Google Drive**, enter the key file's path, which can be relative to the repo root. Put each folder ID in its repo's settings, then press the connection test.

**Anyone with the link** is on by default, so QA can open a link from WhatsApp, and so can anyone it gets forwarded to. Turn it off in Settings to keep files restricted.

**Only staging builds are ever uploaded or shared.** Prod and custom builds are refused in the code, and no setting changes that. The dashboard also never sends a WhatsApp message itself: it gives you a link, and you press send.

## Web Push (VAPID)

```bash
pnpm push:keys
```

Paste the three printed lines into `.env`, set `VAPID_SUBJECT` to your own `mailto:` address, and restart. Then turn on notifications in the app's header.

- The private key is a secret, so never commit or share it.
- Changing the key pair cancels every browser subscription, so turn notifications on again afterwards.
- Browsers treat `:3000` and `:5173` as separate sites, so each needs its own subscription.

To get notifications with the browser fully closed, set `NTFY_TOPIC` as well. Pick a long random topic, because anyone who knows it can read your notifications, and the text passes through the ntfy server.

## Environment variables

Everything else lives in Settings. All of these are read at startup.

| Variable                                | Default            | Purpose                                                                         |
| --------------------------------------- | ------------------ | ------------------------------------------------------------------------------- |
| `MASTER_KEY`                            | none, **required** | 32 random bytes, base64 or hex. Encrypts secrets at rest.                       |
| `DATA_DIR`                              | `./data`           | Holds the database and built APKs. Relative paths start at the repo root.       |
| `LOG_LEVEL`                             | `info`             | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`.                 |
| `NODE_ENV`                              | unset              | `pnpm start` sets `production`, which removes the Vite port from the allowlist. |
| `DASHBOARD_HOST`                        | `127.0.0.1`        | Any other value is refused.                                                     |
| `DASHBOARD_PORT`                        | `3000`             | Must differ from `WEBHOOK_PORT`.                                                |
| `WEBHOOK_HOST`                          | `127.0.0.1`        | The ngrok agent runs on this machine, so loopback is enough.                    |
| `WEBHOOK_PORT`                          | `3001`             | Forward ngrok to this port.                                                     |
| `DASHBOARD_TLS_HOSTS`                   | none               | Hostnames a local HTTPS proxy (`tailscale serve`) serves the dashboard under.   |
| `DASHBOARD_TLS_USERS`                   | none               | Tailscale logins allowed through those hosts. Required with them.               |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | none               | Web Push keys, from `pnpm push:keys`. Push stays off without them.              |
| `VAPID_SUBJECT`                         | none               | A `mailto:` address or an https URL you control.                                |
| `NTFY_TOPIC`                            | none               | Optional fallback notification channel. Treat it as a password.                 |
| `NTFY_SERVER`                           | `https://ntfy.sh`  | Must be https.                                                                  |
| `BUILD_TIMEOUT_MIN`                     | `30`               | Time limit for one build job, in minutes (1 to 720).                            |
| `BUILD_PASS_ENV`                        | none               | Variable names a build may see despite secret-looking names. See below.         |

### `BUILD_PASS_ENV`

Commands the dashboard runs do not get variables whose names look secret (`*TOKEN*`, `*PASSWORD*`, `*API_KEY*` and so on). If your Gradle signing reads some, set them in `.env` and list their **names**:

```bash
KEYSTORE_PASSWORD=...
KEY_PASSWORD=...
BUILD_PASS_ENV=KEYSTORE_PASSWORD,KEY_PASSWORD
```

They go to build commands only, and their values are hidden from the build log. The server refuses to start if the list names `MASTER_KEY`, `VAPID_PRIVATE_KEY` or `NTFY_TOPIC`.

The custom release command does not get them. If a repo's signing needs them, use the built-in engine for that repo's releases.

## Requirements for builds and releases

- `git`, `flutter` and `fvm` on the server's `PATH`, plus `glab` for the custom release command. With Docker, that is the host's `PATH`, where `pnpm agent` runs (see [Builds and the custom release command with Docker](#builds-and-the-custom-release-command-with-docker)).
- The custom release command uses `tools/bin/vu` (bundled), or `VU_BIN_DIR`, or `RELEASE_COMMAND`.
- Android signing set up for each project, as for a normal local release build. Signing files are usually git-ignored, so a new bot clone does not have them. When a build fails on signing, Builds and Release Train offer an upload: `key.properties` and its keystore go where the repo's Gradle files expect them, with mode 600. The upload is refused if git does not ignore the path.

## Backups

**Settings > Backup & export** offers two kinds:

- **Config export**: settings and repos as JSON. Secrets are left out unless you choose to seal them with a passphrase. Only import files you made yourself, as an import can change where your tokens get sent. The preview shows what would change.
- **DB backup**: a full copy of the database. Secrets in it stay encrypted, but it holds webhook payloads, audit rows and build logs in the clear, so treat the file as private.

## Docker

Native install (`pnpm install && pnpm start`) is the default and the simplest. `compose.yaml` runs the dashboard in a container instead:

```bash
docker compose up -d --build                                   # the dashboard only
docker compose --profile ngrok --profile tailscale up -d       # plus the webhook URL and phone access
```

- Ports `3000` (dashboard) and `3001` (webhook) are published on the host's `127.0.0.1` only.
- The `ngrok` profile forwards your static domain to the webhook listener (`app:3001`), with the traffic policy in `docker/ngrok/policy.yml` (only `POST /webhook/*` gets through). Set `NGROK_AUTHTOKEN` and `NGROK_URL` in `.env`, and stop any ngrok agent on the host: one domain cannot be served by two agents.
- The `tailscale` profile gives phones access, see [Phone access through Tailscale](#phone-access-through-tailscale).

| Variable               | Default               | Purpose                                                                                      |
| ---------------------- | --------------------- | -------------------------------------------------------------------------------------------- |
| `NGROK_AUTHTOKEN`      | none                  | ngrok agent token for the `ngrok` profile.                                                   |
| `NGROK_URL`            | none                  | Your static ngrok domain, e.g. `https://your-domain.ngrok-free.app`.                         |
| `HOST_AGENT_TOKEN`     | (required for builds) | Shared by the dashboard and `pnpm agent`. At least 24 characters.                            |
| `HOST_AGENT_PORT`      | `3002`                | The agent's port on the host's `127.0.0.1`.                                                  |
| `HOST_AGENT_GIT_PROXY` | none                  | Optional HTTP proxy git uses for the repo host, for a GitLab reachable only through a proxy. |
| `TS_HOSTNAME`          | `relay`               | The Tailscale device name of the `tailscale` profile.                                        |

### Builds and the custom release command with Docker

The image has no Flutter, Android SDK or `vu`: the host already has them. The dashboard sends every git, flutter and `vu` command to a small **host agent** on the host, which runs them with its own toolchain and `PATH`.

```bash
pnpm agent        # on the host, in a terminal you keep open; Ctrl+C stops it
```

- The agent listens on the host's `127.0.0.1:3002` only, and refuses any request without `HOST_AGENT_TOKEN`. It runs only what the dashboard itself may run: allowlisted `git`/`flutter`/`fvm` commands inside a bot clone, and the release command (`vu`, or `RELEASE_COMMAND`) with the custom engine's arguments. The only input it passes to `vu` is Enter at the review prompt.
- The bot clones live on the host in `~/.relay/clones`, mounted into the container at the same path. The dashboard reads `pubspec.yaml` and the built APK from there and copies the APK to `data/apks`.
- If your GitLab is reachable only through a proxy, set `HOST_AGENT_GIT_PROXY`: git (and `vu`'s glab) use it for the repo host only. Everything else, such as pub.dev, Maven and Gradle downloads, goes direct.
- Git authenticates with the repo's GitLab token, so **clone URLs should be https** (`https://gitlab.example.com/group/app.git`). An ssh URL cannot go through a proxy.
- Start the agent from a terminal, so it gets the same `PATH` as your shell (`flutter`, `glab`, `fvm`). If the agent is down, Settings shows the custom release command as unavailable with the reason, and a build fails with "host agent cannot be reached".

### Phone access through Tailscale

The dashboard has no login, so it is never published on the LAN. A phone reaches it through Tailscale instead, over HTTPS and only for your own Tailscale login. The `tailscale` service in `compose.yaml` is its own Tailscale device, so the host needs no Tailscale login of its own. It can stay logged out, or join a different tailnet.

1. Create an auth key in the Tailscale admin console (Settings > Keys) and save it to `docker/tailscale/authkey` (git-ignored), then run `chmod 600` on it. The key is used only for the first login; the login itself is kept in the `tailscale-state` volume.
2. In `.env`, set:

   ```bash
   DASHBOARD_TLS_HOSTS=relay.your-tailnet.ts.net   # TS_HOSTNAME (default relay) + your tailnet
   DASHBOARD_TLS_USERS=you@example.com                      # the Tailscale login(s) allowed in
   ```

3. Run `docker compose --profile tailscale up -d`, then open `https://relay.your-tailnet.ts.net` on a phone logged in to the same tailnet.

Tailscale adds a `Tailscale-User-Login` header to each request and drops any that the client sent. On a `DASHBOARD_TLS_HOSTS` host, the server refuses any request whose login is not in `DASHBOARD_TLS_USERS`, so other members of a shared tailnet cannot get in. Never turn on Funnel here: it would put the dashboard on the public internet.

### Install on the phone (PWA)

The dashboard is an installable web app (manifest + icons in `apps/web/public`). Install it from the Tailscale `https://` address, not from a LAN IP: browsers only install and allow push on a secure origin.

- **Android (Chrome):** menu › **Install app** (or **Add to Home screen**). Open Relay from the launcher and turn on notifications in the header.
- **iPhone / iPad (Safari, iOS 16.4+):** **Share** › **Add to Home Screen**. Open Relay from the Home Screen and turn on notifications there. iOS never allows Web Push in a Safari tab, only in the installed app, and the installed app has its own subscription.

The app needs the network: the service worker only handles push, it does not cache pages for offline use.

## Troubleshooting

### Corepack: `Cannot find module .../corepack/v1/pnpm/12.16.1/bin/pnpm.cjs`

This can happen on a machine with two Node installs on `PATH`, say Node 22 from one installer and Node 26 from Homebrew. pnpm 12's cached package has `bin/pnpm.mjs`, while corepack looked for `bin/pnpm.cjs`.

The project needs Node 22 or newer, so either install works. Check which one you are getting:

```bash
which -a node
node -v
```

Then use either way past the error.

**Run pnpm 12's cached file with `node`:**

```bash
node ~/.cache/node/corepack/v1/pnpm/12.16.1/bin/pnpm.mjs install
```

**Or install pnpm without corepack:**

```bash
corepack disable
npm install -g pnpm@12.16.1
```

### The custom release command shows as unavailable

The Release Train view shows the reason.

- **`node-pty` did not load:** confirm that `allowBuilds` in `pnpm-workspace.yaml` includes it, then run `pnpm install`. The native module also has to match your Node version, so if you switched Node, run `pnpm rebuild node-pty`.
- **`vu` not found:** check that `tools/bin/vu` (or `VU_BIN_DIR`, `~/bin/vu`, `RELEASE_COMMAND`) exists and is executable.
- **The host agent is not reachable (Docker):** run `pnpm agent` on the host, and check that `HOST_AGENT_TOKEN` in `.env` is the same for both. After changing `.env`, run `docker compose up -d` again.

### `pnpm start` shows a JSON 404, or no page at `:3000`

There is no UI build yet. Run `pnpm build`, then start again. The log has a warning when no build is found.

### A request fails with `bad_host`, `bad_origin` or `csrf`

- `bad_host`: use `127.0.0.1:3000`. A proxy or a custom hostname is refused on purpose.
- `bad_origin`: the request came from another site or port. After `pnpm start`, `:5173` is no longer allowed.
- `csrf`: a script or `curl` call needs the header `X-Requested-With: relay`.

### The server stops at boot with `invalid MASTER_KEY`

It must decode to exactly 32 bytes. Use the command in the README's setup. If you are replacing a lost key, stored tokens cannot be recovered: move `data/app.db` aside or enter the tokens again.

### Webhooks do not arrive

Open **Settings > Webhook health**.

- **Check public URL fails:** ngrok is not running, it forwards to the wrong port, or the domain does not match Settings.
- **The check passes but nothing arrives:** press **Re-register all** with dry-run off, and check the hook's delivery log in GitLab.
- **Deliveries get 401:** the hook's secret no longer matches, which can follow a config import. Register the hook again.

The Sync Health view shows what the scheduled sync has seen in the meantime.

### Nothing changes in GitLab or Notion

Check whether dry-run is on. Writes are then recorded in the Audit view, marked as dry-run, and not sent.

### Drive upload fails with a storage quota error

The folder is not on a Shared Drive. See [Google Drive](#google-drive).

### Push notifications do not appear

Check that the three `VAPID_*` values are set and that you restarted, then look at the browser's and the OS's notification permissions. If you changed the keys, turn notifications off and on again in the header.
