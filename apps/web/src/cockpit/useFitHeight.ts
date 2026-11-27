import { useLayoutEffect, useState } from 'react';

/** Room kept under the Cockpit when the window scrolls (Classic): the floating Wake / Dream pill rests there. */
const PILL_ROOM = 72;
const MIN_HEIGHT = 420;

function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const y = getComputedStyle(p).overflowY;
    if (y === 'auto' || y === 'scroll') return p;
  }
  return null;
}

/**
 * The Cockpit fills the height it is given, wherever it is shown: the Classic page (the window scrolls, the theme
 * pill floats under it) or a Living Workspace panel (its own scrolling main with bottom padding). Measured on mount
 * and on resize; until then the caller's CSS height applies.
 */
export function useFitHeight<T extends HTMLElement>() {
  // A callback ref: the Cockpit shows a spinner first, so the element arrives after mount.
  const [el, ref] = useState<T | null>(null);
  const [height, setHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!el) return;
    const measure = () => {
      const parent = scrollParent(el);
      let room: number;
      if (parent) {
        const box = parent.getBoundingClientRect();
        const top = el.getBoundingClientRect().top - box.top + parent.scrollTop;
        room = parent.clientHeight - top - parseFloat(getComputedStyle(parent).paddingBottom);
      } else {
        const top = el.getBoundingClientRect().top + window.scrollY;
        room = window.innerHeight - top - PILL_ROOM;
      }
      setHeight(Math.max(MIN_HEIGHT, Math.floor(room)));
    };
    measure();
    // A Living Workspace panel grows in with a scale: measure again once it has settled.
    const settled = window.setTimeout(measure, 450);
    window.addEventListener('resize', measure);
    return () => {
      window.clearTimeout(settled);
      window.removeEventListener('resize', measure);
    };
  }, [el]);
  return { ref, height };
}
