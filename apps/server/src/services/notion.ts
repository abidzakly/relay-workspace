import { normalizeName, type Check, type GlobalConfig, type NotionDetected } from '@relay/shared';
import { clip, makeCheck } from './checks';
import { HttpNetworkError, type HttpClient } from './httpClient';
import {
  detectStatusProp,
  detectTitleProp,
  findProp,
  parseProperties,
  resolveOptions,
  type NotionProp,
} from './notionSchema';

export const NOTION_API_BASE = 'https://api.notion.com/v1';
/** The API version this code mirrors. Other versions are allowed but flagged. */
export const NOTION_SUPPORTED_VERSION = '2025-09-03';

type Maker = ReturnType<typeof makeCheck>;

export interface NotionTestInput {
  notion: Pick<
    GlobalConfig['notion'],
    'token' | 'dataSourceId' | 'version' | 'props' | 'statuses' | 'readyStatus'
  >;
  /** `sla.rules` keys are the expected `Type` option names. */
  slaTypeNames: readonly string[];
  http: HttpClient;
}

export interface NotionTestOutput {
  checks: Check[];
  detected?: NotionDetected;
}

/** Expected Notion property type per configured role (`required` = missing is a fail, else warn). */
const ROLE_SPECS = [
  { role: 'type', label: 'Type property', types: ['select'], required: true },
  { role: 'assignee', label: 'Assignee property', types: ['people'], required: true },
  { role: 'estimation', label: 'Estimation property', types: ['date'], required: true },
  {
    role: 'branchName',
    label: 'Branch name property',
    types: ['rich_text', 'formula'],
    required: true,
  },
  { role: 'parent', label: 'Parent item property', types: ['relation'], required: false },
  {
    role: 'productDomain',
    label: 'Product Domain property',
    types: ['select', 'multi_select', 'status', 'rich_text', 'formula', 'relation'],
    required: false,
  },
  {
    role: 'point',
    label: 'Point property',
    types: ['number', 'select', 'formula', 'rich_text'],
    required: false,
  },
  {
    role: 'sprint',
    label: 'Sprint property',
    types: ['select', 'multi_select', 'status', 'rich_text', 'formula', 'relation'],
    required: false,
  },
  { role: 'subTasks', label: 'Sub-task property', types: ['relation'], required: false },
] as const;

