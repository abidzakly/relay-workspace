# Security checklist

**Every item below is "code reviewed, not run".** This audit read the code and never booted the server or sent a request, so nothing here has passed at runtime. Each item gives evidence as `file:line` and a command that confirms it live.

Paths are relative to `apps/server/src` unless they start with `apps/` or `packages/`. Line numbers are from the commit that added this file.

The commands assume the server is running with `pnpm start`, on the default ports. `:3000` is the dashboard and `:3001` is the webhook listener. They are safe to run: none of them reaches GitLab, Notion or Drive.

```bash
CSRF='X-Requested-With: relay'
```

## Status key

- **Code reviewed, not run**: the code does what the item asks. Run the command to confirm.
- **Fixed during the audit**: a gap this audit found and closed. Also code reviewed, not run.
- **Accepted risk**: see [Accepted risks](#accepted-risks).
- **Open**: code cannot settle it. A person has to check or decide.

## Items

### 1. The dashboard binds to loopback only

Code reviewed, not run.

- Only `127.0.0.1` is accepted, by the schema and again right before `listen`: `config/env.ts:7`, `config/env.ts:43`, `http/listen.ts:12`, `http/listen.ts:20`.
- `apps/web/vite.config.ts` binds the dev and preview servers to `127.0.0.1`.

```bash
lsof -nP -iTCP:3000 -sTCP:LISTEN        # expect 127.0.0.1:3000 only
DASHBOARD_HOST=0.0.0.0 pnpm start       # expect a refusal at boot
curl -si -H 'Host: evil.example' http://127.0.0.1:3000/api/health | head -1   # expect 403 (bad_host)
```

### 2. The webhook listener exposes only `POST /webhook/:repoId`

Code reviewed, not run. See risks R5 and R6.

- One route, and the not-found handler answers the rest: `http/webhookApp.ts:79`, `http/webhookApp.ts:82`, `http/errors.ts:46`.
- Body limit 1 MiB: `http/webhookApp.ts:41`, `http/webhookApp.ts:56`.
- Rate limit 300 per minute: `http/webhookApp.ts:64-67`.
- The token is checked in constant time before the body is parsed, and an unknown repo gets the same 401: `http/webhookApp.ts:10`, `http/webhookApp.ts:84-95`.
- `/api`, `/apks` and the UI are registered only in `buildDashboardApp`: `http/dashboardApp.ts:94`.

```bash
curl -si http://127.0.0.1:3001/api/state | head -1                 # expect 404
curl -si http://127.0.0.1:3001/ | head -1                          # expect 404
curl -si http://127.0.0.1:3001/webhook/nope | head -1              # GET: expect 404
curl -si -X POST http://127.0.0.1:3001/webhook/nope | head -1      # expect 401
curl -si -X POST -H 'X-Gitlab-Token: wrong' -H 'Content-Type: application/json' \
  -d '{}' http://127.0.0.1:3001/webhook/<real-repo-id> | head -1   # expect 401
```

### 3. Secrets are encrypted at rest and masked, and the API never returns them

Code reviewed, not run. See risk R9.

- AES-256-GCM with the row as authenticated context: `config/crypto.ts:60-91`, `config/store.ts:125`, `config/store.ts:149`, `config/store.ts:158`.
- Public shapes for the API: `packages/shared/src/config.ts:188`, `packages/shared/src/config.ts:319`.
- Audit values pass a key-based redactor: `audit/redact.ts:4`, `audit/redact.ts:31`.
- The DB file is `0600` and its new folder `0700`: `db/open.ts:31`, `db/open.ts:37`.

```bash
curl -s http://127.0.0.1:3000/api/settings | grep -c '<your notion token>'   # expect 0
curl -s http://127.0.0.1:3000/api/repos    | grep -c '<your gitlab token>'   # expect 0
sqlite3 data/app.db .dump | grep -c '<your gitlab token>'                    # expect 0
stat -f '%Lp %N' data data/app.db                                            # expect 700 and 600
```

**Fixed during the audit:** a clone URL is public config, returned by the API and written to the audit log, yet `https://user:token@host/x.git` was accepted. New values with credentials are now refused: `http/routes/repos.ts:31`, `services/configBackup.ts:280`. A row already stored that way stays as it is: re-save it after removing the credentials.

```bash
sqlite3 data/app.db "select id from repos where json_extract(config,'$.cloneUrl') like 'http%@%'"   # expect no rows
```

### 4. Secrets are never logged

Code reviewed, not run. See risk R4.

- pino redaction paths to depth 3: `util/logger.ts:7-38`.
- Request logging is off on both listeners: `http/dashboardApp.ts:99`, `http/webhookApp.ts:60`.
- Outbound logs carry host and path only, without query or userinfo: `services/httpClient.ts:62`.
- The ntfy topic goes in the body, not the URL: `services/ntfyChannel.ts:12`.
- Command output is redacted: `services/gitExec.ts:117`.

```bash
LOG_LEVEL=trace pnpm start > /tmp/cd.log 2>&1    # use the app for a while, then stop it
grep -cE 'glpat-|ntn_|secret_' /tmp/cd.log       # expect 0
rm /tmp/cd.log
```

### 5. CSP on the dashboard, with no inline scripts

**Fixed during the audit**, then code reviewed, not run. See risks R2 and R3.

The gap: the header was only ever sent on API responses, because the server did not serve the UI. Pages came from Vite with no CSP, and `pnpm start` had no UI at all. `http/staticUi.ts` now serves `apps/web/dist` from the private listener: `http/dashboardApp.ts:106`, `index.ts:163`.

- The policy has `script-src 'self'`, and `onSend` adds it to every response: `http/security.ts:6-19`, `http/security.ts:68`.
- `apps/web/index.html:8` loads the theme script from a file, and the built `index.html` holds no inline script.

```bash
curl -sI http://127.0.0.1:3000/ | grep -i content-security-policy          # expect the policy
curl -s  http://127.0.0.1:3000/ | grep -c '<script>'                       # expect 0
curl -s  http://127.0.0.1:3000/ | grep -cE ' on[a-z]+='                    # expect 0
curl -si http://127.0.0.1:3000/api/nope | head -1                          # expect 404, JSON
curl -si --path-as-is http://127.0.0.1:3000/../../package.json | head -1   # expect 404
```

Then open `http://127.0.0.1:3000`, look at every view, and check the browser console for CSP violations. This has never been tried, so treat it as the first thing to check.

### 6. CSRF on state-changing routes

Code reviewed, not run. See risk R1.

- Every POST, PUT, PATCH and DELETE needs the custom header, and an Origin, if sent, must be allowed: `http/security.ts:55-63`.
- The server approves no preflight, as no OPTIONS route or CORS plugin exists.
- SameSite does not apply: the dashboard has no cookies.
- GET routes only read, including the live GitLab read in `GET /api/mrs/:repo/:iid`. DB backup and export are POST for this reason: `http/routes/backup.ts:35`.

```bash
curl -si -X POST http://127.0.0.1:3000/api/sync/refresh | head -1                                       # expect 403 (csrf)
curl -si -X POST -H "$CSRF" -H 'Origin: https://evil.example' http://127.0.0.1:3000/api/sync/refresh | head -1   # expect 403 (bad_origin)
curl -si -X OPTIONS -H 'Origin: https://evil.example' http://127.0.0.1:3000/api/state | grep -ci access-control  # expect 0
```

### 7. `execFile` with an allowlist and a locked cwd

Code reviewed, not run. `vu` is the one exception: see item 11.

- `git`, `flutter` and `fvm` only, and no shell: `services/gitExec.ts:14`, `services/gitExec.ts:267`, `services/gitExec.ts:344`, `services/gitExec.ts:416`.
- Subcommands and options are restricted: `services/gitExec.ts:129`, `services/gitExec.ts:149`, `services/gitExec.ts:186`, `services/gitExec.ts:244`.
- The cwd must be the repo's real clone folder: `services/gitExec.ts:99`, `services/gitExec.ts:528`.
- Those two files are the only ones that start a process.

```bash
grep -rnE "child_process|\.spawn\(|shell: *true" apps/server/src apps/server/scripts | grep -v '\.test\.'
# expect gitExec.ts (import, spawn) and ptyEngine.ts (node-pty) only
```

**Fixed during the audit:** `childEnv` kept variables like `FOO_API_KEY`, `AWS_ACCESS_KEY_ID` and `*_PASSPHRASE` in every child's environment. They are now stripped: `services/gitExec.ts:287`.

### 8. Branch and version strings are validated

Code reviewed, not run.

- The rules: `packages/shared/src/common.ts:10`, `:40`, `:53`, `:65`, `:73`.
- Clone URLs: `packages/shared/src/config.ts:197-203`.
- Uses: `services/cloneManager.ts:67`, `services/ptyEngine.ts:209`, `services/releaseSteps.ts:224`, `services/flutterBuild.ts:177`, `services/releaseEngine.ts:94`.
- A second layer refuses transport helpers such as `ext::`, and limits protocols: `services/gitExec.ts:172`, `services/gitExec.ts:305`.

```bash
curl -s http://127.0.0.1:3000/api/repos/<repo> | jq '.repo | .baseBranch = "main; touch /tmp/x"' |
  curl -s -X PUT -H "$CSRF" -H 'Content-Type: application/json' -d @- \
  http://127.0.0.1:3000/api/repos/<repo>                # expect a validation error on baseBranch
```

### 9. Markdown is sanitized, and no other raw HTML reaches the page

Code reviewed, not run.

- `apps/web/src/components/Markdown.tsx:11` is the only `dangerouslySetInnerHTML`, and it takes only the output of `renderMarkdown`.
- `marked`, then DOMPurify with an allow-list of tags and attributes: `apps/web/src/lib/markdown.ts:32-49`, `:77-84`.
- Links must be http(s) or mailto, and images become plain links: `apps/web/src/lib/markdown.ts:24-28`, `:51`, `:60`.
- No `innerHTML`, `srcDoc`, `document.write`, `insertAdjacentHTML`, `eval` or `new Function` exists in the web app.
- The build log and the PTY stream render as text. The terminal has `disableStdin`: `apps/web/src/release/PtyTerminal.tsx:26`.

```bash
grep -rnE "dangerouslySetInnerHTML|innerHTML|srcDoc|document\.write|insertAdjacentHTML|eval\(|new Function" apps/web/src apps/web/index.html
# expect Markdown.tsx:11, plus the comment at lib/markdown.ts:87
```

Then post `<img src=x onerror=alert(1)>` and `[x](javascript:alert(1))` as comments on a test MR and open it in MR Detail. No alert should fire, and the link should have no `href`.

**Fixed during the audit:** several links used a URL from GitLab, Notion or Drive directly in `href`. They now go through `safeHref`, as the others already did: `apps/web/src/board/CardTile.tsx`, `apps/web/src/kpi/SlaTable.tsx`, `apps/web/src/kpi/TodaysFocus.tsx`, `apps/web/src/views/Kpi.tsx`, `apps/web/src/builds/ShareControls.tsx`.

### 10. Token scopes and rotation

**Open.** Code cannot judge either, so check them yourself. The steps are in the README under [Tokens](../README.md#tokens).

- GitLab `api`, Notion shared to the one database, Drive limited to the one Shared Drive.
- Rotate any token that has appeared in a chat or a screenshot before first use.

## Added since section 16

### 11. `vu` runs beyond the allowlist, and gets a token in its environment (4.6)

Code reviewed, not run. See risk R7.

- It is a deliberate second path, chosen by the user per release. It runs one fixed file, `~/bin/vu`, through node-pty: `services/ptyEngine.ts:291`.
- Fixed argument shape, with base and version validated: `services/ptyEngine.ts:110`, `services/ptyEngine.ts:209`, `services/releaseEngine.ts:94`.
- The cwd is the bot clone, after `ensureClone` and `sync` have passed the lock: `services/ptyEngine.ts:266-268`, `:287`.
- The only input is one carriage return, at the exact review prompt after its banner: `services/ptyEngine.ts:370`, `:561-566`.
- It refuses dry-run and repos that need the version MR gate: `services/ptyEngine.ts:200`, `:206`.
- `GITLAB_TOKEN` goes in this one process's environment, never in the arguments: `services/ptyEngine.ts:327`. Output is redacted before it is streamed or stored: `services/ptyEngine.ts:520`, `:534`.

```bash
# During a PTY release, on a test repo:
ps eww -o command= -p "$(pgrep -f 'bin/vu')" | grep -c GITLAB_TOKEN   # expect 1: only this process tree
ps -o command= -p "$(pgrep -f 'bin/vu')" | grep -c glpat-             # expect 0: not in the arguments
sqlite3 data/app.db "select count(*) from job_steps where log like '%glpat-%'"   # expect 0
```

### 12. `BUILD_PASS_ENV` (5.1)

Code reviewed, not run. See risk R8.

- It holds names only, is validated at boot, and can never name `MASTER_KEY`, `VAPID_PRIVATE_KEY` or `NTFY_TOPIC`: `config/env.ts:17-30`, `config/env.ts:66-69`.
- The values reach build commands only, and are added to that run's redaction list: `services/buildQueue.ts:471`, `services/buildQueue.ts:525-537`.
- A missing variable is reported by name, never by value: `services/buildQueue.ts:533`.
- `vu` does not get these values, because `envFor` starts from `childEnv`. A PTY release whose Gradle signing reads such a variable will not find it.

```bash
BUILD_PASS_ENV=MASTER_KEY pnpm start     # expect a refusal at boot
# Build with a signing password set, then:
sqlite3 data/app.db "select count(*) from job_steps where log like '%<the password>%'"   # expect 0
```

### 13. `/apks` downloads (5.2)

Code reviewed, not run.

- Registered on the private listener only, behind the Host check: `http/dashboardApp.ts:129`.
- Exactly `<repo>/<file>`, with no separators, control characters or hidden files, and only `.apk` or `.aab`: `http/apks.ts:18-29`.
- A symlink cannot lead out: `http/apks.ts:54-56`, `http/apks.ts:61-64`.
- Sent as an attachment with `nosniff`, so it never renders in the page: `http/apks.ts:31-38`, `http/apks.ts:72-77`.

```bash
curl -si http://127.0.0.1:3001/apks/x/y.apk | head -1                                 # expect 404
curl -si --path-as-is http://127.0.0.1:3000/apks/x/../../app.db | head -1             # expect 400 or 404
curl -si http://127.0.0.1:3000/apks/x%2F..%2F..%2Fapp.db | head -1                    # expect 400
curl -si http://127.0.0.1:3000/apks/x/.hidden.apk | head -1                           # expect 400
```

### 14. Drive and the staging-only rule (5.3)

Code reviewed, not run. See risks R10 and R11.

- The rule reads only the job and its result, so no setting can change it: `services/shareRule.ts:9-17`.
- It is applied at both layers: `services/driveService.ts:214`, and in `services/share.ts:348`, which every share entry point goes through (`:135`, `:194`).
- Prod and custom releases skip the upload step: `services/releasePipeline.ts:290`.
- Nothing is sent to WhatsApp. The server returns a `wa.me` link and a person presses send: `services/share.ts:30`, `services/share.ts:72`.
- The key file's path is config, and its contents never leave the server.

```bash
curl -si -X POST -H "$CSRF" -H 'Content-Type: application/json' -d '{}' \
  http://127.0.0.1:3000/api/builds/<prod-job-id>/upload | head -1    # expect 403 prod_never_shared
curl -si -X POST -H "$CSRF" -H 'Content-Type: application/json' -d '{}' \
  http://127.0.0.1:3000/api/share/<prod-job-id> | head -1            # expect 403 prod_never_shared
```

### 15. Config export and import (8.2)

Code reviewed, not run. See risk R12.

- Secrets are out by default, and the file's `secrets` is `null`: `services/configBackup.ts:160-180`.
- The export fails if a secret value appears in the readable part: `services/configBackup.ts:129-144`.
- With a passphrase, secrets are sealed with scrypt and AES-256-GCM, with fixed KDF settings that a file cannot lower: `services/configBackup.ts:25`, `:49-59`, `:61-79`.
- Malformed, older, newer, partial and duplicate files are refused: `services/configBackup.ts:242-285`.
- Preview writes nothing. Import needs `confirm: true` and is audited: `http/routes/backup.ts:66-97`.

```bash
curl -s -X POST -H "$CSRF" -H 'Content-Type: application/json' -d '{"includeSecrets":false}' \
  http://127.0.0.1:3000/api/backup/config/export > /tmp/cfg.json
grep -c '<your token>' /tmp/cfg.json                  # expect 0
grep -c '"secrets":null' /tmp/cfg.json                # expect 1
rm /tmp/cfg.json
```

### 16. DB backup (8.2)

Code reviewed, not run. See risk R12.

- POST only, so the CSRF header applies, and it is audited: `http/routes/backup.ts:99-127`.
- The working copy sits in an owner-only folder and is unlinked once opened: `services/dbBackup.ts:26-44`.
- Leftovers from a crash are removed at startup: `services/dbBackup.ts:13`, `http/routes/backup.ts:47`.

```bash
curl -si -X POST http://127.0.0.1:3000/api/backup/db | head -1       # expect 403
curl -si -X POST -H "$CSRF" http://127.0.0.1:3001/api/backup/db | head -1   # expect 404
ls -a data | grep -c '.db-backup-'                                   # expect 0 when idle
```

### 17. Public URL check (8.2)

Code reviewed, not run.

- One GET, no retry, no secret, with an 8 second timeout, on the user's click only: `services/webhookHealth.ts:27-42`, `http/routes/webhookHealth.ts:25`.
- It cannot store a delivery, as the webhook route is POST only.
- The client does not follow redirects, so the domain cannot send it elsewhere: `services/httpClient.ts:85`.

Check: watch the ngrok inspector at `http://127.0.0.1:4040` while pressing the button. Expect one GET, and no `X-Gitlab-Token` header.

### 18. The audit route never returns undo tokens (3.4)

Code reviewed, not run.

- `GET /api/audit` drops the field from each row: `http/routes/undo.ts:28`.
- The response type omits it: `packages/shared/src/audit.ts:34`.
- The audit event on the bus carries the id only: `sync/auditEvents.ts:10`.
- Action responses return `auditId` and a boolean `undoable`: `services/mrActions.ts:319-322`, `services/cardActions.ts:427-429`, `services/undoEngine.ts:73-79`.

```bash
curl -s http://127.0.0.1:3000/api/audit | grep -ci undoToken   # expect 0
```

### 19. Dependency advisories

**Open.** This calls the registry, so the audit did not run it.

```bash
pnpm audit --prod
```

## Accepted risks

| ID  | Risk                                                                                                                                                                                                                                                 | Why it is accepted                                                                                                                                         |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | The dashboard has no login. Any process on this machine can call `:3000`, since the CSRF header is a public constant.                                                                                                                                | It is a single-user local tool, and a hostile local process could already read `.env`. The Host and Origin checks stop remote web pages.                   |
| R2  | `pnpm dev` pages come from Vite with no CSP, because Vite's React preamble is inline. Outside `NODE_ENV=production`, the Host and Origin allowlist also includes port 5173.                                                                          | Development only. Use `pnpm start` for daily use.                                                                                                          |
| R3  | The CSP has `style-src 'unsafe-inline'`.                                                                                                                                                                                                             | React and R3F set style attributes at runtime, and styles cannot run script. Injected CSS remains limited by the Markdown allow-list, which drops `style`. |
| R4  | Log and output redaction is best effort. It matches exact values and known token shapes, so a secret printed in another encoding would pass. An unhandled error's message is logged as is. A PTY secret split across a 100 ms flush would also pass. | Known secrets are kept out of messages by construction. Removing this risk would mean not storing output at all.                                           |
| R5  | The webhook rate limit is effectively global behind the ngrok agent, because all requests share one address. An attacker could use up the 300 per minute, and GitLab deliveries would then get 429s.                                                 | No data is exposed. The periodic full sync catches up on anything missed.                                                                                  |
| R6  | Per the `@fastify/rate-limit` README, 404s need their own opt-in, and the webhook listener's are not limited.                                                                                                                                        | The 404 is a fixed reply that touches no disk or DB. An ngrok traffic policy can add a filter if this ever matters.                                        |
| R7  | `vu` and everything it starts, including the project's Gradle scripts, can read `GITLAB_TOKEN`.                                                                                                                                                      | Option B needs it, and the user chooses it per release. Use the node engine for repos whose build scripts you do not trust.                                |
| R8  | A project's build scripts can read `BUILD_PASS_ENV` values and could write them in a changed form that redaction misses.                                                                                                                             | The user lists the names, and the bot clones hold the user's own repos.                                                                                    |
| R9  | `MASTER_KEY` is plaintext in `.env`, and anyone who has it can decrypt `app.db`.                                                                                                                                                                     | By design. The README says to `chmod 600 .env` and to keep the key out of backups.                                                                         |
| R10 | The Drive scope is the full `drive`, because `drive.file` cannot read an existing folder (`services/drive.ts:17`).                                                                                                                                   | Limit the reach by sharing only the one Shared Drive with the service account.                                                                             |
| R11 | `drive.anyoneWithLink` defaults to on, so anyone holding the link can download a staging APK.                                                                                                                                                        | QA needs to open it from WhatsApp. Turn it off in Settings for restricted access.                                                                          |
| R12 | A DB backup holds webhook payloads, audit rows, undo tokens, build logs and push subscriptions in the clear, plus encrypted secrets. An imported config can also change the GitLab host, which is where tokens would then be sent.                   | Backups are the user's own files, and the UI warns about them. Import shows what changes before it writes. Only import files you made.                     |

## Open decisions

- **Which flavors count as staging?** `services/shareRule.ts:14` refuses only `production`, so a staging-mode build of another flavor, such as `preprod`, can be shared. Tighten it if it should not be.
- **Stored clone URLs.** The new check covers new writes only. Run the query in item 3 once.
