import {
  Check,
  FileText,
  GitMerge,
  GitPullRequest,
  Loader2,
  type LucideIcon,
  Search,
  Zap,
  Compass,
} from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router';
import { BULK_READY_MAX_CARDS } from '@relay/shared';
import { useAiCheckStore } from '@/components/AiCheck';
import { bulkReadyCandidates, buildBoard, columnFor, NO_FILTER } from '@/board/model';
import { BulkReadyDialog } from '@/components/BulkReadyDialog';
import { ConfirmWriteDialog } from '@/components/ConfirmWriteDialog';
import { useEnabledNav } from '@/lib/features';
import { Kbd, ShortcutHelp } from '@/components/ShortcutHelp';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { describeError } from '@/lib/api';
import { visibleCards } from '@/lib/cardScope';
import type { WriteRequest } from '@/lib/cardApi';
import { MR_OPEN_MERGE_STATE } from '@/lib/mrApi';
import { backLabel, reviewLink } from '@/lib/reviewApi';
import { rankItems, type PaletteItem, type PaletteKind } from '@/lib/palette';
import { useRepos, useSaveGlobal, useSettings } from '@/lib/settingsApi';
import { isPaletteKey, PALETTE_KEY_LABEL, refreshData, useGlobalShortcuts } from '@/lib/shortcuts';
import { useHealthReport, useStateSnapshot } from '@/lib/stateApi';
import { cn } from '@/lib/utils';
import { usePaletteStore } from '@/store/palette';
import { useUiStore, type AsciiMode, type CoreMode, type CoreScope, type Theme } from '@/store/ui';

const RESULT_LIMIT = 50;
const LIVE_MR_BOOST = 3;

const KIND: Record<PaletteKind, { tag: string; icon: LucideIcon }> = {
  view: { tag: 'View', icon: Compass },
  action: { tag: 'Action', icon: Zap },
  card: { tag: 'Card', icon: FileText },
  mr: { tag: 'MR', icon: GitPullRequest },
  write: { tag: 'Asks first', icon: GitMerge },
};

const THEMES: { value: Theme; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];
const MODES: { value: CoreMode; label: string }[] = [
  { value: 'S', label: 'Ship' },
  { value: 'A', label: 'Rings' },
  { value: 'B', label: 'Blocks' },
];
const SCOPES: { value: CoreScope; label: string }[] = [
  { value: 'cycle', label: 'Current release cycle' },
  { value: 'all', label: 'All-time' },
];
const ASCII: { value: AsciiMode; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'full', label: 'Full scene' },
  { value: 'text', label: 'Text ring' },
];

function item(
  fields: Pick<PaletteItem, 'id' | 'kind' | 'label' | 'run'> & Partial<PaletteItem>,
): PaletteItem {
  return {
    hint: '',
    keywords: '',
    searchOnly: false,
    boost: 0,
    current: false,
    shortcut: '',
    keepOpen: false,
    ...fields,
  };
}

interface WriteOpeners {
  confirmWrite: (request: WriteRequest) => void;
  bulkReady: (cardIds: string[]) => void;
}

/**
 * Mounted only while open, so the lists are read on demand. Nothing here writes to Notion or GitLab: the `write` items
 * open the normal confirm dialog or form. The one write is dry-run, a settings save through the audited route.
 */
