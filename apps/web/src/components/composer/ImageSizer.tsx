import { RotateCcw } from 'lucide-react';
import {
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { findImages, type MdImage } from '@/lib/imageSize';
import { uploadSrc } from '@/lib/markdown';

const MIN_WIDTH = 40;
const MAX_WIDTH = 1600;

/**
 * Previews of the images in a comment being written, each with a corner handle to resize it, like GitLab's editor.
 * The size is written back into the markdown as GitLab's `{width=…}`, so it is kept when the comment is sent.
 */
export function ImageSizer({
  text,
  repo,
  disabled,
  onResize,
}: {
  text: string;
  repo: string;
  disabled?: boolean;
  /** `width` in pixels, or null for the original size. */
  onResize: (img: MdImage, width: number | null) => void;
}) {
  const images = findImages(text)
    .map((img) => ({ img, src: uploadSrc(img.url, repo) }))
    .filter((x): x is { img: MdImage; src: string } => x.src !== null);
  if (images.length === 0) return null;
  return (
    <div
      className="flex flex-wrap items-end gap-3 border-t border-hairline px-3 py-2.5"
      aria-label="Images in this comment"
    >
      {images.map(({ img, src }) => (
        <SizedThumb
          key={`${img.start}:${img.url}`}
          img={img}
          src={src}
          disabled={disabled ?? false}
          onResize={onResize}
        />
      ))}
    </div>
  );
}

function SizedThumb({
  img,
  src,
  disabled,
  onResize,
}: {
  img: MdImage;
  src: string;
  disabled: boolean;
  onResize: (img: MdImage, width: number | null) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState<number | null>(null);
  const [live, setLive] = useState<number | null>(null);
  const drag = useRef<{ x: number; w: number } | null>(null);
  const saved = img.width && /^\d+$/.test(img.width) ? Number(img.width) : null;
  const width = live ?? saved ?? natural;
  // Show the real pixel size, scaled into the strip so a big screenshot does not take over the box.
  const shown = width === null ? 160 : Math.min(width, 320);

  const onDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (disabled) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, w: width ?? box.current?.offsetWidth ?? 160 };
  };
  const onMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d) return;
    // The thumbnail is scaled down past 320 px: a pixel dragged there is worth more than one pixel.
    const scale = d.w > 320 ? d.w / 320 : 1;
    const next = Math.round(d.w + (e.clientX - d.x) * scale);
    setLive(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, next)));
  };
  const onUp = () => {
    if (!drag.current) return;
    drag.current = null;
    if (live !== null && live !== saved) onResize(img, live);
    setLive(null);
  };
  const onKey = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (disabled || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
    e.preventDefault();
    const step = e.shiftKey ? 50 : 10;
    const base = width ?? 160;
    const next = base + (e.key === 'ArrowRight' ? step : -step);
    onResize(img, Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, next)));
  };

  return (
    <figure className="grid gap-1">
      <div
        ref={box}
        className="relative rounded-control border border-hairline bg-muted"
        style={{ width: shown }}
      >
        <img
          src={src}
          alt={img.alt}
          draggable={false}
          className="block h-auto w-full rounded-control"
          onLoad={(e) => setNatural(e.currentTarget.naturalWidth || null)}
        />
        <button
          type="button"
          disabled={disabled}
          aria-label={`Resize ${img.alt || 'image'}: arrow keys change the width`}
          title="Drag to resize"
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          onKeyDown={onKey}
          className="absolute -right-1.5 -bottom-1.5 size-3.5 cursor-nwse-resize touch-none rounded-sm border border-background bg-primary shadow-rest focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-40"
        />
      </div>
      <figcaption className="flex items-center gap-1.5 text-2xs text-muted-foreground tabular-nums">
        <span>
          {width !== null ? `${width}px` : '…'}
          {saved === null && live === null && img.width === null ? ' · original' : ''}
          {img.width?.endsWith('%') && live === null ? ` · ${img.width}` : ''}
        </span>
        {(img.width !== null || img.height !== null) && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => onResize(img, null)}
            className="inline-flex items-center gap-0.5 hover:text-foreground"
            title="Back to the original size"
          >
            <RotateCcw className="size-3" aria-hidden /> Reset
          </button>
        )}
      </figcaption>
    </figure>
  );
}
