/**
 * GitLab's image size syntax in comments: `![alt](url){width=300 height=200}` (also `width=50%`). Pure helpers for
 * finding images in a comment's markdown and rewriting their size, so the composer can resize them like GitLab.
 */

/** A size value GitLab accepts and we pass on as an `<img>` attribute: pixels or a percentage. */
export const SIZE_VALUE_RE = /^\d{1,4}%?$/;

export interface MdImage {
  /** Range of the whole image, size block included, in the text. */
  start: number;
  end: number;
  alt: string;
  url: string;
  /** ` "title"` as written, or ''. */
  title: string;
  width: string | null;
  height: string | null;
}

const IMG_RE = /!\[([^\]\n]*)\]\(([^()\s]+)((?:\s+"[^"\n]*")?)\)(\{[^}\n]*\})?/g;

/** `width` / `height` from a `{…}` block; invalid values are ignored. */
export function sizeAttrs(block: string | undefined): {
  width: string | null;
  height: string | null;
} {
  const read = (name: string): string | null => {
    const m = new RegExp(`(?:^|[\\s{])${name}\\s*=\\s*"?([^"\\s}]+)"?`).exec(block ?? '');
    return m && SIZE_VALUE_RE.test(m[1]!) ? m[1]! : null;
  };
  return { width: read('width'), height: read('height') };
}

/** Every image in the text, in order. Upload placeholders (`![Uploading x…]()`) have no URL and are skipped. */
export function findImages(text: string): MdImage[] {
  const out: MdImage[] = [];
  for (const m of text.matchAll(IMG_RE)) {
    out.push({
      start: m.index,
      end: m.index + m[0].length,
      alt: m[1]!,
      url: m[2]!,
      title: m[3] ?? '',
      ...sizeAttrs(m[4]),
    });
  }
  return out;
}

/** The image's markdown at `width` pixels (height follows the aspect ratio); null = original size. */
export function sizedImage(img: MdImage, width: number | null): string {
  const base = `![${img.alt}](${img.url}${img.title})`;
  return width === null ? base : `${base}{width=${Math.round(width)}}`;
}