/** Read-only: one `GET /data_sources/:id`, then pure checks over the schema. */
export async function testNotion(input: NotionTestInput): Promise<NotionTestOutput> {
  const c = makeCheck('notion');
  const { notion } = input;
  const checks: Check[] = [];

  if (!notion.token) {
    return {
      checks: [
        c.fail(
          'notion.auth',
          'Connection',
          'No Notion token is saved.',
          'Paste the integration token (ntn_…) in Settings → Notion.',
        ),
      ],
    };
  }
  if (!notion.dataSourceId) {
    return {
      checks: [
        c.fail(
          'notion.auth',
          'Connection',
          'No data source id is configured.',
          'Set Settings → Notion → data source id.',
        ),
      ],
    };
  }

  let json: unknown;
  try {
    const res = await input.http.send({
      url: `${NOTION_API_BASE}/data_sources/${encodeURIComponent(notion.dataSourceId)}`,
      headers: { authorization: `Bearer ${notion.token}`, 'notion-version': notion.version },
    });
    if (res.status !== 200) return { checks: [notionHttpFail(c, res.status, res.json)] };
    json = res.json;
  } catch (e) {
    const kind = e instanceof HttpNetworkError ? e.kind : 'network';
    return {
      checks: [
        c.fail(
          'notion.auth',
          'Connection',
          kind === 'timeout'
            ? 'Timed out reaching api.notion.com.'
            : `Could not reach api.notion.com (${kind}).`,
          'Check your network / proxy and try again.',
        ),
      ],
    };
  }

  const props = parseProperties(json);
  const objectKind = (json as { object?: unknown } | undefined)?.object;
  if (!props || (typeof objectKind === 'string' && objectKind !== 'data_source')) {
    return {
      checks: [
        c.fail(
          'notion.auth',
          'Connection',
          'Notion answered, but not with a data source schema.',
          'Use the data source id (not the database id or page id); see Notion → database ⋯ → Manage data sources.',
        ),
      ],
    };
  }
  checks.push(
    c.pass('notion.auth', 'Connection', `Data source reachable (${props.length} properties).`),
  );

  if (notion.version === NOTION_SUPPORTED_VERSION) {
    checks.push(c.pass('notion.version', 'API version', `Notion-Version ${notion.version}.`));
  } else {
    checks.push(
      c.warn(
        'notion.version',
        'API version',
        `Notion-Version ${clip(notion.version, 20)} differs from ${NOTION_SUPPORTED_VERSION}, which this app was built against.`,
        `Set it back to ${NOTION_SUPPORTED_VERSION} unless you know the newer shape is compatible.`,
      ),
    );
  }

  const detected: NotionDetected = { statusOptions: [] };

  // title
  const title = detectTitleProp(props, notion.props.title);
  if (title.ok) {
    detected.titleProp = { name: title.prop.name, id: title.prop.id };
    checks.push(c.pass('notion.prop.title', 'Title property', `"${clip(title.prop.name, 80)}".`));
  } else {
    checks.push(
      c.fail(
        'notion.prop.title',
        'Title property',
        title.reason === 'wrong_type'
          ? `"${clip(notion.props.title, 80)}" is a ${title.found?.type} property, not title.`
          : `Title property "${clip(notion.props.title, 80)}" not found.`,
        'Set props.title to "auto" or to the name of the database\'s title column.',
      ),
    );
  }

  // status
  const status = detectStatusProp(props, notion.props.status);
  let statusProp: NotionProp | undefined;
  if (status.ok) {
    statusProp = status.prop;
    detected.statusProp = { name: status.prop.name, id: status.prop.id, type: status.prop.type };
    const how =
      status.via === 'status-type'
        ? 'auto-detected (type status)'
        : status.via === 'select-named-status'
          ? 'auto-detected (select named "Status")'
          : 'as configured';
    checks.push(
      c.pass(
        'notion.prop.status',
        'Status property',
        `"${clip(status.prop.name, 80)}" (${status.prop.type}), ${how}.`,
      ),
    );
  } else {
    const msg =
      status.reason === 'wrong_type'
        ? `"${clip(notion.props.status, 80)}" is a ${status.found?.type} property; need status or select.`
        : status.reason === 'ambiguous'
          ? 'More than one property matches the status name.'
          : notion.props.status === 'auto'
            ? 'No `status` property and no `select` named "Status" found.'
            : `Status property "${clip(notion.props.status, 80)}" not found.`;
    checks.push(
      c.fail(
        'notion.prop.status',
        'Status property',
        msg,
        suggestNames(props, ['status', 'select'], 'Set props.status to one of'),
      ),
    );
  }

  // status options -> ids
  if (statusProp) {
    const r = resolveOptions(statusProp.options, notion.statuses);
    detected.statusOptions = r.resolved.map((x) => ({
      configured: x.configured,
      name: x.option.name,
      id: x.option.id,
    }));
    const readyKey = normalizeName(notion.readyStatus);
    const readyMissing = r.missing.some((m) => normalizeName(m) === readyKey);
    const readyOpt = r.resolved.find((x) => normalizeName(x.configured) === readyKey);
    if (readyOpt) {
      checks.push(
        c.pass(
          'notion.status.ready',
          'Ready status',
          `"${clip(notion.readyStatus, 60)}" → option "${clip(readyOpt.option.name, 60)}".`,
        ),
      );
    } else {
      checks.push(
        c.fail(
          'notion.status.ready',
          'Ready status',
          readyMissing
            ? `"${clip(notion.readyStatus, 60)}" is not an option of "${clip(statusProp.name, 60)}".`
            : `"${clip(notion.readyStatus, 60)}" is not in the configured statuses.`,
          `Create the option in Notion or change readyStatus. Existing options: ${optionList(statusProp)}.`,
        ),
      );
    }
    const otherMissing = r.missing.filter((m) => normalizeName(m) !== readyKey);
    if (otherMissing.length > 0) {
      checks.push(
        c.warn(
          'notion.status.options',
          'Configured statuses',
          `Not found in Notion: ${otherMissing.map((m) => `"${clip(m, 40)}"`).join(', ')}.`,
          `Create them in Notion or remove them from Settings → statuses. Existing options: ${optionList(statusProp)}.`,
        ),
      );
    } else if (r.ambiguous.length > 0) {
      checks.push(
        c.warn(
          'notion.status.options',
          'Configured statuses',
          `Several Notion options match once case/spacing is ignored: ${r.ambiguous.map((m) => `"${clip(m, 40)}"`).join(', ')}.`,
          'Rename the duplicate options so each status name is unique.',
        ),
      );
    } else {
      checks.push(
        c.pass(
          'notion.status.options',
          'Configured statuses',
          `All ${notion.statuses.length} statuses resolve to Notion options.`,
        ),
      );
    }
    if (r.unmapped.length > 0) {
      checks.push(
        c.warn(
          'notion.status.unmapped',
          'Unmapped Notion statuses',
          `Notion has options the app does not know: ${r.unmapped.map((o) => `"${clip(o.name, 40)}"`).join(', ')}.`,
          'Cards in these statuses will show as unmapped. Add them to Settings → statuses if they matter.',
        ),
      );
    }
  } else {
    checks.push(c.skip('notion.status.ready', 'Ready status', 'Needs the status property.'));
    checks.push(
      c.skip('notion.status.options', 'Configured statuses', 'Needs the status property.'),
    );
  }

  // other configured properties
  let typeProp: NotionProp | undefined;
  for (const spec of ROLE_SPECS) {
    const configured = notion.props[spec.role];
    const id = `notion.prop.${spec.role}`;
    const bad = spec.required ? c.fail : c.warn;
    const hit = findProp(props, configured);
    if (!hit) {
      checks.push(
        bad(
          id,
          spec.label,
          `"${clip(configured, 80)}" not found.`,
          suggestNames(props, spec.types, `Set props.${spec.role} to one of`),
        ),
      );
      continue;
    }
    if ('ambiguous' in hit) {
      checks.push(
        bad(
          id,
          spec.label,
          `"${clip(configured, 80)}" matches several properties once case/spacing is ignored.`,
          `Use the exact name: ${hit.ambiguous.map((p) => `"${clip(p.name, 40)}"`).join(', ')}.`,
        ),
      );
      continue;
    }
    if (!(spec.types as readonly string[]).includes(hit.prop.type)) {
      checks.push(
        bad(
          id,
          spec.label,
          `"${clip(hit.prop.name, 80)}" is ${hit.prop.type}, expected ${spec.types.join(' or ')}.`,
          suggestNames(props, spec.types, `Set props.${spec.role} to one of`),
        ),
      );
      continue;
    }
    if (spec.role === 'type') typeProp = hit.prop;
    checks.push(
      hit.exact
        ? c.pass(id, spec.label, `"${clip(hit.prop.name, 80)}" (${hit.prop.type}).`)
        : c.warn(
            id,
            spec.label,
            `Configured "${clip(configured, 80)}" differs from Notion's "${clip(hit.prop.name, 80)}" by case/spacing.`,
            `Change the setting to "${clip(hit.prop.name, 80)}" so every part of the app finds it.`,
          ),
    );
  }

  // SLA type names vs Type options
  if (typeProp) {
    const have = new Set(typeProp.options.map((o) => normalizeName(o.name)));
    const missing = input.slaTypeNames.filter((n) => !have.has(normalizeName(n)));
    checks.push(
      missing.length === 0
        ? c.pass('notion.sla.types', 'SLA card types', 'Every SLA rule matches a Type option.')
        : c.warn(
            'notion.sla.types',
            'SLA card types',
            `SLA rules for types missing in Notion: ${missing.map((m) => `"${clip(m, 40)}"`).join(', ')}.`,
            `Rename the SLA rule or the Notion option. Existing options: ${optionList(typeProp)}.`,
          ),
    );
  } else {
    checks.push(c.skip('notion.sla.types', 'SLA card types', 'Needs the Type property.'));
  }

  return { checks, detected };
}

