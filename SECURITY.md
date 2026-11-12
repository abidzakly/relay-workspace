# Security policy

## Reporting a problem

Please do not open a public issue for a security problem. Report it privately through GitHub: on the repository page, open **Security > Report a vulnerability**. Say what you found, how to reproduce it, and what an attacker could do with it.

You will get an answer within a week. Once a fix is out, the report is credited in the release notes unless you ask otherwise.

## What Relay is built to protect

Relay runs on your own machine, for one person. It has no accounts and no server of its own.

- The dashboard listens on `127.0.0.1` only and refuses any other bind address. It checks the `Host` and `Origin` headers, and every write needs a custom CSRF header.
- The webhook listener is the only part meant to be reachable from the internet, through a tunnel you choose. It answers `POST /webhook/<repo-id>` only, and each delivery must carry that repo's secret.
- Tokens and secrets are encrypted at rest with a key derived from `MASTER_KEY` in `.env`. Anyone who has both `.env` and `data/app.db` can read them, so keep `.env` private (`chmod 600 .env`) and out of backups.
- Writes to GitLab, Notion and Google Drive always need your confirmation and are written to the audit log. Dry-run is on at first start.

The full checklist, with the accepted risks, is in [docs/SECURITY.md](docs/SECURITY.md).
