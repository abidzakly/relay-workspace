import { AlertTriangle, CheckCircle2, MinusCircle, XCircle, type LucideIcon } from 'lucide-react';
import type { Check, CheckStatus, ConnectionTestResult } from '@relay/shared';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

const ICON: Record<CheckStatus, { icon: LucideIcon; cls: string; label: string }> = {
  pass: { icon: CheckCircle2, cls: 'text-success', label: 'pass' },
  warn: { icon: AlertTriangle, cls: 'text-warning', label: 'warning' },
  fail: { icon: XCircle, cls: 'text-destructive', label: 'fail' },
  skip: { icon: MinusCircle, cls: 'text-muted-foreground', label: 'skipped' },
};

function Row({ check }: { check: Check }) {
  const { icon: Icon, cls, label } = ICON[check.status];
  return (
    <li className="flex gap-3 py-2">
      <Icon className={cn('mt-0.5 size-4 shrink-0', cls)} aria-label={label} />
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-sm font-medium">{check.label}</span>
          <code className="text-xs text-muted-foreground">{check.id}</code>
        </div>
        {check.message ? (
          <p className="text-sm break-words text-muted-foreground">{check.message}</p>
        ) : null}
        {check.hint && check.status !== 'pass' ? (
          <p className="text-sm break-words">
            <span className="font-medium">Fix: </span>
            {check.hint}
          </p>
        ) : null}
      </div>
    </li>
  );
}

/** Renders the checklist returned by the connection-test endpoints as-is. */
export function ConnectionChecklist({ result }: { result: ConnectionTestResult }) {
  const { summary, checks, ok, testedAt, notion } = result;
  return (
    <div className="rounded-lg border bg-background p-3" aria-live="polite">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={ok ? 'success' : 'destructive'}>{ok ? 'No failures' : 'Failed'}</Badge>
        <Badge variant="success">{summary.pass} pass</Badge>
        {summary.warn > 0 && <Badge variant="warning">{summary.warn} warn</Badge>}
        {summary.fail > 0 && <Badge variant="destructive">{summary.fail} fail</Badge>}
        {summary.skip > 0 && <Badge variant="secondary">{summary.skip} skipped</Badge>}
        <span className="ml-auto text-xs text-muted-foreground">
          {new Date(testedAt).toLocaleTimeString()}
        </span>
      </div>
      <ul className="mt-2 divide-y">
        {checks.map((c) => (
          <Row key={c.id} check={c} />
        ))}
      </ul>
      {notion ? (
        <div className="mt-2 rounded-md bg-muted p-3 text-sm">
          <div className="mb-1 font-medium">Detected in Notion</div>
          <dl className="grid gap-1 text-muted-foreground">
            {notion.titleProp ? (
              <div>
                Title property: <span className="text-foreground">{notion.titleProp.name}</span>
              </div>
            ) : null}
            {notion.statusProp ? (
              <div>
                Status property:{' '}
                <span className="text-foreground">
                  {notion.statusProp.name} ({notion.statusProp.type})
                </span>
              </div>
            ) : null}
            {notion.statusOptions.length > 0 ? (
              <div>
                Status options:{' '}
                <span className="text-foreground">
                  {notion.statusOptions.map((o) => o.name).join(', ')}
                </span>
              </div>
            ) : null}
          </dl>
        </div>
      ) : null}
    </div>
  );
}