function optionList(p: NotionProp): string {
  return p.options.length === 0
    ? '(none)'
    : p.options.map((o) => `"${clip(o.name, 40)}"`).join(', ');
}

function suggestNames(
  props: readonly NotionProp[],
  types: readonly string[],
  lead: string,
): string {
  const names = props.filter((p) => types.includes(p.type)).map((p) => `"${clip(p.name, 40)}"`);
  return names.length > 0
    ? `${lead}: ${names.slice(0, 8).join(', ')}.`
    : `The database has no ${types.join('/')} property; add one in Notion.`;
}

function notionHttpFail(c: Maker, status: number, body: unknown): Check {
  const code = (body as { code?: unknown } | undefined)?.code;
  const codeText = typeof code === 'string' ? ` (${clip(code, 40)})` : '';
  const id = 'notion.auth';
  const label = 'Connection';
  if (status === 401) {
    return c.fail(
      id,
      label,
      `Notion rejected the token${codeText}.`,
      'Paste a valid internal integration token (ntn_…).',
    );
  }
  if (status === 403) {
    return c.fail(
      id,
      label,
      `The integration is not allowed to read this data source${codeText}.`,
      'Give the integration "Read content" capability.',
    );
  }
  if (status === 404) {
    return c.fail(
      id,
      label,
      `Data source not found, or not shared with the integration${codeText}.`,
      'Open the database in Notion → ⋯ → Connections → add your integration. Also check the id is a data source id, not a database id.',
    );
  }
  if (status === 400) {
    return c.fail(
      id,
      label,
      `Notion rejected the request${codeText}.`,
      'Check the data source id format and the Notion-Version setting.',
    );
  }
  if (status === 429) {
    return c.fail(
      id,
      label,
      'Notion is rate limiting requests (retries exhausted).',
      'Wait a minute and test again.',
    );
  }
  return c.fail(
    id,
    label,
    `Notion answered HTTP ${status}${codeText}.`,
    'Try again; check status.notion.com if it persists.',
  );
}
