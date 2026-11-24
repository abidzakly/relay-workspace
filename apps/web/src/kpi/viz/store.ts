import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { SlaState } from '@relay/shared';
import type { SkyTheme } from '../sky/model';

/** What the SLA table is narrowed to by a click on a chart. Not persisted: a filter is for this visit. */
export interface SlaFilter {
  type?: string;
  states?: readonly SlaState[];
  cardId?: string;
  /** Said in the "Showing …" chip. */
  label: string;
}

interface KpiViewState {
  theme: SkyTheme;
  /** Sections whose table the user opened, by id. Missing means folded. */
  open: Record<string, boolean>;
  filter: SlaFilter | null;
  setTheme: (t: SkyTheme) => void;
  setOpen: (id: string, open: boolean) => void;
  setFilter: (f: SlaFilter | null) => void;
}

/** KPI page view preferences. Browser-local, under `relay-kpi-view`; never holds data. */
export const useKpiView = create<KpiViewState>()(
  persist(
    (set) => ({
      theme: 'pool',
      open: {},
      filter: null,
      setTheme: (theme) => set({ theme }),
      setOpen: (id, open) => set((s) => ({ open: { ...s.open, [id]: open } })),
      setFilter: (filter) =>
        set((s) => (filter ? { filter, open: { ...s.open, 'sla-table': true } } : { filter })),
    }),
    {
      name: 'relay-kpi-view',
      version: 1,
      partialize: (s) => ({ theme: s.theme, open: s.open }),
    },
  ),
);

/** Scrolls a section into view, honouring reduced motion. */
export function scrollToSection(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
}
