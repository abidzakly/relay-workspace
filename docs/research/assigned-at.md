# Research: deriving "Assigned At" from a Notion card's Updates history

**Result: not feasible with the Notion integration API. Research stopped; nothing was built.**

## Can the app read the Updates (edit history) tab?

No. The public Notion API (latest 2026-03-11, the app uses 2025-09-03) has no endpoint for page history, page
activity, page versions or property history. "Retrieve a page" and "Retrieve a page property item" return current
values only. Source: the endpoint index at https://developers.notion.com/llms.txt.

## Alternatives checked

| Path                                                  | Why it does not give "Assigned At"                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `page.properties_updated` webhook                     | Payload has `authors`, `timestamp` and the **ids** of changed properties only: no old/new values. Forward-only (no backfill), aggregated, may arrive out of order. It can never recover when someone was assigned in the past. https://developers.notion.com/reference/webhooks/page-properties-updated.md |
| Enterprise audit log                                  | Enterprise plan, organization owners only. No query API (CSV export or SIEM stream), 365-day retention, and "Page property edited" does not record which property or which values. https://www.notion.com/help/audit-log                                                                                   |
| Page version history                                  | UI only, no API; retention 7 / 30 / 90 days on Free / Plus / Business. https://www.notion.com/help/duplicate-delete-and-restore-content                                                                                                                                                                    |
| Notion's internal web API (`token_v2` session cookie) | Undocumented, unofficial, breaks without notice, outside the integration model. Not pursued, as instructed (no workarounds).                                                                                                                                                                               |

## Consequence

No "assigned" rule is defined. The existing sources stay as they are (PLAN §12): `firstSeen` (accurate from the
first sync onward, `created_time` + "approx" for older cards), the optional Notion "Assigned at" date property
(`sla.assignedAtSource: property`), and the per-card manual override.
