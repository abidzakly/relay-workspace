import { create } from 'zustand';

interface PaletteState {
  paletteOpen: boolean;
  helpOpen: boolean;
  setPaletteOpen: (v: boolean) => void;
  setHelpOpen: (v: boolean) => void;
}

/** Which command overlay is open. Session only, unlike the preferences in `store/ui.ts`. */
export const usePaletteStore = create<PaletteState>()((set) => ({
  paletteOpen: false,
  helpOpen: false,
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  setHelpOpen: (helpOpen) => set({ helpOpen }),
}));
