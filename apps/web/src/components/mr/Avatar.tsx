import { useState } from 'react';
import { cn } from '@/lib/utils';

export function initials(name: string | null): string {
  if (!name) return '·';
  const parts = name.split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || name[0]!.toUpperCase();
}

/** A soft hue per author, so a long thread reads as a conversation at a glance. */
export function hue(name: string | null): number {
  let h = 0;
  for (const c of name ?? '') h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

/**
 * A person's GitLab avatar (same-origin proxy path from the server), or their initials on a soft per-person hue when
 * there is none or it fails to load. Decorative: the name is always written next to it.
 */
export function Avatar({
  name,
  src,
  size = 'md',
  className,
}: {
  name: string | null;
  src?: string | null | undefined;
  size?: 'sm' | 'md';
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const box = size === 'sm' ? 'size-6 text-micro' : 'size-8 text-xs';
  if (src && !failed) {
    return (
      <img
        src={src}
        alt=""
        aria-hidden
        loading="lazy"
        onError={() => setFailed(true)}
        className={cn(box, 'shrink-0 rounded-full bg-muted object-cover shadow-rest', className)}
      />
    );
  }
  return (
    <span
      aria-hidden
      className={cn(box, 'grid shrink-0 place-items-center rounded-full font-semibold', className)}
      // Same pair in Wake and Dream: a mid pigment with near-white initials passes AA either way.
      style={{
        background: `oklch(0.52 0.07 ${hue(name)})`,
        color: `oklch(0.98 0.01 ${hue(name)})`,
      }}
    >
      {initials(name)}
    </span>
  );
}
