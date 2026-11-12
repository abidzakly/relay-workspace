/**
 * Version-update MR detection (boundary rule):
 * source branch = `<versionBranchPrefix><X.Y.Z…>` AND title === source branch (same rule as `vu`'s
 * resume check). Pure string logic: the prefix is validated by `isSafeBranchPrefix` in config, and is
 * compared with `startsWith`, never turned into a regex.
 */
const VERSION_REST_RE = /^\d{1,9}\.\d{1,9}\.\d{1,9}(?:[-+][0-9A-Za-z.+-]{0,60})?$/;

export function isVersionBranch(sourceBranch: string, versionBranchPrefix: string): boolean {
  if (versionBranchPrefix.length === 0 || !sourceBranch.startsWith(versionBranchPrefix)) {
    return false;
  }
  return VERSION_REST_RE.test(sourceBranch.slice(versionBranchPrefix.length));
}

export function isVersionMr(
  mr: { sourceBranch: string; title: string },
  versionBranchPrefix: string,
): boolean {
  return (
    mr.title.trim() === mr.sourceBranch && isVersionBranch(mr.sourceBranch, versionBranchPrefix)
  );
}
