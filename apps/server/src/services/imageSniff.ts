import type { UPLOAD_IMAGE_TYPES } from '@relay/shared';

type ImageType = (typeof UPLOAD_IMAGE_TYPES)[number];

const starts = (b: Buffer, sig: readonly number[], at = 0) =>
  b.length >= at + sig.length && sig.every((v, i) => b[at + i] === v);

/**
 * The image type the bytes really are (magic numbers), or null. Never trusts a file name or a declared type: what
 * is served or uploaded as an image must be one. SVG is never recognised (it can carry script).
 */
export function sniffImage(b: Buffer): ImageType | null {
  if (starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (starts(b, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (starts(b, [0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  if (starts(b, [0x52, 0x49, 0x46, 0x46]) && starts(b, [0x57, 0x45, 0x42, 0x50], 8))
    return 'image/webp';
  return null;
}
