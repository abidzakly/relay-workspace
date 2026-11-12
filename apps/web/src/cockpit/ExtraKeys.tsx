import { useState } from 'react';
import { cn } from '@/lib/utils';

/**
 * Mobile extra-key bar: keys a phone keyboard lacks. Ctrl is sticky: the next key sent
 * through the bar becomes its control character (Ctrl+C = \x03).
 */
const KEYS: { label: string; data: string; aria: string }[] = [
  { label: 'Esc', data: '\x1b', aria: 'Escape' },
  { label: 'Tab', data: '\t', aria: 'Tab' },
  { label: '↑', data: '\x1b[A', aria: 'Panah atas' },
  { label: '↓', data: '\x1b[B', aria: 'Panah bawah' },
  { label: '←', data: '\x1b[D', aria: 'Panah kiri' },
  { label: '→', data: '\x1b[C', aria: 'Panah kanan' },
  { label: '/', data: '/', aria: 'Slash' },
  { label: '|', data: '|', aria: 'Pipe' },
  { label: '⏎', data: '\r', aria: 'Enter' },
];

export const ctrlOf = (ch: string): string => {
  const c = ch.toUpperCase().charCodeAt(0);
  return c >= 64 && c <= 95 ? String.fromCharCode(c - 64) : ch;
};

export function ExtraKeys({ onKey }: { onKey: (data: string) => void }) {
  const [ctrl, setCtrl] = useState(false);
  const press = (data: string) => {
    onKey(ctrl && data.length === 1 ? ctrlOf(data) : data);
    setCtrl(false);
  };
  const btn =
    'h-9 min-w-10 shrink-0 rounded-lg border bg-card px-2.5 font-mono text-sm active:scale-95 transition-transform';
  return (
    <div
      className="flex gap-1.5 overflow-x-auto pb-0.5 [scrollbar-width:none]"
      role="toolbar"
      aria-label="Tombol ekstra"
    >
      <button
        type="button"
        aria-pressed={ctrl}
        className={cn(btn, ctrl && 'border-primary bg-primary/15 text-primary-ink')}
        onClick={() => setCtrl((c) => !c)}
      >
        Ctrl
      </button>
      <button type="button" className={btn} aria-label="Ctrl+C" onClick={() => press('\x03')}>
        ^C
      </button>
      {KEYS.map((k) => (
        <button
          key={k.label}
          type="button"
          className={btn}
          aria-label={k.aria}
          onClick={() => press(k.data)}
        >
          {k.label}
        </button>
      ))}
    </div>
  );
}
