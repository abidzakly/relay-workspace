import { FileText, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { CardStartAttachment } from '@relay/shared';
import { toBase64 } from '@/lib/base64';

/** Files the agent opens: Start with agent, Make more changes, and the Cockpit chat. */
export const ATTACH_FILES_MAX = 10;
export const ATTACH_FILE_MAX_BYTES = 5 * 1024 * 1024;

export interface AttachFile {
  id: string;
  file: File;
  /** Object URL for an image thumbnail. */
  preview: string | null;
}

/** Adds files within the limits; `error` says what was left out (null when nothing). */
export function addFiles(
  current: readonly AttachFile[],
  list: Iterable<File>,
): { files: AttachFile[]; error: string | null } {
  const files = [...current];
  const problems: string[] = [];
  for (const file of list) {
    if (files.length >= ATTACH_FILES_MAX) {
      problems.push(`At most ${ATTACH_FILES_MAX} files.`);
      break;
    }
    if (file.size > ATTACH_FILE_MAX_BYTES) {
      problems.push(`${file.name || 'The pasted file'} is over 5 MB.`);
      continue;
    }
    if (file.size === 0) continue;
    files.push({
      id: `${file.name}-${file.size}-${file.lastModified}-${Math.random()}`,
      file,
      preview: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
    });
  }
  return { files, error: problems.length > 0 ? problems.join(' ') : null };
}

/** Removes one file and releases its thumbnail. */
export function removeFile(files: readonly AttachFile[], id: string): AttachFile[] {
  const f = files.find((x) => x.id === id);
  if (f?.preview) URL.revokeObjectURL(f.preview);
  return files.filter((x) => x.id !== id);
}

export function revokePreviews(files: readonly AttachFile[]): void {
  for (const f of files) if (f.preview) URL.revokeObjectURL(f.preview);
}

/** Thumbnails are object URLs: released when the component holding `files` unmounts. */
export function useRevokeOnUnmount(files: readonly AttachFile[]): void {
  const latest = useRef(files);
  latest.current = files;
  useEffect(() => () => revokePreviews(latest.current), []);
}

/** The files as the API takes them. Pasted screenshots come without a useful name. */
export async function toAttachments(files: readonly AttachFile[]): Promise<CardStartAttachment[]> {
  return Promise.all(
    files.map(async (f, n) => ({
      name: f.file.name && f.file.name !== 'image.png' ? f.file.name : `pasted-${n + 1}.png`,
      dataBase64: await toBase64(f.file),
    })),
  );
}

export const sizeLabel = (b: number) =>
  b >= 1024 * 1024
    ? `${(b / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(b / 1024))} KB`;

/** One row per file: thumbnail or file icon, name, size, remove. */
export function AttachmentList({
  files,
  onRemove,
  disabled,
}: {
  files: readonly AttachFile[];
  onRemove: (id: string) => void;
  disabled?: boolean;
}) {
  if (files.length === 0) return null;
  return (
    <ul className="grid gap-1">
      {files.map((f) => (
        <li
          key={f.id}
          className="flex items-center gap-2 border-t border-hairline pt-1 first:border-t-0 first:pt-0"
        >
          {f.preview ? (
            <img
              src={f.preview}
              alt=""
              className="size-8 shrink-0 rounded-control border border-hairline object-cover"
            />
          ) : (
            <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          )}
          <span className="min-w-0 flex-1 truncate text-xs">{f.file.name || 'Pasted image'}</span>
          <span className="shrink-0 font-mono text-2xs text-muted-foreground">
            {sizeLabel(f.file.size)}
          </span>
          <button
            type="button"
            aria-label={`Remove ${f.file.name || 'pasted image'}`}
            className="rounded-control p-1 text-muted-foreground hover:bg-accent/50 hover:text-foreground"
            disabled={disabled}
            onClick={() => onRemove(f.id)}
          >
            <X className="size-3.5" aria-hidden />
          </button>
        </li>
      ))}
    </ul>
  );
}
