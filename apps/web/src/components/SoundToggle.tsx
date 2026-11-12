import { playSound } from '@/lib/sound/engine';
import { cn } from '@/lib/utils';
import { useUiStore } from '@/store/ui';

/** A small sine wave: it moves while sound is on and lies flat when off. */
function Wave({ on }: { on: boolean }) {
  return (
    <svg aria-hidden viewBox="0 0 16 8" className="h-2 w-4 shrink-0 overflow-hidden">
      <path
        d={on ? 'M0 4 Q2 0 4 4 T8 4 T12 4 T16 4 T20 4 T24 4' : 'M0 4 H16'}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        className={on ? 'sound-wave' : undefined}
      />
    </svg>
  );
}

/** Always visible: on the HUD, the page bar and the classic layout. Sound is off until this is turned on. */
export function SoundToggle({ className, compact }: { className?: string; compact?: boolean }) {
  const soundOn = useUiStore((s) => s.soundOn);
  const setSoundOn = useUiStore((s) => s.setSoundOn);
  const label = soundOn ? 'Sound on' : 'Sound off';
  return (
    <button
      type="button"
      title={`${label} (click to change)`}
      aria-label="Sound"
      aria-pressed={soundOn}
      onClick={() => {
        setSoundOn(!soundOn);
        // Turning it on answers with the sound itself, so it is clear what was enabled.
        if (!soundOn) playSound('tick');
      }}
      className={cn(
        'tactile inline-flex h-8 items-center gap-1.5 rounded-full px-2.5 type-micro text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
    >
      <Wave on={soundOn} />
      <span className={compact ? 'sr-only' : undefined}>{label}</span>
    </button>
  );
}
