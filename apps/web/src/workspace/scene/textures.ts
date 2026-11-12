import { CanvasTexture, SRGBColorSpace } from 'three';
import type { EnvId } from '../envFor';
import type { SceneData } from '../signals';
import { TONE_COLOR, TONE_INK } from './palette';

/**
 * The worlds' readable surfaces (screens, boards, calendars), drawn with the 2D canvas (the browser's own text shaping and font fallback), then
 * used as textures. Each is redrawn only when its data changes. Text far away only has to read as "there is content";
 * the real page opens on click.
 */
export const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';

export function surface(width: number, height: number) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  return { canvas, ctx };
}

export function finish(canvas: HTMLCanvasElement): CanvasTexture {
  const t = new CanvasTexture(canvas);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export function clip(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > max) t = t.slice(0, -1);
  return `${t}…`;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fill();
}

/** A screen showing a miniature MR Inbox (the terminals of the worlds). */
export function screenTexture(data: SceneData, stowed: boolean): CanvasTexture {
  const { canvas, ctx } = surface(512, 320);
  const sig = data.signals.monitor;
  ctx.fillStyle = stowed ? '#10131a' : '#162033';
  ctx.fillRect(0, 0, 512, 320);
  if (stowed) {
    ctx.fillStyle = '#5c6478';
    ctx.font = `600 26px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText('Off duty', 256, 150);
    ctx.font = `20px ${FONT}`;
    ctx.fillText(sig.badge ? `${sig.badge} waiting · tap to open` : 'Nothing waiting', 256, 186);
    return finish(canvas);
  }
  // Title bar
  ctx.fillStyle = '#22304a';
  ctx.fillRect(0, 0, 512, 54);
  ctx.fillStyle = '#e8eefb';
  ctx.font = `700 26px ${FONT}`;
  ctx.fillText('MR Inbox', 22, 37);
  if (sig.badge) {
    ctx.fillStyle = TONE_COLOR[sig.tone];
    roundRect(ctx, 404, 11, 88, 32, 16);
    ctx.fillStyle = TONE_INK[sig.tone];
    ctx.font = `700 20px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText(String(sig.badge), 448, 34);
    ctx.textAlign = 'left';
  }
  const titles = data.mrTitles.length ? data.mrTitles : ['No open MR of yours'];
  titles.slice(0, 4).forEach((title, i) => {
    const y = 70 + i * 60;
    ctx.fillStyle = i === 0 && sig.badge ? '#2b3d5e' : '#1d2a42';
    roundRect(ctx, 14, y, 484, 50, 10);
    ctx.fillStyle = i === 0 ? TONE_COLOR[sig.tone] : '#5f7598';
    roundRect(ctx, 26, y + 17, 16, 16, 8);
    ctx.fillStyle = '#d4dcec';
    ctx.font = `20px ${FONT}`;
    ctx.fillText(clip(ctx, title, 430), 54, y + 32);
  });
  return finish(canvas);
}

/** How each world dresses its Code Review gateway: same data, its own story. */
interface GatewayTheme {
  title: string;
  bg: string;
  bar: string;
  ink: string;
  muted: string;
  row: string;
  rowOn: string;
  font: string;
  /** Departure-board rows (Trip): a status tag on the right of each title. */
  tag: string | null;
}

const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

export const GATEWAY_THEME: Record<EnvId, GatewayTheme> = {
  home: {
    title: "Developer's Workshop",
    bg: '#1d1915',
    bar: '#2e261e',
    ink: '#f3e6d2',
    muted: '#a48f74',
    row: '#29221b',
    rowOn: '#3a2f24',
    font: FONT,
    tag: null,
  },
  office: {
    title: 'Review Chamber',
    bg: '#0d1a24',
    bar: '#12293a',
    ink: '#d8f3ff',
    muted: '#6fa6c2',
    row: '#112433',
    rowOn: '#173a52',
    font: FONT,
    tag: null,
  },
  trip: {
    title: 'DISPATCH · REVIEWS',
    bg: '#0c0d10',
    bar: '#17181d',
    ink: '#ffd36b',
    muted: '#9a8550',
    row: '#141519',
    rowOn: '#1d1e24',
    font: MONO,
    tag: 'BOARDING',
  },
  sick: {
    title: 'Quiet Review',
    bg: '#16141b',
    bar: '#1f1c26',
    ink: '#c9c0d8',
    muted: '#7d7590',
    row: '#1c1923',
    rowOn: '#24202d',
    font: FONT,
    tag: null,
  },
  leave: {
    title: 'Signal Station',
    bg: '#0f1a1c',
    bar: '#152629',
    ink: '#cdeee9',
    muted: '#6d9b95',
    row: '#132225',
    rowOn: '#1a2f33',
    font: FONT,
    tag: null,
  },
};

/**
 * The Code Review gateway's screen: the reviews requested of me over a stylised diff (gutter bars only, no fake
 * code), dressed per world. Off duty the screen dims and asks nothing.
 */
