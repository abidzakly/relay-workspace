import { describe, expect, it } from 'vitest';
import {
  detectStatusProp,
  detectTitleProp,
  findProp,
  parseProperties,
  resolveOptions,
  type NotionProp,
} from './notionSchema';

const p = (name: string, type: string, options: string[] = []): NotionProp => ({
  id: `id-${name}`,
  name,
  type,
  options: options.map((o) => ({ id: `o-${o}`, name: o })),
});

describe('parseProperties', () => {
  it('reads name/id/type and options of status, select and multi_select', () => {
    const props = parseProperties({
      object: 'data_source',
      properties: {
        Name: { id: 'title', name: 'Name', type: 'title', title: {} },
        S: {
          id: 'a',
          name: 'Stage',
          type: 'status',
          status: { options: [{ id: '1', name: 'Todo', color: 'red' }], groups: [] },
        },
        T: {
          id: 'b',
          type: 'select',
          select: { options: [{ id: '2', name: 'Bug' }, { bad: true }] },
        },
      },
    });
    expect(props).toEqual([
      { id: 'title', name: 'Name', type: 'title', options: [] },
      { id: 'a', name: 'Stage', type: 'status', options: [{ id: '1', name: 'Todo' }] },
      { id: 'b', name: 'T', type: 'select', options: [{ id: '2', name: 'Bug' }] },
    ]);
  });
  it('is undefined without a properties object; skips entries without a type', () => {
    expect(parseProperties(null)).toBeUndefined();
    expect(parseProperties({ properties: [] })).toBeUndefined();
    expect(parseProperties({ properties: { x: { name: 'x' } } })).toEqual([]);
  });
});

describe('findProp', () => {
  const props = [p('Branch name', 'rich_text'), p('Dup', 'text'), p('dup', 'text')];
  it('prefers exact, then unique normalized, flags ambiguity', () => {
    expect(findProp(props, 'Branch name')).toMatchObject({ exact: true });
    expect(findProp(props, '  branch   NAME ')).toMatchObject({
      exact: false,
      prop: { name: 'Branch name' },
    });
    expect(findProp(props, 'Dup')).toMatchObject({ exact: true });
    expect(findProp(props, 'DUP')).toHaveProperty('ambiguous');
    expect(findProp(props, 'nope')).toBeUndefined();
  });
});

describe('detectStatusProp (nts rules)', () => {
  it('auto: status type wins over a select named Status', () => {
    const r = detectStatusProp([p('Status', 'select'), p('Stage', 'status')], 'auto');
    expect(r).toMatchObject({ ok: true, via: 'status-type', prop: { name: 'Stage' } });
  });
  it('auto: falls back to select named Status (case/space-insensitive)', () => {
    const r = detectStatusProp([p('Name', 'title'), p(' STATUS ', 'select')], 'auto');
    expect(r).toMatchObject({ ok: true, via: 'select-named-status' });
  });
  it('auto: a select with another name is not a status', () => {
    expect(detectStatusProp([p('Type', 'select')], 'auto')).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });
  it('auto: two selects named Status (case variants) is ambiguous', () => {
    expect(detectStatusProp([p('Status', 'select'), p('status', 'select')], 'auto')).toEqual({
      ok: false,
      reason: 'ambiguous',
    });
  });
  it('configured name: found, wrong type, missing', () => {
    expect(detectStatusProp([p('Stage', 'status')], 'stage')).toMatchObject({
      ok: true,
      via: 'configured',
    });
    expect(detectStatusProp([p('Stage', 'rich_text')], 'Stage')).toMatchObject({
      ok: false,
      reason: 'wrong_type',
    });
    expect(detectStatusProp([p('Stage', 'status')], 'Nope')).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });
});

describe('detectTitleProp', () => {
  it('auto picks the title property; configured must be a title', () => {
    expect(detectTitleProp([p('Name', 'title')], 'auto')).toMatchObject({ ok: true });
    expect(detectTitleProp([p('Name', 'rich_text')], 'auto')).toMatchObject({
      ok: false,
      reason: 'not_found',
    });
    expect(detectTitleProp([p('Name', 'rich_text')], 'Name')).toMatchObject({
      ok: false,
      reason: 'wrong_type',
    });
    expect(detectTitleProp([p('Name', 'title')], 'name')).toMatchObject({ ok: true });
  });
});

describe('resolveOptions', () => {
  const opts = p('S', 'status', ['Backlog', 'Ready  to Test', 'Done']).options;
  it('resolves names case/whitespace-insensitively to ids', () => {
    const r = resolveOptions(opts, ['backlog', 'Ready to Test']);
    expect(r.resolved.map((x) => x.option.id)).toEqual(['o-Backlog', 'o-Ready  to Test']);
    expect(r.missing).toEqual([]);
    expect(r.unmapped.map((o) => o.name)).toEqual(['Done']);
  });
  it('reports missing and ambiguous', () => {
    const dup = p('S', 'status', ['Next Up', 'next up']).options;
    const r = resolveOptions(dup, ['NEXT UP', 'Gone']);
    expect(r.ambiguous).toEqual(['NEXT UP']);
    expect(r.missing).toEqual(['Gone']);
    expect(r.unmapped).toEqual([]);
  });
});
