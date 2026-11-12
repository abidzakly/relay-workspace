import type { UiNode, UiTree } from '@relay/shared';

/**
 * Parses `uiautomator dump` XML into the elements an AI tester can use. Pure.
 *
 * Kept: anything with a label (text or content-desc), anything tappable, scrollable, checkable or editable. Dropped:
 * zero-area nodes, empty layout wrappers, and the status/navigation bars (`com.android.systemui`), which are noise
 * on every screen. Flutter puts most labels in content-desc (its Semantics label), often with the text joined by
 * newlines; both are kept as they are.
 */

const NODE_RE = /<node\b([^>]*?)\/?>/g;
const ATTR_RE = /([\w-]+)="([^"]*)"/g;
const BOUNDS_RE = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/;

function unescapeXml(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

export function parseUiDump(xml: string): UiTree {
  const nodes: UiNode[] = [];
  let width = 0;
  let height = 0;
  let pkg: string | null = null;
  for (const m of xml.matchAll(NODE_RE)) {
    const a: Record<string, string> = {};
    for (const am of m[1]!.matchAll(ATTR_RE)) a[am[1]!] = unescapeXml(am[2]!);
    const b = BOUNDS_RE.exec(a.bounds ?? '');
    if (!b) continue;
    const bounds: [number, number, number, number] = [
      Number(b[1]),
      Number(b[2]),
      Number(b[3]),
      Number(b[4]),
    ];
    width = Math.max(width, bounds[2]);
    height = Math.max(height, bounds[3]);
    const nodePkg = a.package ?? '';
    // The first non-systemui node belongs to the foreground window.
    if (!pkg && nodePkg && nodePkg !== 'com.android.systemui') pkg = nodePkg;
    if (nodePkg === 'com.android.systemui') continue;
    if (bounds[2] - bounds[0] <= 0 || bounds[3] - bounds[1] <= 0) continue;
    const text = (a.text ?? '').trim();
    const desc = (a['content-desc'] ?? '').trim();
    const cls = a.class ?? '';
    const clickable = a.clickable === 'true' || a['long-clickable'] === 'true';
    const scrollable = a.scrollable === 'true';
    const checkable = a.checkable === 'true';
    const editable = /EditText/.test(cls);
    if (!text && !desc && !clickable && !scrollable && !checkable && !editable) continue;
    nodes.push({
      n: nodes.length,
      text,
      desc,
      resourceId: a['resource-id'] ?? '',
      cls,
      pkg: nodePkg,
      bounds,
      clickable,
      scrollable,
      focused: a.focused === 'true',
      enabled: a.enabled !== 'false',
      checked: checkable ? a.checked === 'true' : null,
      selected: a.selected === 'true',
      password: a.password === 'true',
    });
  }
  return { nodes, width, height, pkg };
}

/** The label a person would read: text, else content-desc, newlines folded. */
export function nodeLabel(n: UiNode): string {
  return (n.text || n.desc).replace(/\s*\n+\s*/g, ' / ').trim();
}

export function nodeCenter(n: UiNode): { x: number; y: number } {
  return {
    x: Math.round((n.bounds[0] + n.bounds[2]) / 2),
    y: Math.round((n.bounds[1] + n.bounds[3]) / 2),
  };
}

/** A stable fingerprint of what is on screen, to tell "the screen settled" and "the action changed nothing". */
export function treeSignature(t: UiTree): string {
  return t.nodes
    .map((n) => `${n.cls}|${n.text}|${n.desc}|${n.bounds.join(',')}|${n.checked}|${n.focused}`)
    .join('\n');
}
