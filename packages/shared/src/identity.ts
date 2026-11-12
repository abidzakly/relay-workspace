/**
 * Who counts as "me" on GitLab: `gitlab.myUsername`, plus the bot user behind each repo's access token
 * (`project_409_bot_<hash>`, `group_12_bot_<hash>`). A note posted with the dashboard's token is mine, even though
 * GitLab shows the bot as its author. Other bots in the same project are not: each token has its own bot user.
 */
export const TOKEN_BOT_RE = /^(project|group)_\d+_bot(_[0-9a-f]+)?$/i;

export function isTokenBot(username: string): boolean {
  return TOKEN_BOT_RE.test(username);
}

/** `mine` = my GitLab username and my tokens' usernames, any case. */
export function isMyUser(user: string | null | undefined, mine: readonly string[]): boolean {
  if (!user) return false;
  const u = user.toLowerCase();
  return mine.some((m) => m.toLowerCase() === u);
}

/** The usernames that are "me", deduplicated, lowercased. Empty entries are dropped. */
export function myUsernames(
  myUsername: string | null | undefined,
  tokenUsers: Iterable<string>,
): string[] {
  const out = new Set<string>();
  if (myUsername) out.add(myUsername.toLowerCase());
  for (const t of tokenUsers) if (t) out.add(t.toLowerCase());
  return [...out];
}
