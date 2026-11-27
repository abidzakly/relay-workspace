# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

One developer who lives in GitLab, working on their own machine. Teams adopt Relay one person at a time; an edition
preset only sets a team's defaults. The person moves between merge requests, reviews, releases, Notion task cards,
coding-agent sessions and a test device in one working day.

## Product Purpose

Relay gathers merge requests, the reviews people wait on, the release flow and (optionally) Notion task cards into one
calm page that runs locally. Success is the developer knowing what needs them next and acting on it without switching
between GitLab, Notion, terminals and devices.

## Positioning

Everything runs on the developer's own computer: no hosted service, no accounts, tokens never leave the machine except to
talk to services the person connected. Agents work on the person's real repos and worktrees, next to the MRs and cards
they belong to.

## Operating Context

- Desktop for deep work (diff reading, reviewing, long agent sessions).
- Phone, equally often, as a remote for the Mac: checking agents, approving plans, answering questions, away from the
  desk. Sessions keep running when the page closes or the phone locks.
- Cockpit: Claude and Cursor agent sessions (plan first, then work), shells, a run view for the app, files and turn
  review, per workspace and per worktree made for a card.
- Writes to GitLab, Notion or Drive need confirmation and land in the audit log; dry-run is on at first start.

## Capabilities and Constraints

- Web app (React, Vite, Tailwind v4) served from a local Node server on `127.0.0.1`.
- UI text in English and Bahasa Indonesia (react-i18next, `apps/web/src/i18n`); English is the source locale.
- Every feature can be switched off.
- Two editions of the same app exist (personal and company); they share the web UI.

## Brand Commitments

- Name: Relay.
- Voice: calm, plain, specific. Says what changes for the person; no hype.

## Product Principles

1. Show what needs the person first; everything else waits quietly.
2. Nothing changes without the person's approval (plan first, confirm writes, undo where possible).
3. Local and private by default.
4. One place for the day's work, on desk and on phone.
