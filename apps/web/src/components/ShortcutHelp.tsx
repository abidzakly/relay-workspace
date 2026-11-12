import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useEnabledNav } from '@/lib/features';
import { PALETTE_KEY_LABEL, IS_MAC } from '@/lib/shortcuts';
import { usePaletteStore } from '@/store/palette';
import { useUiStore } from '@/store/ui';

const GENERAL: { keys: string[]; label: string }[] = [
  {
    keys: IS_MAC ? [PALETTE_KEY_LABEL, 'Ctrl+K'] : [PALETTE_KEY_LABEL],
    label: 'Command palette',
  },
  { keys: ['?'], label: 'This help' },
  { keys: ['r'], label: 'Refresh data from the server' },
  { keys: ['t'], label: 'Change theme (system, light, dark)' },
];

/** Keys of the Code Reviewer session (`review/ReviewWorkspace.tsx`). */
const REVIEW: { keys: string[]; label: string }[] = [
  { keys: ['j', 'k'], label: 'Next / previous file' },
  { keys: ['n', 'p'], label: 'Next / previous change' },
  { keys: [']', '['], label: 'Next / previous open comment' },
  { keys: ['s'], label: 'Inline or split view' },
  { keys: ['e'], label: 'Fold the current file' },
  { keys: ['v'], label: 'Mark the current file viewed' },
];

/** Keys of the Living Workspace (`workspace/WorkspaceShell.tsx`, `WorkspaceCanvas.tsx`). */
const WORKSPACE: { keys: string[]; label: string }[] = [
  { keys: ['←', '→', '↑', '↓'], label: 'Look around' },
  { keys: ['+', '-'], label: 'Zoom in / out' },
  { keys: ['0'], label: 'Reset the view' },
  { keys: ['Esc'], label: 'Close the page, back to the world' },
  { keys: ['f'], label: 'Full screen' },
];

export function Kbd({ children }: { children: string }) {
  return (
    <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
      {children}
    </kbd>
  );
}

function Row({ keys, label }: { keys: string[]; label: string }) {
  return (
    <li className="flex items-center justify-between gap-4 text-sm">
      <span>{label}</span>
      <span className="flex shrink-0 gap-1">
        {keys.map((key) => (
          <Kbd key={key}>{key}</Kbd>
        ))}
      </span>
    </li>
  );
}

/** Lists the keys of `lib/shortcuts.ts`. */
export function ShortcutHelp() {
  const open = usePaletteStore((s) => s.helpOpen);
  const setOpen = usePaletteStore((s) => s.setHelpOpen);
  const scene = useUiStore((s) => s.homeMode) === 'scene';
  const nav = useEnabledNav();
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent aria-describedby={undefined} className="max-h-[85dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
        </DialogHeader>
        <ul className="grid gap-2">
          {GENERAL.map((row) => (
            <Row key={row.label} {...row} />
          ))}
        </ul>
        <section className="grid gap-2">
          <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Go to
          </h3>
          <ul className="grid gap-2">
            {nav
              .filter((item) => scene || !item.sceneOnly)
              .map((item) => (
                <Row key={item.to} keys={[`g ${item.chord}`]} label={item.label} />
              ))}
          </ul>
        </section>
        {scene && (
          <section className="grid gap-2">
            <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              In the Living Workspace
            </h3>
            <ul className="grid gap-2">
              {WORKSPACE.map((row) => (
                <Row key={row.label} {...row} />
              ))}
            </ul>
          </section>
        )}
        <section className="grid gap-2">
          <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            In a code review
          </h3>
          <ul className="grid gap-2">
            {REVIEW.map((row) => (
              <Row key={row.label} {...row} />
            ))}
          </ul>
        </section>
        <p className="text-xs text-muted-foreground">
          Shortcuts stay quiet while you type in a field or the terminal panel, and while a dialog
          is open. In the palette, use the arrow keys and Enter. Writes to Notion or GitLab always
          stop at their confirm dialog or form.
        </p>
      </DialogContent>
    </Dialog>
  );
}
