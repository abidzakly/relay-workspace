import { useState } from 'react';
import { Bell, Bot, ScanEye, type LucideIcon } from 'lucide-react';
import { pathEnabled } from '@relay/shared';
import { useFeatures } from '@/lib/features';
import { useReviewDesk } from '@/lib/reviewsApi';
import { Link } from 'react-router';
import { useUnreadNotifications } from '@/lib/notificationApi';
import { cn } from '@/lib/utils';
import { OBJECTS, type ObjectId } from './registry';
import type { SceneData, Tone } from './signals';
import type { EnvId } from './envFor';
import { thingIn } from './objects/names';

const TONE_CLASS: Record<Tone, string> = {
  idle: 'bg-muted-foreground/40',
  ok: 'bg-success',
  warn: 'bg-warning',
  bad: 'bg-destructive',
};

const TONE_TEXT: Record<Tone, string> = {
  idle: '',
  ok: 'All good.',
  warn: 'Needs a look.',
  bad: 'Needs action.',
};

/** Colour is never the only signal: the tone also reads out in the label. */
export function ToneDot({ tone, className }: { tone: Tone; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn('inline-block size-2 shrink-0 rounded-full', TONE_CLASS[tone], className)}
    />
  );
}

interface Entry {
  key: string;
  to: string;
  label: string;
  icon: LucideIcon;
  summary: string;
  tone: Tone;
  badge: number | null;
  ariaLabel: string;
  /** The world object this entry lights up. Pages with no object light up nothing. */
  object: ObjectId | null;
}

/**
 * Every object of the world as plain links, then the pages that have no object: the dock under the scene, and the whole
 * page when there is no WebGL. It is also what a screen reader and the keyboard use, since the canvas is hidden from them.
 */
export function SceneMenu({
  data,
  env,
  layout,
  onHover,
}: {
  data: SceneData;
  /** Names the thing as this environment draws it (the screen-reader label). */
  env: EnvId;
  layout: 'dock' | 'grid';
  onHover?: (id: ObjectId | null) => void;
}) {
  const unread = useUnreadNotifications().data?.unread ?? 0;
  const features = useFeatures();
  const desk = useReviewDesk(features.reviews).data;
  const asked =
    desk?.items.filter((i) => i.lane === 'needs_you' || i.lane === 'changed').length ?? 0;
  const [hint, setHint] = useState<Entry | null>(null);
  const dock = layout === 'dock';

  const all: Entry[] = [
    ...OBJECTS.map((o): Entry => {
      const s = data.signals[o.id];
      return {
        key: o.id,
        to: o.route,
        label: o.label,
        icon: o.icon,
        summary: s.summary,
        tone: s.tone,
        badge: s.badge,
        ariaLabel: `${o.label} (${thingIn(env, o.id)}). ${s.summary} ${TONE_TEXT[s.tone]}`.trim(),
        object: o.id,
      };
    }),
    {
      key: 'cockpit',
      to: '/cockpit',
      label: 'Cockpit',
      icon: Bot,
      summary: 'Your agent sessions.',
      tone: 'idle',
      badge: null,
      ariaLabel: 'Cockpit. Your agent sessions.',
      object: null,
    },
    {
      key: 'notifications',
      to: '/notifications',
      label: 'Notifications',
      icon: Bell,
      summary: unread > 0 ? `${unread} unread.` : 'Nothing unread.',
      tone: 'idle',
      badge: unread > 0 ? unread : null,
      ariaLabel: `Notifications. ${unread > 0 ? `${unread} unread.` : 'Nothing unread.'}`,
      object: null,
    },
    {
      key: 'reviews',
      to: '/reviews',
      label: 'Reviews',
      icon: ScanEye,
      summary: asked > 0 ? `${asked} waiting for your review.` : 'Nothing waiting for you.',
      tone: 'idle',
      badge: asked > 0 ? asked : null,
      ariaLabel: `Reviews. ${asked > 0 ? `${asked} waiting for your review.` : 'Nothing waiting for you.'}`,
      object: null,
    },
  ];
  // Switched-off features leave the menu (Settings > General > Features).
  const entries = all.filter((e) => pathEnabled(e.to, features));

  const show = (entry: Entry | null) => () => {
    setHint(entry);
    onHover?.(entry?.object ?? null);
  };

  return (
    <nav aria-label="Workspace" className={dock ? 'relative max-w-full' : undefined}>
      {/* Above the list, not inside it: the list scrolls sideways, which would clip a tooltip. Touch has the labels below. */}
      {dock && hint && (
        <p
          aria-hidden="true"
          className="pointer-events-none absolute bottom-full left-1/2 mb-3 hidden max-w-72 -translate-x-1/2 truncate px-2 py-1 type-micro text-foreground md:block"
        >
          <span>{hint.label}</span>
          <span className="text-muted-foreground"> · {hint.summary}</span>
        </p>
      )}
      <ul
        className={
          dock
            ? 'flex max-w-full gap-0.5 overflow-x-auto rounded-full glass p-1'
            : 'grid border-t border-hairline sm:grid-cols-2 lg:grid-cols-3'
        }
        onMouseLeave={show(null)}
      >
        {entries.map((e) => (
          <li key={e.key} className="shrink-0">
            <Link
              to={e.to}
              aria-label={e.ariaLabel}
              onMouseEnter={show(e)}
              onFocus={show(e)}
              onBlur={show(null)}
              className={cn(
                'relative flex items-center gap-2 outline-none focus-visible:ring-2 focus-visible:ring-ring',
                dock
                  ? 'tactile w-18 flex-col justify-center gap-0.5 rounded-full py-1.5 hover:bg-foreground hover:text-background md:size-11 md:py-0'
                  : 'group h-full items-start border-b border-hairline px-1 py-5 transition-colors hover:bg-accent/40 sm:px-4',
              )}
            >
              <e.icon
                className={dock ? 'size-[18px]' : 'mt-0.5 size-5 shrink-0'}
                strokeWidth={1.5}
              />
              {dock && (
                <span className="w-full truncate px-0.5 text-center text-micro font-semibold uppercase md:hidden">
                  {e.label}
                </span>
              )}
              {!dock && (
                <span className="flex min-w-0 flex-col">
                  <span className="flex items-center gap-1.5 type-micro">
                    <ToneDot tone={e.tone} />
                    {e.label}
                    {e.badge !== null && (
                      <span className="text-sm text-muted-foreground">{e.badge}</span>
                    )}
                  </span>
                  <span className="mt-1 text-sm text-muted-foreground">{e.summary}</span>
                </span>
              )}
              {dock && e.badge !== null && (
                <span
                  aria-hidden="true"
                  className={cn(
                    'absolute top-0 right-0.5 min-w-4 rounded-full px-1 text-center text-micro font-semibold md:-top-0.5 md:-right-0.5',
                    e.tone === 'bad'
                      ? 'bg-destructive text-destructive-foreground'
                      : e.tone === 'warn'
                        ? 'bg-warning text-background'
                        : 'bg-foreground text-background',
                  )}
                >
                  {e.badge > 99 ? '99+' : e.badge}
                </span>
              )}
              {dock && e.badge === null && e.tone !== 'idle' && e.tone !== 'ok' && (
                <ToneDot tone={e.tone} className="absolute top-1 right-1" />
              )}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
