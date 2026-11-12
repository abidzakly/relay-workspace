import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/** The design tokens of `index.css`. Unlisted, `text-micro` would count as a colour and be dropped beside `text-foreground`. */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ['micro', '2xs'],
      radius: ['control', 'surface', 'sheet'],
      shadow: ['rest', 'lift', 'float', 'glow'],
      font: ['accent'],
      ease: ['press', 'settle', 'wobble'],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** `href` for an external link: http(s) only (a stored/remote URL must never become a `javascript:` link). */
export function safeHref(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : undefined;
  } catch {
    return undefined;
  }
}
