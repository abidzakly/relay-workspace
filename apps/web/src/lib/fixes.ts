import type { Fix } from '@relay/shared';

/** Label of a one-click fix. */
export function fixLabel(f: Fix): string {
  switch (f.type) {
    case 'set_card_status':
      return `→ ${f.to}`;
    case 'start_release':
      return 'Update version';
    case 'build_and_share':
      return 'Open Builds';
    case 'open_linker':
      return 'Open linker';
    case 'set_parent':
      return 'Set parent';
    case 'link_child':
      return 'Link child';
    case 'add_notion_link_to_mr':
      return 'Add link to MR description';
    case 'rename_mr_title':
      return 'Rename MR title to branch';
  }
}

/** Only card status fixes can be executed in this version (the server enforces the same, `fix_unsupported`). */
export function fixExecutable(f: Fix): boolean {
  return f.type === 'set_card_status';
}

/**
 * A fix that only takes the user somewhere, and starts nothing. `start_release` opens the Release: a release needs
 * its own mode, preview and confirmation there. `build_and_share` opens Builds with the repo chosen, which also says when
 * a stopped release should be resumed instead.
 */
export function fixRoute(f: Fix): string | null {
  if (f.type === 'start_release') return `/release?repo=${encodeURIComponent(f.repoId)}`;
  if (f.type === 'build_and_share') return `/builds?repo=${encodeURIComponent(f.repoId)}`;
  return null;
}

export function fixRouteHint(f: Fix): string {
  return f.type === 'build_and_share'
    ? 'Open Builds for this repo. Nothing starts by itself.'
    : 'Open the Release for this repo. Nothing starts by itself.';
}

export function fixUnavailableReason(f: Fix): string {
  switch (f.type) {
    case 'start_release':
    case 'build_and_share':
      return '';
    case 'open_linker':
    case 'set_parent':
    case 'link_child':
      return 'Linking and parent changes arrive in a later part';
    case 'add_notion_link_to_mr':
    case 'rename_mr_title':
      return 'MR description / title edits arrive in a later part';
    case 'set_card_status':
      return '';
  }
}
