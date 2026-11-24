import type { OAuthConnection } from '@relay/shared';
import type { ConfigStore } from '../../config/store';
import { reviewerIdentity, setReviewerIdentity } from '../reviewTarget';

/**
 * After a GitLab sign-in (or sign-out): Reviews and the "is this mine?" checks learn who the signed-in user is, for
 * what runs on the sign-in (Reviews without a pasted token, repos without a project token). A pasted token keeps its
 * own identity.
 */
export function syncGitlabSignIn(store: ConfigStore, c: OAuthConnection): void {
  const pastedReviewer = !!store.getPastedReviewerToken();
  const username = c.connected ? c.account : null;
  if (!pastedReviewer) {
    const current = reviewerIdentity(store);
    if (username)
      setReviewerIdentity(store, { username, name: null, scopes: ['api'], expiresAt: null });
    else if (current) setReviewerIdentity(store, undefined);
  }
  for (const repo of store.listRepos()) {
    if (repo.gitlab.tokenSet) continue;
    store.setTokenUser(repo.id, username);
  }
}
