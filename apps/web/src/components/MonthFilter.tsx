import { Link } from 'react-router';
import { Trans, useTranslation } from 'react-i18next';
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
  const { t } = useTranslation();
  const months = monthOptions(cards).filter((m) => m !== monthKey());
  // A fixed month that no card has any more is still offered, so the select never shows a blank.
  const fixed = month !== 'current' && month !== 'all' && !months.includes(month) ? [month] : [];
  return (
    <Select
      aria-label={t('overview.month.label')}
      value={month}
      onChange={(e) => setMonth(e.target.value as CardMonth)}
      className="w-44"
    >
      <option value="current">{t('overview.month.current')}</option>
      {[...fixed, ...months].map((m) => (
        <option key={m} value={m}>
          {monthLabel(m)}
        </option>
      ))}
      <option value="all">{t('overview.month.all')}</option>
    </Select>
  );
}

/**
 * Everything shows only my cards and MRs, and the sync fetches nothing for someone it cannot identify. This says
 * which identity is missing, so an empty view is never a mystery.
 */
export function NoIdentityNotice() {
  const settings = useSettings();
  const { t } = useTranslation();
  const s = settings.data;
  if (!s) return null;
  const notion = hasNotionUserId(s.notion.assigneeAliases);
  const gitlab = !!s.gitlab.myUsername;
  if (notion && gitlab) return null;
  return (
    <Alert>
      <AlertTitle>{t('overview.identity.title')}</AlertTitle>
      <AlertDescription>
        {!notion && (
          <span className="block">
            <Trans
              i18nKey="overview.identity.notion"
              components={[
                <Link
                  key="notion"
                  to="/settings#notion"
                  className="underline underline-offset-4"
                />,
              ]}
            />
          </span>
        )}
        {!gitlab && (
          <span className="block">
            <Trans
              i18nKey="overview.identity.gitlab"
              components={[
                <Link
                  key="gitlab"
                  to="/settings#gitlab"
                  className="underline underline-offset-4"
                />,
              ]}
            />
          </span>
        )}
      </AlertDescription>
    </Alert>
  );
}
