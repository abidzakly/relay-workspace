import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** The services a Settings section can wear the colours of. Each one sets `--brand` through `[data-brand]`. */
export type BrandId = 'notion' | 'google' | 'gitlab' | 'ai';

/** Google's G as four arcs (blue with its bar, green, yellow, red), so the chip can colour each one. */
const GOOGLE_ARCS = [
  'M12 12h8M20 12a8 8 0 0 1-2.86 6.13',
  'M17.14 18.13a8 8 0 0 1-11.27-.99',
  'M5.87 17.14a8 8 0 0 1-.42-9.73',
  'M5.45 7.41a8 8 0 0 1 12.21-1.07',
];
const GOOGLE_COLOURS = ['#4285f4', '#34a853', '#fbbc04', '#ea4335'];

/** Drawn on a 24-unit grid. Single-colour marks use `currentColor`, so the chip and the watermark share them. */
const MARKS: Record<BrandId, ReactNode> = {
  notion: (
    <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
      <rect x="3.5" y="3.5" width="17" height="17" rx="3" />
      <path d="M8.5 16.5v-9l7 9v-9" strokeLinecap="round" />
    </g>
  ),
  gitlab: <path fill="currentColor" d="M12 21.5 22 13.9 19.4 3.2 16.6 10H7.4L4.6 3.2 2 13.9Z" />,
  google: (
    <g fill="none" stroke="currentColor" strokeWidth="3.2">
      {GOOGLE_ARCS.map((d) => (
        <path key={d} d={d} />
      ))}
    </g>
  ),
  ai: (
    <path
      fill="currentColor"
      d="M12 2.5c.6 5.5 4 8.9 9.5 9.5-5.5.6-8.9 4-9.5 9.5-.6-5.5-4-8.9-9.5-9.5 5.5-.6 8.9-4 9.5-9.5Z"
    />
  ),
};

/** Google's G keeps its four colours on the chip; everywhere else a mark is one colour. */
function GoogleColour() {
  return (
    <g fill="none" strokeWidth="3.2">
      {GOOGLE_ARCS.map((d, i) => (
        <path key={d} d={d} stroke={GOOGLE_COLOURS[i]} />
      ))}
    </g>
  );
}

/** The small mark beside a section's title, on a tinted chip. */
export function BrandLogo({ brand, className }: { brand: BrandId; className?: string }) {
  return (
    <span aria-hidden className={cn('brand-chip', className)}>
      <svg viewBox="0 0 24 24" className="size-[1.125rem]">
        {brand === 'google' ? <GoogleColour /> : MARKS[brand]}
      </svg>
    </span>
  );
}

/** The card's decoration: a brand-coloured edge and the mark as a large faded silhouette in the corner. */
export function BrandDecor({ brand }: { brand: BrandId }) {
  return (
    <span aria-hidden className="brand-decor">
      <svg viewBox="0 0 24 24" className="brand-watermark">
        {MARKS[brand]}
      </svg>
    </span>
  );
}