export function reviewTexture(data: SceneData, env: EnvId, stowed: boolean): CanvasTexture {
  const W = 384;
  const H = 288;
  const { canvas, ctx } = surface(W, H);
  const t = GATEWAY_THEME[env];
  const sig = data.signals.review;
  const { titles, count } = data.reviews;
  ctx.fillStyle = t.bg;
  ctx.fillRect(0, 0, W, H);

  // The diff motif: paired removed / added bars with +/- gutters, so the object reads as "code review".
  const rows: ('ctx' | 'del' | 'add')[] = ['ctx', 'del', 'add', 'add', 'ctx', 'ctx', 'del', 'add'];
  const top = count > 0 && !stowed ? 168 : 74;
  ctx.globalAlpha = stowed ? 0.3 : 0.9;
  rows.forEach((kind, i) => {
    const y = top + i * 14;
    if (y + 10 > H - 34) return;
    const tint = kind === 'add' ? '#1f4a35' : kind === 'del' ? '#4d2630' : t.row;
    const ink = kind === 'add' ? '#5fd39a' : kind === 'del' ? '#f07b8b' : t.muted;
    ctx.fillStyle = tint;
    ctx.fillRect(14, y, W - 28, 12);
    ctx.fillStyle = ink;
    ctx.fillRect(20, y + 5, 6, 2);
    if (kind === 'add') ctx.fillRect(22, y + 3, 2, 6);
    ctx.fillRect(36, y + 4, 40 + ((i * 53) % 150), 4);
  });
  ctx.globalAlpha = 1;

  ctx.fillStyle = t.bar;
  ctx.fillRect(0, 0, W, 52);
  ctx.fillStyle = stowed ? t.muted : t.ink;
  ctx.font = `700 ${t.font === MONO ? 19 : 22}px ${t.font}`;
  ctx.fillText(clip(ctx, t.title, W - 100), 18, 34);
  if (count > 0) {
    ctx.fillStyle = stowed ? t.muted : TONE_COLOR[sig.tone];
    roundRect(ctx, W - 74, 11, 58, 30, 15);
    ctx.fillStyle = '#fff';
    ctx.font = `700 18px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText(count > 99 ? '99+' : String(count), W - 45, 32);
    ctx.textAlign = 'left';
  }

  ctx.font = `17px ${t.font}`;
  if (stowed) {
    ctx.fillStyle = t.muted;
    ctx.fillText('Off duty · open any time', 18, H - 16);
    return finish(canvas);
  }
  if (count === 0) {
    ctx.fillStyle = t.muted;
    ctx.fillText(t.tag ? 'NO DEPARTURES PENDING' : 'Nothing requested of you', 18, H - 16);
    return finish(canvas);
  }
  titles.forEach((title, i) => {
    const y = 62 + i * 34;
    ctx.fillStyle = i === 0 ? t.rowOn : t.row;
    roundRect(ctx, 12, y, W - 24, 28, 8);
    ctx.fillStyle = i === 0 ? TONE_COLOR[sig.tone] : t.muted;
    roundRect(ctx, 22, y + 9, 10, 10, 5);
    ctx.fillStyle = t.ink;
    ctx.font = `${t.font === MONO ? 15 : 17}px ${t.font}`;
    const room = W - 74 - (t.tag ? 92 : 0);
    ctx.fillText(clip(ctx, t.font === MONO ? title.toUpperCase() : title, room), 42, y + 20);
    if (t.tag) {
      ctx.fillStyle = TONE_COLOR[sig.tone];
      ctx.font = `700 12px ${MONO}`;
      ctx.textAlign = 'right';
      ctx.fillText(t.tag, W - 22, y + 19);
      ctx.textAlign = 'left';
    }
  });
  return finish(canvas);
}

export const NOTE_COLORS = [
  '#ffe680',
  '#ffd0a1',
  '#c9f0a8',
  '#a8dcf0',
  '#f7b6d2',
  '#d9c8f5',
  '#ff9d9d',
];
export const ISSUE_NOTE = '#ff9d9d';

export const HAND = '"Marker Felt", "Comic Sans MS", "Chalkboard SE", "Segoe Print", cursive';

/** Splits a title into at most `lines` lines that fit `width`, ellipsing the last when the title runs on. */
export function wrap(
  ctx: CanvasRenderingContext2D,
  text: string,
  width: number,
  lines: number,
): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let line = '';
  let i = 0;
  for (; i < words.length; i++) {
    const next = line ? `${line} ${words[i]}` : words[i]!;
    if (ctx.measureText(next).width <= width) {
      line = next;
      continue;
    }
    if (line) out.push(line);
    line = words[i]!;
    if (out.length === lines) break;
  }
  if (out.length < lines && line) {
    out.push(line);
    line = '';
  }
  const last = out.length - 1;
  if (last < 0) return out;
  const more = i < words.length || line !== '';
  out[last] = clip(ctx, more ? `${out[last]!}…` : out[last]!, width);
  return out;
}
