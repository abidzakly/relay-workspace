import type { KpiCardRow, KpiScorecard } from '@relay/shared';

/** Scorecard exports. Pure. Dates use the server's local time zone, like the months they fall in. */

const pad = (n: number): string => String(n).padStart(2, '0');

function dateTime(t: number | null): string {
  if (t === null) return '';
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const percent = (r: number | null): string => (r === null ? 'n/a' : `${Math.round(r * 100)}%`);

const assignedLabel = (r: KpiCardRow): string =>
  `${dateTime(r.assignedAt.at)}${r.assignedAt.approx ? ' (approx)' : ''}${r.assignedAt.source === 'manual' ? ' (manual)' : ''}`;

const mrLabel = (r: KpiCardRow): string => (r.mr ? `${r.mr.repoId}!${r.mr.iid}` : '');

const metricLines = (s: KpiScorecard): [string, string][] => [
  ['Cards', String(s.counts.cards)],
  [
    'Bug ratio',
    `${percent(s.bugRatio.ratio)} (${s.bugRatio.bugs} of ${s.bugRatio.total}, max ${percent(s.bugRatio.max)})`,
  ],
  ['Research', `${s.research.count} of ${s.research.required} (${s.research.state})`],
  ...(s.completion
    ? ([
        [
          'Task completion',
          `${percent(s.completion.rate)} (${s.completion.completed} of ${s.completion.total} reached Ready to Test, target ${percent(s.completion.target)})`,
        ],
      ] as [string, string][])
    : []),
  ...(s.effort
    ? ([
        [
          'Effort (Point)',
          `${s.effort.doneHours}h of ${s.effort.totalHours}h done, ${s.effort.research} research, ${s.effort.unestimated} unestimated`,
        ],
      ] as [string, string][])
    : []),
  ['SLA hit-rate', percent(s.sla.overall.hitRate)],
  ['Average resolution', s.sla.overall.avgResolutionLabel ?? 'n/a'],
  ['Late cards', String(s.lateCards.length)],
  [
    'Review latency (mean)',
    `${s.reviewLatency.meanLabel ?? 'n/a'} (${s.reviewLatency.sampled} MRs, ${s.reviewLatency.withoutResponse} without a response)`,
  ],
];

/** Card titles are free text: one line, and no table cell or Markdown syntax of their own. */
function mdText(s: string): string {
  return s
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/([\\`*_[\]<>|])/g, '\\$1');
}

function mdTable(head: string[], rows: string[][]): string[] {
  return [
    `| ${head.join(' | ')} |`,
    `| ${head.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
  ];
}

export function scorecardMarkdown(
  s: KpiScorecard,
  rows: readonly KpiCardRow[],
  frozenAt: number | null,
): string {
  const out = [
    `# KPI scorecard ${s.month}`,
    '',
    frozenAt === null ? `As of ${dateTime(s.asOf)}.` : `Frozen on ${dateTime(frozenAt)}.`,
    '',
    ...mdTable(
      ['Metric', 'Value'],
      metricLines(s).map(([k, v]) => [k, mdText(v)]),
    ),
    '',
    '## SLA by type',
    '',
    ...mdTable(
      ['Type', 'Rule (days)', 'Met', 'Breached', 'In flight', 'Hit-rate', 'Avg resolution'],
      s.sla.byType.map((t) => [
        mdText(t.type),
        t.ruleDays === null ? '' : String(t.ruleDays),
        String(t.met),
        String(t.breached),
        String(t.inFlight),
        percent(t.hitRate),
        t.avgResolutionLabel ?? '',
      ]),
    ),
    '',
    '## Late cards',
    '',
    ...(s.lateCards.length === 0
      ? ['None.']
      : mdTable(
          ['Card', 'Type', 'Deadline', 'MR opened', 'Late by'],
          s.lateCards.map((c) => [
            mdText(c.title),
            mdText(c.type ?? ''),
            dateTime(c.deadline),
            dateTime(c.stoppedAt),
            c.lateByLabel,
          ]),
        )),
    '',
    '## Cards',
    '',
    ...mdTable(
      ['Card', 'Type', 'Status', 'Assigned', 'Deadline', 'State', 'MR'],
      rows.map((r) => [
        mdText(r.title),
        mdText(r.type ?? ''),
        mdText(r.status ?? ''),
        assignedLabel(r),
        dateTime(r.sla.deadline),
        r.sla.state,
        mrLabel(r),
      ]),
    ),
  ];
  return `${out.join('\n')}\n`;
}

/** RFC 4180 quoting, and a leading `'` on anything a spreadsheet would run as a formula. */
export function csvCell(raw: string): string {
  const s = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const csvLine = (cells: readonly string[]): string => cells.map(csvCell).join(',');

/** Two blocks separated by a blank line: the metrics, then one row per card. */
export function scorecardCsv(s: KpiScorecard, rows: readonly KpiCardRow[]): string {
  const lines = [
    csvLine(['Metric', 'Value']),
    csvLine(['Month', s.month]),
    ...metricLines(s).map((m) => csvLine(m)),
    ...s.sla.byType.map((t) => csvLine([`SLA hit-rate: ${t.type}`, percent(t.hitRate)])),
    '',
    csvLine([
      'Card',
      'Type',
      'Status',
      'Assigned',
      'Assigned source',
      'Approx',
      'Start clock',
      'Deadline',
      'State',
      'MR',
      'MR opened',
      'URL',
    ]),
    ...rows.map((r) =>
      csvLine([
        r.title,
        r.type ?? '',
        r.status ?? '',
        dateTime(r.assignedAt.at),
        r.assignedAt.source ?? '',
        r.assignedAt.approx ? 'yes' : 'no',
        dateTime(r.sla.startClock),
        dateTime(r.sla.deadline),
        r.sla.state,
        mrLabel(r),
        dateTime(r.mr?.createdAt ?? null),
        r.url ?? '',
      ]),
    ),
  ];
  return `${lines.join('\r\n')}\r\n`;
}
