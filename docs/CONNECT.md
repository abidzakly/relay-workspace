# Connect buttons: one-time setup

With this setup done, the cards in **Settings > Connections** show **Connect with Google**, **Connect with GitLab**
and **Connect with Notion**. A click opens the service's own sign-in page. You sign in with your own account and
allow access, and the card shows the connection. Nothing to copy or paste.

For that to work, Relay must be registered once with each service as an "OAuth client": an ID and, for some services,
a secret. Whoever runs Relay for a team does this **once**, then everyone puts the same values in their `.env`. These
values identify the app, not you. Your own sign-in is kept encrypted on your machine, and is never exported.

You can set up only some of them. A card whose client is missing says "Not set up yet": turn on its
**Advanced mode** to use the old way (a pasted token, your own OAuth client, a service-account key).

## One way in at a time

The GitLab, Google and Notion cards each have an **Advanced mode** switch. Off (Connect mode), Relay uses only the
sign-in. On, it uses only what you set by hand:

| Card | Connect mode | Advanced mode |
| --- | --- | --- |
| GitLab | the GitLab sign-in, for every repo, Reviews and git over HTTPS | each repo's project token, the Reviews personal token |
| Google: Calendar & Drive | the Google sign-in (Calendar and Drive are asked for separately) | your own OAuth client for Calendar, a service account for Drive |
| Notion | the Notion sign-in, set up with the wizard at `/setup/notion` | an integration token and the mapping typed in |

The way not in use is kept (the sign-in stays signed in, tokens stay stored) but ignored until you switch back. On
first start after this change, each card picks the mode that keeps your current setup working.

After you change `.env`, restart Relay.

## Google (Calendar and Drive)

One client covers both. Calendar is read-only. Drive uses the `drive.file` scope: Relay sees only the files and
folders it creates itself, and this scope needs no review by Google.

1. Open <https://console.cloud.google.com>, then pick or create a project.
2. Under **APIs & Services > Library**, enable the **Google Calendar API** and the **Google Drive API**.
3. Under **Google Auth Platform**, set up the consent screen:
   - Choose **Internal** if your team shares one Google Workspace. Only your organisation can then sign in, and no
     Google review is needed.
   - Otherwise choose **External**. Then go to **Audience** and press **Publish app** ("In production"). In "Testing"
     mode Google ends every sign-in after **7 days**. A published app that Google has not verified shows a warning
     screen ("Google hasn't verified this app": press Advanced, then continue). It is limited to 100 users.
4. Under **Clients**, create a client of type **Desktop app**. A desktop client accepts Relay's loopback address
   (`http://127.0.0.1:3000/api/oauth/google/callback`) as it is, on any port.
5. Copy the client ID and secret into `.env`:

   ```sh
   GOOGLE_OAUTH_CLIENT_ID=1234…apps.googleusercontent.com
   GOOGLE_OAUTH_CLIENT_SECRET=GOCSPX-…
   ```

Google treats a desktop client's secret as not confidential, but keep it out of a public repository anyway: GitHub's
secret scanning reports it to Google, and Google may then disable it.

Drive with a sign-in uploads as you. A repo with no Drive folder set gets a folder made for it on its first upload,
named "Relay builds · <repo>". To use an existing folder, open it in Drive, then share it with the folder Relay made,
or keep the service account for that repo.

## GitLab

1. In GitLab, open **User settings > Applications**. On a company instance, an admin can add the same thing under
   **Admin > Applications** instead, so it belongs to the instance.
2. Add a new application:
   - **Name:** Relay
   - **Redirect URI:** `http://127.0.0.1:3000/api/oauth/gitlab/callback`. Use your port if you changed
     `DASHBOARD_PORT`.
   - **Confidential:** off. Relay runs on each person's machine, and it uses PKCE instead of a secret.
   - **Scopes:** `api`
3. Copy the **Application ID** into `.env`:

   ```sh
   GITLAB_OAUTH_CLIENT_ID=…
   ```

   If you left Confidential on, also set `GITLAB_OAUTH_CLIENT_SECRET`.

4. In Relay, set the GitLab host under **Settings > Connections**. Then press **Connect with GitLab**.

What the sign-in covers:

- **Repos:** every repo without a project access token of its own. In **Add repository** you can then leave the token
  empty, and pick the project from a list. Merge requests, comments and approvals that Relay sends then show under
  your name. A repo that keeps its project token keeps posting as that token's bot.
- **Reviews:** used when no personal access token is pasted.
- **git over HTTPS:** clones and pushes for those repos.

GitLab access tokens last 2 hours. Relay renews them in the background.

## Notion

1. Open <https://www.notion.so/profile/integrations> and create a new integration of type **Public**.
2. Fill in the required fields: name, website, privacy and terms links. For a team tool, your company's pages will do.
3. **Redirect URI:** `http://127.0.0.1:3000/api/oauth/notion/callback`.

   If Notion refuses that address, use `http://localhost:3000/api/oauth/notion/callback` instead, and also set it in
   `.env`:

   ```sh
   NOTION_OAUTH_REDIRECT_URI=http://localhost:3000/api/oauth/notion/callback
   ```

4. Copy the **OAuth client ID** and **OAuth client secret** into `.env`:

   ```sh
   NOTION_OAUTH_CLIENT_ID=…
   NOTION_OAUTH_CLIENT_SECRET=…
   ```

Notion requires the client secret when it hands out a token, so the secret has to sit in each person's `.env`. Share
it only with your team, and never commit it.

In Relay, press **Connect with Notion**. On Notion's page, tick the databases Relay may read. Back in Relay, press
**Set up Notion** (or open `/setup/notion`): the setup walks through the board, its columns, how each status counts,
and your Notion user id, then saves.

**Advanced mode** (the switch on the Notion card) is the by-hand way: an internal integration token, and the mapping
typed in. Only one way is used at a time. The other one is kept (the sign-in stays signed in, the token stays stored)
but ignored until you switch back.

## What stays manual

- **Figma:** needs no login. It uses the bridge plugin in the Figma desktop app.
- **Web Push and ntfy:** these are not sign-ins (see [Reference](REFERENCE.md#web-push-vapid)).
- **GitLab webhooks** still need a public URL (ngrok).
- **Postrack** (company edition) has its own Connect button already.
