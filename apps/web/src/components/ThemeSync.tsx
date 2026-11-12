import { useEffect, useRef } from 'react';
import { inkBleed, rememberInkOrigin } from '@/lib/inkBleed';
import { skyPhase } from '@/lib/daypart';
import { useWallClock } from '@/lib/useWallClock';
import { resolveDark, UI_STORAGE_KEY, useUiStore } from '@/store/ui';

/** Keeps `<html class="dark" data-daypart>` in sync with the stored theme (and the OS when theme = system) and the clock. */
export function ThemeSync() {
  const theme = useUiStore((s) => s.theme);
  // The theme on screen. Null until the first paint, which is never animated.
  const shown = useRef<boolean | null>(null);
  useEffect(() => rememberInkOrigin(), []);
  useEffect(() => {
    const apply = () => {
      const dark = resolveDark(theme);
      if (shown.current === dark) return;
      const flip = () => document.documentElement.classList.toggle('dark', dark);
      // A change made in another tab arrives while this one is hidden; inkBleed flips it instantly.
      if (shown.current === null) flip();
      else inkBleed(flip);
      shown.current = dark;
    };
    apply();
    if (theme !== 'system') return;
    const mq = matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);
  // Same wall clock as the header and the world's daylight. Dev only: `?hour=21` previews a day part.
  const now = useWallClock();
  const previewHour = import.meta.env.DEV
    ? new URLSearchParams(window.location.search).get('hour')
    : null;
  const hour = previewHour ? Number(previewHour) : new Date(now).getHours();
  useEffect(() => {
    document.documentElement.dataset.daypart = skyPhase(hour);
  }, [hour]);
  // A change in another tab reaches this one too.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === UI_STORAGE_KEY) void useUiStore.persist.rehydrate();
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  return null;
}