function PaletteBody({ confirmWrite, bulkReady }: WriteOpeners) {
  const navigate = useNavigate();
  const close = () => usePaletteStore.getState().setPaletteOpen(false);
  const setHelpOpen = usePaletteStore((s) => s.setHelpOpen);
  const ui = useUiStore();
  const stateQ = useStateSnapshot();
  const healthQ = useHealthReport();
  const settingsQ = useSettings();
  const reposQ = useRepos();
  const save = useSaveGlobal();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const enterDown = useRef(false);
  const listId = useId();

  const dryRun = settingsQ.data?.dryRun;
  const readyStatus = settingsQ.data?.notion.readyStatus;
  const completeStatuses = settingsQ.data?.notion.statusGroups.complete;
  const saving = save.isPending;
  const saveDryRun = save.mutate;

  const nav = useEnabledNav();
  const items = useMemo(() => {
    // Only my cards, as on the Board. The month is not applied: a search should still find last month's card.
    const scopedState = stateQ.data
      ? { ...stateQ.data, cards: visibleCards(stateQ.data.cards, 'all') }
      : undefined;
    const out: PaletteItem[] = nav.map((nav) =>
      item({
        id: `view:${nav.to}`,
        kind: 'view',
        label: nav.label,
        keywords: 'go open view',
        shortcut: `g ${nav.chord}`,
        run: () => void navigate(nav.to),
      }),
    );

    out.push(
      item({
        id: 'refresh',
        kind: 'action',
        label: 'Refresh data',
        hint: 'Sync GitLab and Notion now',
        keywords: 'reload update sync',
        shortcut: 'r',
        run: refreshData,
      }),
    );
    out.push(
      item({
        id: 'ai-check',
        kind: 'action',
        label: 'Check AI connection',
        hint: 'Test Claude and Cursor now',
        keywords: 'ai claude cursor engine fallback limit status test',
        run: () => useAiCheckStore.getState().setOpen(true),
      }),
    );
    if (dryRun !== undefined) {
      const next = !dryRun;
      out.push(
        item({
          id: 'dry-run',
          kind: 'action',
          label: next ? 'Turn dry-run on' : 'Turn dry-run off (writes become real)',
          hint: saving ? 'Saving…' : `Dry-run is ${dryRun ? 'on' : 'off'}. Saved and audited`,
          keywords: 'dryrun safety simulate toggle settings',
          keepOpen: true,
          run: () => {
            if (!saving) saveDryRun({ patch: (s) => ({ ...s, dryRun: next }) });
          },
        }),
      );
    }

    const board =
      scopedState && healthQ.data
        ? buildBoard(scopedState, healthQ.data, readyStatus, completeStatuses)
        : null;
    const candidates = board
      ? bulkReadyCandidates(board, { repo: NO_FILTER, assignee: NO_FILTER, type: NO_FILTER })
      : [];
    if (candidates.length > 0) {
      const ids = candidates.slice(0, BULK_READY_MAX_CARDS);
      out.push(
        item({
          id: 'bulk-ready',
          kind: 'write',
          label: `Bulk Ready to Test (${ids.length})…`,
          hint: 'All Complete or merged cards',
          keywords: 'notion status move',
          run: () => bulkReady(ids),
        }),
      );
    }

    for (const { value, label } of THEMES) {
      out.push(
        item({
          id: `theme:${value}`,
          kind: 'action',
          label: `Theme: ${label}`,
          keywords: 'appearance color mode',
          current: ui.theme === value,
          run: () => ui.setTheme(value),
        }),
      );
    }
    for (const { value, label } of MODES) {
      out.push(
        item({
          id: `mode:${value}`,
          kind: 'action',
          label: `3D mode: ${label}`,
          keywords: `core mode ${value}`,
          current: ui.mode3d === value,
          run: () => ui.setMode3d(value),
        }),
      );
    }
    for (const { value, label } of SCOPES) {
      out.push(
        item({
          id: `scope:${value}`,
          kind: 'action',
          label: `3D scope: ${label}`,
          keywords: 'core progress',
          current: ui.scope === value,
          run: () => ui.setScope(value),
        }),
      );
    }
    for (const { value, label } of ASCII) {
      out.push(
        item({
          id: `ascii:${value}`,
          kind: 'action',
          label: `ASCII: ${label}`,
          keywords: 'core 3d rendering text',
          current: ui.ascii === value,
          run: () => ui.setAscii(value),
        }),
      );
    }
    out.push(
      item({
        id: 'help',
        kind: 'action',
        label: 'Keyboard shortcuts',
        keywords: 'help keys',
        shortcut: '?',
        run: () => setHelpOpen(true),
      }),
    );

    for (const repo of reposQ.data ?? []) {
      out.push(
        item({
          id: `release:${repo.id}`,
          kind: 'write',
          label: `Release ${repo.name}…`,
          hint: 'Opens the release form',
          keywords: `update version train ${repo.id}`,
          searchOnly: true,
          run: () => void navigate(`/release?repo=${encodeURIComponent(repo.id)}`),
        }),
      );
    }

    const repoName = new Map((reposQ.data ?? []).map((r) => [r.id, r.name] as const));
    for (const card of scopedState?.cards ?? []) {
      if (card.archived) continue;
      const details = [card.status ?? 'no status', card.type].filter(Boolean).join(' · ');
      const keywords = [card.branchName, ...card.assignees].filter(Boolean).join(' ');
      out.push(
        item({
          id: `card:${card.id}`,
          kind: 'card',
          label: card.title,
          hint: details,
          keywords,
          searchOnly: true,
          run: () => void navigate(`/board?card=${encodeURIComponent(card.id)}`),
        }),
      );
      if (readyStatus && columnFor(card, readyStatus, completeStatuses) === 'Complete') {
        out.push(
          item({
            id: `ready:${card.id}`,
            kind: 'write',
            label: `Move to ${readyStatus}…: ${card.title}`,
            hint: details,
            keywords,
            searchOnly: true,
            run: () => confirmWrite({ kind: 'status', cardId: card.id, to: readyStatus }),
          }),
        );
      }
    }

    for (const mr of stateQ.data?.mrs ?? []) {
      const path = `/mrs/${encodeURIComponent(mr.repoId)}/${mr.iid}`;
      const repo = repoName.get(mr.repoId) ?? mr.repoId;
      const keywords = [mr.sourceBranch, mr.author, mr.repoId].filter(Boolean).join(' ');
      const live = mr.state === 'opened';
      out.push(
        item({
          id: `mr:${mr.repoId}:${mr.iid}`,
          kind: 'mr',
          label: `!${mr.iid} ${mr.title}`,
          hint: `${repo} · ${mr.state}${mr.draft ? ' · draft' : ''}`,
          keywords,
          searchOnly: true,
          boost: live ? LIVE_MR_BOOST : 0,
          run: () => void navigate(path),
        }),
      );
      if (live) {
        out.push(
          item({
            id: `review:${mr.repoId}:${mr.iid}`,
            kind: 'mr',
            label: `Review !${mr.iid}: ${mr.title}`,
            hint: `${repo}. Opens the Code Reviewer`,
            keywords,
            searchOnly: true,
            run: () => {
              // Back from the review returns to wherever the palette was opened.
              const { to, state } = reviewLink(
                mr.repoId,
                mr.iid,
                `${location.pathname}${location.search}`,
                backLabel(location.pathname),
              );
              void navigate(to, { state });
            },
          }),
        );
      }
      if (live && !mr.draft) {
        out.push(
          item({
            id: `merge:${mr.repoId}:${mr.iid}`,
            kind: 'write',
            label: `Merge !${mr.iid}…: ${mr.title}`,
            hint: `${repo}. Opens the merge dialog`,
            keywords,
            searchOnly: true,
            run: () => void navigate(path, { state: MR_OPEN_MERGE_STATE }),
          }),
        );
      }
    }
    return out;
  }, [
    nav,
    navigate,
    dryRun,
    saving,
    saveDryRun,
    readyStatus,
    completeStatuses,
    stateQ.data,
    healthQ.data,
    reposQ.data,
    ui,
    setHelpOpen,
    confirmWrite,
    bulkReady,
  ]);

  const results = useMemo(() => rankItems(items, query, RESULT_LIMIT), [items, query]);
  const activeIndex = Math.min(active, results.length - 1);
  const activeId = activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined;

  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView({ block: 'nearest' });
  }, [activeId]);

  const run = (picked: PaletteItem | undefined) => {
    if (!picked) return;
    picked.run();
    if (!picked.keepOpen) close();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (isPaletteKey(e.nativeEvent)) {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (results.length === 0) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((activeIndex + step + results.length) % results.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (!e.repeat) enterDown.current = true;
    }
  };

  // Runs on release: a held Enter must not carry into the dialog this may open.
  const onKeyUp = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || !enterDown.current) return;
    enterDown.current = false;
    run(results[activeIndex]);
  };

  const listError = stateQ.error ?? reposQ.error;

  return (
    <DialogContent className="top-[12vh] flex max-h-[76vh] w-[calc(100%-2rem)] max-w-xl translate-y-0 flex-col gap-0 overflow-hidden p-0">
      <DialogTitle className="sr-only">Command palette</DialogTitle>
      <DialogDescription className="sr-only">
        Search views, cards and merge requests, or run an action. Arrow keys choose, Enter runs.
      </DialogDescription>
      <div className="flex items-center gap-2 border-b px-3 pr-10">
        <Search className="size-4 shrink-0 text-muted-foreground" />
        <input
          role="combobox"
          aria-label="Search commands"
          aria-expanded
          aria-controls={listId}
          aria-activedescendant={activeId}
          aria-autocomplete="list"
          autoComplete="off"
          spellCheck={false}
          value={query}
          placeholder="Search cards, MRs, views and actions…"
          className="h-11 w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          onKeyUp={onKeyUp}
        />
      </div>
      <ul id={listId} role="listbox" aria-label="Results" className="min-h-0 overflow-y-auto p-1">
        {results.map((row, index) => {
          const { icon: Icon, tag } = KIND[row.kind];
          return (
            <li
              key={row.id}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === activeIndex}
              className={cn(
                'flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm',
                index === activeIndex && 'bg-accent text-accent-foreground',
              )}
              onMouseMove={() => setActive(index)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => run(row)}
            >
              <Icon className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{row.label}</span>
                {row.hint && (
                  <span className="block truncate text-xs text-muted-foreground">{row.hint}</span>
                )}
              </span>
              {row.current && <Check className="size-4 shrink-0" aria-label="current" />}
              {row.shortcut && <Kbd>{row.shortcut}</Kbd>}
              <span className="shrink-0 text-xs text-muted-foreground">{tag}</span>
            </li>
          );
        })}
        {results.length === 0 && (
          <li className="px-2 py-6 text-center text-sm text-muted-foreground">No matches.</li>
        )}
      </ul>
      <div className="grid gap-2 border-t px-3 py-2 text-xs text-muted-foreground empty:hidden">
        {save.isError && (
          <Alert variant="destructive">
            <AlertTitle>Dry-run was not changed</AlertTitle>
            <AlertDescription>{describeError(save.error)}</AlertDescription>
          </Alert>
        )}
        {stateQ.isPending && (
          <p className="flex items-center gap-2">
            <Loader2 className="size-3 motion-safe:animate-spin" /> Loading cards and MRs…
          </p>
        )}
        {listError && <p>Cards and MRs are unavailable: {describeError(listError)}</p>}
        {!query.trim() && stateQ.isSuccess && <p>Type to search cards and MRs.</p>}
      </div>
    </DialogContent>
  );
}

