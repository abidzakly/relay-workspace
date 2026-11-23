import { AnimatePresence, motion } from 'motion/react';
import { Plus, X } from 'lucide-react';
import type { PriorityRule } from '@relay/shared';
import { Dropdown } from '@/components/Dropdown';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SPRING } from '@/lib/motion/presets';

/**
 * Title rules for meeting priority (Settings > Google Calendar). A meeting whose title contains the words gets the
 * level; the first rule that matches wins; a meeting marked by hand on the Meetings page ignores the rules.
 */
export function PriorityRulesEditor({
  value,
  onChange,
}: {
  value: PriorityRule[];
  onChange: (rules: PriorityRule[]) => void;
}) {
  const set = (i: number, patch: Partial<PriorityRule>) =>
    onChange(value.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="grid gap-2">
      <ul className="grid gap-2">
        <AnimatePresence initial={false}>
          {value.map((r, i) => (
            <motion.li
              key={i}
              layout
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, x: 12 }}
              transition={SPRING.settle}
              className="flex items-center gap-2"
            >
              <span className="w-24 shrink-0 text-xs text-muted-foreground">
                {i === 0 ? 'Title contains' : 'or contains'}
              </span>
              <Input
                value={r.match}
                onChange={(e) => set(i, { match: e.target.value })}
                aria-label={`Rule ${i + 1}: words in the title`}
                placeholder="e.g. Sprint Review"
                maxLength={80}
                className="h-8 min-w-0 flex-1"
              />
              <Dropdown
                label={`Rule ${i + 1}: level`}
                size="sm"
                value={r.level}
                onChange={(level) => set(i, { level })}
                options={[
                  { value: 'key', label: '◆ Key' },
                  { value: 'quiet', label: 'Quiet' },
                ]}
              />
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={`Remove rule ${i + 1}`}
                onClick={() => onChange(value.filter((_, j) => j !== i))}
              >
                <X className="size-4" aria-hidden />
              </Button>
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
      <div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={value.length >= 30}
          onClick={() => onChange([...value, { match: '', level: 'key' }])}
        >
          <Plus className="size-4" aria-hidden />
          Add rule
        </Button>
      </div>
    </div>
  );
}
