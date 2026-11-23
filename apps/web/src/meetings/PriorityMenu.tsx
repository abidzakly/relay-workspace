import { Flag } from 'lucide-react';
import {
  matchPriority,
  type Meeting,
  type MeetingPriority,
  type PriorityRule,
} from '@relay/shared';
import { Dropdown, type DropdownOption } from '@/components/Dropdown';
import { useCalendarStatus, useSetMeetingPriority } from '@/lib/calendarApi';

/**
 * "Mark as…" for one meeting: Key, Normal or Quiet, for this meeting or every occurrence of a repeating one, or back
 * to automatic (the title rules). The automatic choice says what the rules would pick, so nothing is a guess.
 */

type Choice = 'auto' | `${MeetingPriority}:${'one' | 'series'}`;

const LEVEL_LABEL: Record<MeetingPriority, string> = {
  key: '◆ Key',
  normal: 'Normal',
  quiet: 'Quiet',
};

function autoHint(title: string, rules: readonly PriorityRule[] | undefined): string {
  const rule = rules ? matchPriority(title, rules) : null;
  return rule
    ? `${LEVEL_LABEL[rule.level]}: title has “${rule.match}”`
    : 'Normal: no title rule matches';
}

export function PriorityMenu({
  meeting,
  size = 'sm',
  className,
}: {
  meeting: Meeting;
  size?: 'sm' | 'md';
  className?: string;
}) {
  const set = useSetMeetingPriority();
  const rules = useCalendarStatus().data?.config.priorityRules;
  const value: Choice =
    meeting.prioritySource === 'one' || meeting.prioritySource === 'series'
      ? `${meeting.priority}:${meeting.prioritySource}`
      : 'auto';

  const options: DropdownOption<Choice>[] = [
    { value: 'auto', label: 'Automatic', hint: autoHint(meeting.title, rules) },
  ];
  for (const level of ['key', 'normal', 'quiet'] as const) {
    if (meeting.seriesId) {
      options.push({
        value: `${level}:series`,
        label: LEVEL_LABEL[level],
        hint: 'Every occurrence',
      });
    }
    options.push({
      value: `${level}:one`,
      label: LEVEL_LABEL[level],
      hint: meeting.seriesId ? 'Only this one' : 'This meeting',
    });
  }

  const onChange = (c: Choice) => {
    if (c === value) return;
    const base = { id: meeting.id, calendarId: meeting.calendarId, seriesId: meeting.seriesId };
    if (c === 'auto') {
      // Drop the mark that decides it now (a series mark, or this meeting's own).
      const scope = meeting.prioritySource === 'series' ? 'series' : 'one';
      set.mutate({ ...base, scope, level: null });
      return;
    }
    const [level, scope] = c.split(':') as [MeetingPriority, 'one' | 'series'];
    set.mutate({ ...base, scope, level });
  };

  return (
    <Dropdown
      label="Priority"
      icon={Flag}
      size={size}
      align="right"
      options={options}
      value={value}
      onChange={onChange}
      disabled={set.isPending}
      className={className}
    />
  );
}
