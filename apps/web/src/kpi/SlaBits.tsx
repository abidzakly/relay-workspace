import type { AssignedAtResolution, SlaEvaluation } from '@relay/shared';
import { Badge } from '@/components/Badge';
import { SLA_META } from './model';

/** One SLA state: icon and label, plus colour. */
export function SlaBadge({ sla }: { sla: SlaEvaluation }) {
  const meta = SLA_META[sla.state];
  return (
    <Badge variant={meta.variant} className={meta.className}>
      <meta.icon aria-hidden />
      {meta.label}
    </Badge>
  );
}

const SOURCE: Record<NonNullable<AssignedAtResolution['source']>, string> = {
  firstSeen: 'first seen as assigned by the dashboard',
  property: 'from the Notion property',
  manual: 'set by hand',
};

/** Where an assigned-at came from is shown wherever it can change the timer. */
export function AssignedAtFlags({ assignedAt }: { assignedAt: AssignedAtResolution }) {
  return (
    <>
      {assignedAt.source === 'manual' && (
        <Badge variant="secondary" title={SOURCE.manual}>
          manual
        </Badge>
      )}
      {assignedAt.approx && (
        <Badge
          variant="outline"
          title={`Approximate: ${assignedAt.source ? SOURCE[assignedAt.source] : 'source unknown'}`}
        >
          approx
        </Badge>
      )}
    </>
  );
}
