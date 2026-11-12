import type { CanvasTexture } from 'three';
import type { BoardColumn } from '../signals';
import {
  clip,
  finish,
  FONT,
  HAND,
  ISSUE_NOTE,
  NOTE_COLORS,
  surface,
  wrap,
} from '../scene/textures';

/**
 * Readable surfaces shared by the outdoor worlds, drawn with the 2D canvas (helpers in `scene/textures.ts`).
 * Far away they only have to read as "there is content"; the real page opens on click.
 */

/**
 * A notice board of the Board's columns: each column a heading with its count, and its first notes as pinned cards
 * (Issues in red). `paper` is the board's backing (cork, glass, chalk…).
 */
export function noticeTexture(
  columns: readonly BoardColumn[],
  opts: { backing: string; ink: string; heading: string; stowed: boolean },
): CanvasTexture {
  const W = 1024;
  const H = 704;
  const { canvas, ctx } = surface(W, H);
  ctx.fillStyle = opts.backing;
  ctx.fillRect(0, 0, W, H);
  if (opts.stowed) {
    ctx.fillStyle = '#fffbe6';
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.rotate(-0.06);
    ctx.fillRect(-260, -90, 520, 180);
    ctx.fillStyle = '#5b4636';
    ctx.font = `600 64px ${HAND}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Back soon', 0, 0);
    ctx.restore();
    return finish(canvas);
  }
  const shown = columns.slice(0, 6);
  const colW = W / Math.max(1, shown.length);
  shown.forEach((c, ci) => {
    const x = ci * colW;
    ctx.fillStyle = opts.heading;
    ctx.font = `700 30px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(clip(ctx, `${c.name} · ${c.count}`, colW - 16), x + colW / 2, 18);
    c.notes.slice(0, 4).forEach((n, ni) => {
      const issue = c.name === 'Issues';
      const color = issue ? ISSUE_NOTE : NOTE_COLORS[(ci + ni) % NOTE_COLORS.length]!;
      const nx = x + 14;
      const ny = 70 + ni * 155;
      const nw = colW - 28;
      ctx.save();
      ctx.translate(nx + nw / 2, ny + 70);
      ctx.rotate((((ci * 7 + ni * 3) % 5) - 2) * 0.012);
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      ctx.fillRect(-nw / 2 + 4, -66, nw, 136);
      ctx.fillStyle = color;
      ctx.fillRect(-nw / 2, -70, nw, 136);
      ctx.fillStyle = '#c0392b';
      ctx.beginPath();
      ctx.arc(0, -60, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = opts.ink;
      ctx.font = `500 24px ${HAND}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      wrap(ctx, n.title, nw - 20, 3).forEach((line, li) =>
        ctx.fillText(line, -nw / 2 + 10, -42 + li * 30),
      );
      ctx.restore();
    });
    if (c.count > 4) {
      ctx.fillStyle = opts.heading;
      ctx.font = `600 26px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText(`+${c.count - 4}`, x + colW / 2, H - 40);
    }
  });
  if (shown.length === 0) {
    ctx.fillStyle = opts.heading;
    ctx.font = `600 40px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Nothing on the board', W / 2, H / 2);
  }
  return finish(canvas);
}

/** An archery target face: gold, red, blue, black, white rings (scores are drawn by the arrows, not the face). */
export function archeryTexture(): CanvasTexture {
  const S = 512;
  const { canvas, ctx } = surface(S, S);
  const rings = [
    '#f4f1ea',
    '#f4f1ea',
    '#2b2f36',
    '#2b2f36',
    '#3f7ad9',
    '#3f7ad9',
    '#d6453d',
    '#d6453d',
    '#f6c94a',
    '#f6c94a',
  ];
  rings.forEach((c, i) => {
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.arc(S / 2, S / 2, (S / 2) * (1 - i / rings.length), 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = i < 4 ? '#7b7f86' : '#f4f1ea';
    ctx.lineWidth = 2;
    ctx.stroke();
  });
  ctx.fillStyle = '#2b2f36';
  ctx.beginPath();
  ctx.arc(S / 2, S / 2, 4, 0, Math.PI * 2);
  ctx.fill();
  return finish(canvas);
}

/** A small sign with a few lines of text (shop signs, gates, plates). */
export function signTexture(
  lines: readonly string[],
  opts: { bg: string; ink: string; width?: number; height?: number; size?: number },
): CanvasTexture {
  const W = opts.width ?? 512;
  const H = opts.height ?? 160;
  const { canvas, ctx } = surface(W, H);
  ctx.fillStyle = opts.bg;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = opts.ink;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const size = opts.size ?? 46;
  ctx.font = `700 ${size}px ${FONT}`;
  lines.forEach((l, i) =>
    ctx.fillText(clip(ctx, l, W - 24), W / 2, H / 2 + (i - (lines.length - 1) / 2) * size * 1.15),
  );
  return finish(canvas);
}
