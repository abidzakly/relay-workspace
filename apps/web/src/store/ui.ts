import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Theme = 'light' | 'dark' | 'system';
/** S = ring ship (default), A = ring pipeline gimbal, B = block-built sphere gimbal. */
export type CoreMode = 'S' | 'A' | 'B';
/** Current release cycle (default) vs all-time progress. */
export type CoreScope = 'cycle' | 'all';
/** Off / full scene / text ring only (default). */
export type AsciiMode = 'off' | 'full' | 'text';
export type AsciiTone = 'dull' | 'color';
/** Frames per second for the 3D core. 0 = no cap. */
export type CoreFpsCap = 0 | 30 | 60;
/** `current` follows the calendar; `all` = no month filter; else a fixed `YYYY-MM` (the card's KPI month). */
export type CardMonth = 'current' | 'all' | `${number}-${number}`;
/** `scene` = the 3D Living Workspace is the landing page (default); `classic` = sidebar layout with Overview at `/`. */
export type HomeMode = 'scene' | 'classic';
/** Pages with a visual of their own (design system: Page visuals). Release and Builds hold their start gestures. */
export const VISUAL_PAGES = ['builds', 'release', 'sync', 'board'] as const;
export type VisualPage = (typeof VISUAL_PAGES)[number];

interface UiState {
  theme: Theme;
  mode3d: CoreMode;
  scope: CoreScope;
  ascii: AsciiMode;
  asciiTone: AsciiTone;
  fpsCap: CoreFpsCap;
  cardMonth: CardMonth;
  homeMode: HomeMode;
  /** The Living Workspace avatar's body colour; null = the model's own. */
  avatarColor: string | null;
  /** Reward sounds. Off by default (design system: Sound and haptics). */
  soundOn: boolean;
  /** Best-effort vibration on rewards, where the device has it. */
  hapticsOn: boolean;
  /** Each page's visual, on or off. */
  visuals: Record<VisualPage, boolean>;
  /** The one switch for every page's visual except Release and Builds. */
  otherVisuals: boolean;
  /** Settings sections the user folded, by section id. Missing means open. */
  settingsCollapsed: Record<string, boolean>;
  /** Setup checklist items the user chose to stop seeing, by item id. */
  setupIgnored: string[];
  setTheme: (v: Theme) => void;
  setMode3d: (v: CoreMode) => void;
  setScope: (v: CoreScope) => void;
  setAscii: (v: AsciiMode) => void;
  setAsciiTone: (v: AsciiTone) => void;
  setFpsCap: (v: CoreFpsCap) => void;
  setCardMonth: (v: CardMonth) => void;
  setHomeMode: (v: HomeMode) => void;
  setAvatarColor: (v: string | null) => void;
  setSoundOn: (v: boolean) => void;
  setHapticsOn: (v: boolean) => void;
  setVisual: (page: VisualPage, on: boolean) => void;
  setOtherVisuals: (v: boolean) => void;
  setSettingsCollapsed: (ids: string[], collapsed: boolean) => void;
  setSetupIgnored: (ids: string[], ignored: boolean) => void;
}

const ALL_VISUALS: Record<VisualPage, boolean> = {
  builds: true,
  release: true,
  sync: true,
  board: true,
};

export const UI_STORAGE_KEY = 'core-ui';

/** UI preferences only. Persisted in localStorage under `core-ui`; never holds secrets. */
export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      theme: 'system',
      mode3d: 'S',
      scope: 'cycle',
      ascii: 'text',
      asciiTone: 'color',
      fpsCap: 0,
      cardMonth: 'current',
      homeMode: 'scene',
      avatarColor: null,
      soundOn: false,
      hapticsOn: true,
      visuals: ALL_VISUALS,
      otherVisuals: true,
      settingsCollapsed: {},
      setupIgnored: [],
      setTheme: (theme) => set({ theme }),
      setMode3d: (mode3d) => set({ mode3d }),
      setScope: (scope) => set({ scope }),
      setAscii: (ascii) => set({ ascii }),
      setAsciiTone: (asciiTone) => set({ asciiTone }),
      setFpsCap: (fpsCap) => set({ fpsCap }),
      setCardMonth: (cardMonth) => set({ cardMonth }),
      setHomeMode: (homeMode) => set({ homeMode }),
      setAvatarColor: (avatarColor) => set({ avatarColor }),
      setSoundOn: (soundOn) => set({ soundOn }),
      setHapticsOn: (hapticsOn) => set({ hapticsOn }),
      setVisual: (page, on) => set((s) => ({ visuals: { ...s.visuals, [page]: on } })),
      setOtherVisuals: (otherVisuals) => set({ otherVisuals }),
      setSettingsCollapsed: (ids, collapsed) =>
        set((s) => {
          const next = { ...s.settingsCollapsed };
          for (const id of ids) {
            if (collapsed) next[id] = true;
            else delete next[id];
          }
          return { settingsCollapsed: next };
        }),
      setSetupIgnored: (ids, ignored) =>
        set((s) => ({
          setupIgnored: ignored
            ? [...new Set([...s.setupIgnored, ...ids])]
            : s.setupIgnored.filter((id) => !ids.includes(id)),
        })),
    }),
    {
      name: UI_STORAGE_KEY,
      version: 4,
      // v2 added the Ship mode and made it the default; v3 added the Living Workspace landing.
      migrate: (persisted, version) => {
        let s = (persisted ?? {}) as Partial<UiState>;
        if (version < 2) s = { ...s, mode3d: 'S' };
        if (version < 3) s = { ...s, homeMode: 'scene' };
        // v4 added page visuals, all on.
        if (version < 4) s = { ...s, visuals: ALL_VISUALS, otherVisuals: true };
        return s as UiState;
      },
      partialize: (s) => ({
        theme: s.theme,
        mode3d: s.mode3d,
        scope: s.scope,
        ascii: s.ascii,
        asciiTone: s.asciiTone,
        fpsCap: s.fpsCap,
        cardMonth: s.cardMonth,
        homeMode: s.homeMode,
        avatarColor: s.avatarColor,
        soundOn: s.soundOn,
        hapticsOn: s.hapticsOn,
        visuals: s.visuals,
        otherVisuals: s.otherVisuals,
        settingsCollapsed: s.settingsCollapsed,
        setupIgnored: s.setupIgnored,
      }),
    },
  ),
);

/** The order of the theme button and the `t` key. */
export function nextTheme(theme: Theme): Theme {
  return theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system';
}

export function resolveDark(theme: Theme): boolean {
  if (theme === 'dark') return true;
  if (theme === 'light') return false;
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
}
