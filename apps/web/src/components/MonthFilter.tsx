import { Link } from 'react-router';
import type { StateCard } from '@relay/shared';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Select } from '@/components/ui/select';
import { hasNotionUserId, monthKey, monthLabel, monthOptions } from '@/lib/cardScope';
import { useSettings } from '@/lib/settingsApi';
import { useUiStore, type CardMonth } from '@/store/ui';

/** The month the card views show (the card's KPI month). Persisted, and shared by the Board and the Overview. */
export function MonthFilter({ cards }: { cards: readonly StateCard[] }) {
  const month = useUiStore((s) => s.cardMonth);
  const setMonth = useUiStore((s) => s.setCardMonth);
  const months = monthOptions(cards).filter((m) => m !== monthKey());
  // A fixed month that no card has any more is still offered, so the select never shows a blank.
  const fixed = month !== 'current' && month !== 'all' && !months.includes(month) ? [month] : [];
  return (
    <Select
      aria-label="Month"
      value={month}
      onChange={(e) => setMonth(e.target.value as CardMonth)}
      className="w-44"
    >
      <option value="current">This month</option>
      {[...fixed, ...months].map((m) => (
        <option key={m} value={m}>
          {monthLabel(m)}
        </option>
      ))}
      <option value="all">All months</option>
    </Select>
  );
}

/**
 * Everything shows only my cards and MRs, and the sync fetches nothing for someone it cannot identify. This says
 * which identity is missing, so an empty view is never a mystery.
 */
export function NoIdentityNotice() {
  const settings = useSettings();
  const s = settings.data;
  if (!s) return null;
  const notion = hasNotionUserId(s.notion.assigneeAliases);
  const gitlab = !!s.gitlab.myUsername;
  if (notion && gitlab) return null;
  return (
    <Alert>
      <AlertTitle>Not everything can be synced yet</AlertTitle>
      <AlertDescription>
        {!notion && (
          <span className="block">
            Notion cards are not fetched until your Notion user id is under{' '}
            <Link to="/settings#notion" className="underline underline-offset-4">
              Settings → Notion → My names
            </Link>
            .
          </span>
        )}
        {!gitlab && (
          <span className="block">
            Open MRs are not fetched until your username is set in{' '}
            <Link to="/settings#gitlab" className="underline underline-offset-4">
              Settings → GitLab
            </Link>
            .
          </span>
        )}
      </AlertDescription>
    </Alert>
  );
}
