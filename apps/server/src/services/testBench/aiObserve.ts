import type { DiffFile, UiNode, UiTree } from '@relay/shared';
import { nodeCenter, nodeLabel } from '../device/uiTree';

/**
 * What the AI tester reads ("tools do the hard parts"). Pure. A fast model is good at choosing
 * the next step from text and bad at guessing pixel positions, so the screen is handed over as a numbered element
 * list, every action reports what changed, and app errors are surfaced without the model having to look for them.
 */

function role(n: UiNode): string {
  if (/EditText/.test(n.cls)) return 'field';
  if (n.checked !== null) return n.checked ? 'checkbox[on]' : 'checkbox[off]';
  if (/Switch/.test(n.cls)) return 'switch';
  if (n.scrollable) return 'scroll-area';
  if (n.clickable) return 'button';
  if (/ImageView|Image/.test(n.cls)) return 'image';
  return 'text';
}

function line(n: UiNode): string {
  const label = nodeLabel(n);
  const { x, y } = nodeCenter(n);
  const flags = [
    n.focused ? 'focused' : '',
    !n.enabled ? 'disabled' : '',
    n.selected ? 'selected' : '',
    n.password ? 'password' : '',
  ].filter(Boolean);
  const id = n.resourceId ? ` id=${n.resourceId.replace(/^.*:id\//, '')}` : '';
  const shown = label
    ? `"${label.length > 120 ? `${label.slice(0, 117)}…` : label}"`
    : `(no label${id ? `,${id.trim()}` : ''})`;
  return `[${n.n}] ${role(n)} ${shown}${label ? id : ''}${flags.length ? ` {${flags.join(', ')}}` : ''} @${x},${y}`;
}

