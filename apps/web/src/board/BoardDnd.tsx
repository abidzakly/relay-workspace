import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ConfirmWriteDialog } from '@/components/ConfirmWriteDialog';
import type { WriteRequest } from '@/lib/cardApi';
import { cn } from '@/lib/utils';

/**
 * Drag a Board card to another column, the dashboard-qa kanban behaviour on this app's rules:
 * a drop opens the SAME confirmation as "Move to…" (preview, dry-run, audit, undo). The card waits in the target
 * column, marked "Moving…", until the write is confirmed; cancelling or a refusal puts it back. Pointer (6 px),
 * touch (hold 180 ms) and keyboard (Space on the focused card, arrows, Space) all work.
 */

export interface PendingMove {
  cardId: string;
  /** The Notion status it goes to (configured spelling). */
  to: string;
  /** The board column it shows in meanwhile. */
  column: string;
}

export function BoardDnd({
  children,
  statusForColumn,
  currentStatus,
  overlay,
  pending,
  onPending,
}: {
  children: ReactNode;
  /** The configured status a column stands for; null = not a drop target. */
  statusForColumn: (column: string) => string | null;
  /** A card's status in the latest data, to know when a confirmed move has landed. */
  currentStatus: (cardId: string) => string | null;
  overlay: (cardId: string) => ReactNode;
  pending: PendingMove | null;
  onPending: (p: PendingMove | null) => void;
}) {
  const [active, setActive] = useState<string | null>(null);
  const [request, setRequest] = useState<WriteRequest | null>(null);
  const [applied, setApplied] = useState(false);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 6 } }),
    useSensor(KeyboardSensor),
  );

  // A confirmed move stays put until the data shows it (or 5 s pass), so the card does not flick back.
  useEffect(() => {
    if (!pending || !applied) return;
    const norm = (s: string | null) => (s ?? '').trim().toLowerCase();
    if (norm(currentStatus(pending.cardId)) === norm(pending.to)) {
      onPending(null);
      setApplied(false);
      return;
    }
    const t = setTimeout(() => {
      onPending(null);
      setApplied(false);
    }, 5_000);
    return () => clearTimeout(t);
  }, [pending, applied, currentStatus, onPending]);

  const onStart = (e: DragStartEvent) => setActive(String(e.active.id));
  const onEnd = (e: DragEndEvent) => {
    setActive(null);
    const cardId = String(e.active.id);
    const column = e.over ? String(e.over.id) : null;
    const from = e.active.data.current?.column as string | undefined;
    if (!column || column === from) return;
    const to = statusForColumn(column);
    if (!to) return;
    setApplied(false);
    onPending({ cardId, to, column });
    setRequest({ kind: 'status', cardId, to });
  };

  return (
    <DndContext
      sensors={sensors}
      onDragStart={onStart}
      onDragEnd={onEnd}
      onDragCancel={() => setActive(null)}
    >
      {children}
      {/* No drop animation: the card lands where it was let go (a calm, confirm-first move). */}
      <DragOverlay dropAnimation={null}>
        {active ? (
          <div className="pointer-events-none w-72 rounded-lg shadow-lift">{overlay(active)}</div>
        ) : null}
      </DragOverlay>
      <ConfirmWriteDialog
        request={request}
        onApplied={() => setApplied(true)}
        onClose={() => {
          setRequest(null);
          if (!applied) onPending(null);
        }}
      />
    </DndContext>
  );
}

export function DropColumn({
  name,
  enabled,
  className,
  children,
  ...rest
}: {
  name: string;
  enabled: boolean;
  className?: string;
  children: ReactNode;
} & Omit<React.HTMLAttributes<HTMLElement>, 'className' | 'children'>) {
  const { isOver, setNodeRef } = useDroppable({ id: name, disabled: !enabled });
  return (
    <section
      ref={setNodeRef}
      className={cn(className, 'transition-colors', isOver && 'bg-accent ring-2 ring-primary/50')}
      {...rest}
    >
      {children}
    </section>
  );
}

export function DragTile({
  cardId,
  column,
  moving,
  children,
}: {
  cardId: string;
  column: string;
  moving: boolean;
  children: ReactNode;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: cardId,
    data: { column },
  });
  // Space/Enter start a keyboard drag only on the card itself, never from a link or button inside it.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) listeners?.onKeyDown?.(e);
  };
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onKeyDown={onKeyDown}
      aria-roledescription="draggable card"
      className={cn(
        'relative rounded-lg focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
        isDragging && 'opacity-40',
        moving && 'opacity-70',
      )}
    >
      {moving && (
        <span className="absolute -top-2 right-2 z-10 rounded-control border bg-background px-1.5 py-0.5 text-xs text-muted-foreground">
          Moving…
        </span>
      )}
      {children}
    </div>
  );
}
