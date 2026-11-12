import { SendHorizontal } from 'lucide-react';
import { useState, type KeyboardEvent } from 'react';
import type { SessionKind } from '@relay/shared';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { MicButton } from '@/components/MicButton';
import { useCoarsePointer } from '@/workspace/useMedia';

/**
 * Bottom composer for agent sessions: a comfortable multi-line box, plus quick chips per
 * agent. A chip either sends raw keys (Esc, Ctrl+C, ⇧Tab) or types a slash command. Enter sends on desktop;
 * on touch, Enter is a newline and the button sends.
 */
interface Chip {
  label: string;
  /** Raw key data, sent as-is. */
  keys?: string;
  /** A slash command, sent as a prompt. */
  command?: string;
}

const CHIPS: Record<'cursor', Chip[]> = {
  cursor: [
    { label: '/model', command: '/model' },
    { label: '/clear', command: '/clear' },
    { label: '/resume', command: '/resume' },
    { label: 'Esc', keys: '\x1b' },
    { label: 'Ctrl+C', keys: '\x03' },
    { label: '⇧Tab mode', keys: '\x1b[Z' },
  ],
};

export function Composer({
  kind,
  onPrompt,
  onKeys,
  disabled,
}: {
  kind: SessionKind;
  onPrompt: (text: string) => void;
  onKeys: (data: string) => void;
  disabled?: boolean;
}) {
  const [text, setText] = useState('');
  const touch = useCoarsePointer();
  const chips = kind === 'cursor' ? CHIPS[kind] : [];
  const submit = () => {
    const t = text.trim();
    if (!t) return;
    onPrompt(t);
    setText('');
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !touch && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };
  return (
    <div className="grid gap-2">
      {chips.length > 0 && (
        <div className="flex gap-1.5 overflow-x-auto [scrollbar-width:none]">
          {chips.map((c) => (
            <button
              key={c.label}
              type="button"
              disabled={disabled}
              onClick={() => (c.keys ? onKeys(c.keys) : onPrompt(c.command!))}
              className={cn(
                'h-8 shrink-0 rounded-full border px-3 text-xs font-medium transition-colors hover:bg-accent',
                c.command ? 'font-mono' : 'text-muted-foreground',
              )}
            >
              {c.label}
            </button>
          ))}
        </div>
      )}
      <div className="flex items-end gap-2 rounded-surface border bg-card p-2 focus-within:ring-2 focus-within:ring-ring">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          rows={Math.min(6, Math.max(1, text.split('\n').length))}
          placeholder={kind === 'shell' ? 'Command…' : 'Ask the agent…'}
          disabled={disabled}
          enterKeyHint={touch ? 'enter' : 'send'}
          className="max-h-40 min-h-9 flex-1 resize-none bg-transparent px-2 py-1.5 text-base outline-none placeholder:text-muted-foreground"
          aria-label="Prompt"
        />
        <MicButton onText={(t) => setText((prev) => (prev ? `${prev} ${t}` : t))} />
        <Button
          size="icon"
          className="size-9 shrink-0 rounded-xl"
          disabled={disabled || !text.trim()}
          onClick={submit}
          aria-label="Send"
        >
          <SendHorizontal className="size-4" />
        </Button>
      </div>
    </div>
  );
}