/** The screen as numbered lines, top to bottom. */
export function formatScreen(t: UiTree): string {
  const head = `Screen ${t.width}x${t.height}, app in front: ${t.pkg ?? 'unknown'}, ${t.nodes.length} elements.`;
  if (!t.nodes.length) {
    return `${head}\nNo readable elements (the app draws without Semantics, or is still loading). Use screenshot + pixel tap.`;
  }
  const unlabeled = t.nodes.filter((n) => n.clickable && !nodeLabel(n)).length;
  const lines = t.nodes.map(line);
  return [
    head,
    ...lines,
    unlabeled
      ? `${unlabeled} tappable element(s) have no label (icons): check the screenshot to tell what they are.`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}

const labels = (t: UiTree) => new Set(t.nodes.map(nodeLabel).filter(Boolean));

/** "Did my action do anything, and what?" in one line or three. */
export function diffScreens(
  before: UiTree | null,
  after: UiTree,
  sigBefore: string | null,
  sigAfter: string,
): string {
  if (!before || sigBefore === null) return 'Screen read.';
  if (sigBefore === sigAfter) {
    return 'NOTHING CHANGED on screen. The tap may have missed, the element may be disabled, or the app is still working (try wait_for).';
  }
  const a = labels(before);
  const b = labels(after);
  const appeared = [...b].filter((x) => !a.has(x));
  const gone = [...a].filter((x) => !b.has(x));
  const cap = (xs: string[]) =>
    xs
      .slice(0, 12)
      .map((x) => `"${x.length > 60 ? `${x.slice(0, 57)}…` : x}"`)
      .join(', ') + (xs.length > 12 ? ` …+${xs.length - 12}` : '');
  const parts = ['Screen changed.'];
  if (before.pkg !== after.pkg) parts.push(`App in front is now ${after.pkg ?? 'unknown'}.`);
  if (appeared.length) parts.push(`Appeared: ${cap(appeared)}.`);
  if (gone.length) parts.push(`Gone: ${cap(gone)}.`);
  if (!appeared.length && !gone.length)
    parts.push('Same labels, different layout or state (scroll, focus, toggle).');
  return parts.join(' ');
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** Elements whose label contains `text` (case and whitespace ignored). */
export function findText(t: UiTree, text: string): UiNode[] {
  const q = norm(text);
  return t.nodes.filter((n) => norm(`${n.text} ${n.desc}`).includes(q));
}

// eslint-disable-next-line no-control-regex -- matching terminal escapes is the point
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
const ERROR_RE =
  /EXCEPTION CAUGHT BY|Unhandled Exception|Another exception was thrown|overflowed by|E\/flutter|FATAL EXCEPTION|Lost connection to device|Null check operator|setState\(\) called after dispose/;

/** Error lines in a chunk of `flutter run` output, each with the line after it (the message). */
export function flutterErrorLines(chunk: string): string[] {
  const lines = chunk.replace(ANSI_RE, '').split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length && out.length < 15; i++) {
    const l = lines[i]!.trim();
    if (!ERROR_RE.test(l)) continue;
    const next = (lines[i + 1] ?? '').trim();
    const msg = /EXCEPTION CAUGHT BY/.test(l) && next && !/^═+$/.test(next) ? ` ${next}` : '';
    // The message line is folded into the header: do not report it again on its own.
    if (msg) i++;
    const s = `${l}${msg}`.replace(/[═╡╞]+/g, '').trim();
    if (s && !out.includes(s)) out.push(s.slice(0, 300));
  }
  return out;
}

const STRING_RE = /(['"])((?:(?!\1)[^\\\n]|\\.){2,80})\1/g;
const KEY_RE = /(?:Value)?Key\(\s*['"]([^'"]{1,80})['"]\s*\)/g;
const ROUTE_RE = /['"](\/[a-z0-9_\-/:]{1,60})['"]/gi;
const WIDGET_RE =
  /class\s+(\w+)\s+extends\s+(?:StatelessWidget|StatefulWidget|ConsumerWidget|HookWidget|ConsumerStatefulWidget)/g;
const ARB_RE = /^\s*"(?!@)[\w.]+"\s*:\s*"([^"]{1,120})"/;

/**
 * What the branch adds that the tester can look for on screen: changed files, user-facing strings, widget keys,
 * routes and screens, read from the added lines of the diff. The tester runs without the source, so this is how it
 * learns the labels before it touches the phone.
 */
export function branchHints(files: DiffFile[]) {
  const changed = files
    .filter((f) => !/\.(g|freezed|mocks)\.dart$|pubspec\.lock|\.(png|jpg|svg|ttf)$/.test(f.path))
    .map((f) => `${f.path} (+${f.additions} -${f.deletions})`)
    .slice(0, 60);
  const strings = new Set<string>();
  const keys = new Set<string>();
  const routes = new Set<string>();
  const screens = new Set<string>();
  for (const f of files) {
    if (!f.diff) continue;
    const isDart = f.path.endsWith('.dart') && !/\.(g|freezed|mocks)\.dart$/.test(f.path);
    const isArb = f.path.endsWith('.arb') || /l10n|i18n|translations/.test(f.path);
    if (!isDart && !isArb) continue;
    for (const raw of f.diff.split('\n')) {
      if (!raw.startsWith('+') || raw.startsWith('+++')) continue;
      const l = raw.slice(1);
      if (isArb) {
        const m = ARB_RE.exec(l);
        if (m) strings.add(m[1]!);
        continue;
      }
      if (/^\s*(import|export|part)\b|^\s*\/\//.test(l)) continue;
      for (const m of l.matchAll(KEY_RE)) keys.add(m[1]!);
      for (const m of l.matchAll(ROUTE_RE)) routes.add(m[1]!);
      for (const m of l.matchAll(WIDGET_RE)) screens.add(m[1]!);
      for (const m of l.matchAll(STRING_RE)) {
        const s = m[2]!;
        // User-facing text has a letter and a space or a capital, and is not a path, id or interpolation-only.
        if (/^[a-z_]+$|^[\w.]+\.[a-z]{2,4}$|^\$|^https?:|^[/#]|^\w+:\w+/.test(s)) continue;
        if (!/[A-Za-z]/.test(s) || !(/\s/.test(s) || /^[A-Z]/.test(s))) continue;
        strings.add(s.replace(/\$\{?\w+(\.\w+)*\}?/g, '…'));
      }
    }
  }
  const take = (s: Set<string>, n: number) => [...s].slice(0, n);
  return {
    changedFiles: changed,
    newTexts: take(strings, 60),
    widgetKeys: take(keys, 40),
    routes: take(routes, 20),
    widgets: take(screens, 30),
  };
}
