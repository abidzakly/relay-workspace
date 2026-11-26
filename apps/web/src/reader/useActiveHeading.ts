import { useEffect, useState } from 'react';
import type { Heading } from './ReaderBody';

/**
 * The heading the reader is in: the last one whose top has passed a line a quarter of the way down the window.
 * Driven by an IntersectionObserver, so scrolling stays cheap; it only re-reads positions when a heading crosses.
 */
export function useActiveHeading(headings: Heading[]): string | null {
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    const els = headings
      .map((h) => document.getElementById(h.id))
      .filter((el): el is HTMLElement => el !== null);
    if (els.length === 0) {
      setActive(null);
      return;
    }
    const pick = () => {
      const line = window.innerHeight * 0.25;
      let current: string | null = null;
      for (const el of els) {
        if (el.getBoundingClientRect().top <= line) current = el.id;
        else break;
      }
      setActive(current ?? els[0]!.id);
    };
    const io = new IntersectionObserver(pick, { rootMargin: '0px 0px -75% 0px' });
    for (const el of els) io.observe(el);
    pick();
    return () => io.disconnect();
  }, [headings]);

  return active;
}
