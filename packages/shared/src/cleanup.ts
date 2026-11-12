/**
 * Storage cleanup (no AI): every candidate comes from a fixed rule over facts the dashboard already has (card status,
 * MR state, finding status, git ancestry, file age). `safe` items are pure leftovers and may be cleaned
 * automatically; `confirm` items (local branches, APKs, clones) are only removed when the user ticks them.
 */
export const CLEANUP_CATEGORIES = [
  'attachments',
  'checkpoints',
  'branches',
  'git',
  'clone-builds',
  'clones',
  'apks',
  'evidence',
  'figma',
  'scrcpy',
  'temp',
  'worktrees',
] as const;
export type CleanupCategory = (typeof CLEANUP_CATEGORIES)[number];

export type CleanupTier = 'safe' | 'confirm';

export interface CleanupCandidate {
  /** Stable while the item is unchanged: a re-scan at apply time must produce the same id. */
  id: string;
  category: CleanupCategory;
  tier: CleanupTier;
  /** What it is: a folder, a branch, a file. */
  label: string;
  /** Which rule matched, in words. */
  reason: string;
  /** null = unknown (git objects, remote refs). */
  bytes: number | null;
  /** Workspace name, repo id or "Mac temp dir". */
  where: string;
}

export interface CleanupScan {
  candidates: CleanupCandidate[];
  /** Places that were not scanned and why (an agent running, the host agent down…). */
  skipped: { where: string; reason: string }[];
  scannedAt: number;
}

export interface CleanupResult {
  removed: { id: string; label: string; bytes: number | null }[];
  failed: { id: string; label: string; reason: string }[];
  /** Asked for but no longer matching a rule at delete time (state changed): kept. */
  kept: string[];
  bytesFreed: number;
  at: number;
  auto: boolean;
}
