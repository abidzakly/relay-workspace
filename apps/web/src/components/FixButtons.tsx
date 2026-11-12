import { useState } from 'react';
import { useNavigate } from 'react-router';
import type { Verdict } from '@relay/shared';
import { Button } from '@/components/ui/button';
import { ConfirmWriteDialog } from '@/components/ConfirmWriteDialog';
import type { WriteRequest } from '@/lib/cardApi';
import { fixExecutable, fixLabel, fixRoute, fixRouteHint, fixUnavailableReason } from '@/lib/fixes';

/**
 * The one-click Fix buttons of a verdict. A click only opens the confirm dialog; the write happens
 * after the user confirms there, and the server re-derives the fix from its own verdict (never from this
 * payload). `start_release` and `build_and_share` only navigate. Fixes that need later parts (linker, MR edits) stay
 * visible but disabled, with the reason.
 */
export function FixButtons({ v, size = 'sm' }: { v: Verdict; size?: 'sm' | 'default' }) {
  const [req, setReq] = useState<WriteRequest | null>(null);
  const navigate = useNavigate();
  const fixes = [...(v.fix ? [v.fix] : []), ...v.alternatives];
  if (fixes.length === 0) return null;
  return (
    <>
      <div className="flex flex-wrap gap-2">
        {fixes.map((f, i) => {
          const route = fixRoute(f);
          if (route) {
            return (
              <Button
                key={i}
                size={size}
                variant="outline"
                title={fixRouteHint(f)}
                onClick={() => void navigate(route)}
              >
                {fixLabel(f)}
              </Button>
            );
          }
          const ok = fixExecutable(f);
          return (
            <Button
              key={i}
              size={size}
              variant="outline"
              disabled={!ok}
              title={ok ? 'Review and confirm the change' : fixUnavailableReason(f)}
              onClick={() =>
                setReq({
                  kind: 'fix',
                  ruleId: v.ruleId,
                  target: { cardId: v.cardId, repoId: v.repoId, mrIid: v.mrIid },
                  fixIndex: i,
                })
              }
            >
              {fixLabel(f)}
            </Button>
          );
        })}
      </div>
      <ConfirmWriteDialog request={req} onClose={() => setReq(null)} />
    </>
  );
}