/** Opens the palette without a keyboard. */
export function CommandButton({ compact = false }: { compact?: boolean }) {
  const setOpen = usePaletteStore((s) => s.setPaletteOpen);
  if (compact) {
    return (
      <Button
        variant="ghost"
        size="icon"
        aria-label="Open command palette"
        title={`Search and commands (${PALETTE_KEY_LABEL})`}
        onClick={() => setOpen(true)}
      >
        <Search />
      </Button>
    );
  }
  return (
    <Button
      variant="outline"
      size="sm"
      className="w-full justify-between font-normal text-muted-foreground"
      onClick={() => setOpen(true)}
    >
      <span className="flex items-center gap-2">
        <Search /> Search
      </span>
      <Kbd>{PALETTE_KEY_LABEL}</Kbd>
    </Button>
  );
}

/**
 * Palette, help overlay and global keys (Extras). The confirm dialogs live here, outside the palette's body,
 * as they must outlast it: picking a write closes the palette and opens the dialog, and only the dialog can write.
 */
export function CommandPalette() {
  const open = usePaletteStore((s) => s.paletteOpen);
  const setOpen = usePaletteStore((s) => s.setPaletteOpen);
  const [request, setRequest] = useState<WriteRequest | null>(null);
  const [bulkIds, setBulkIds] = useState<string[] | null>(null);
  useGlobalShortcuts();

  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        {open && <PaletteBody confirmWrite={setRequest} bulkReady={setBulkIds} />}
      </Dialog>
      <ShortcutHelp />
      <ConfirmWriteDialog request={request} onClose={() => setRequest(null)} />
      <BulkReadyDialog cardIds={bulkIds} onClose={() => setBulkIds(null)} />
    </>
  );
}
