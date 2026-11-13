import { z } from 'zod';

/**
 * Reader: a small library of Markdown / plain-text documents kept on the server, read in a calm column on any device.
 */

/** One document's text is at most this long (characters). */
export const READER_BODY_MAX = 1_000_000;
export const READER_FORMATS = ['md', 'txt'] as const;
export const ReaderFormatSchema = z.enum(READER_FORMATS);
export type ReaderFormat = z.infer<typeof ReaderFormatSchema>;

export const ReaderDocSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  format: ReaderFormatSchema,
  /** Characters in the body: shown as a reading-time hint. */
  size: z.number().int(),
  /** Where the reader left off, 0–1 of the page height. */
  lastPos: z.number().min(0).max(1),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type ReaderDocSummary = z.infer<typeof ReaderDocSummarySchema>;

export const ReaderDocSchema = ReaderDocSummarySchema.extend({ body: z.string() });
export type ReaderDoc = z.infer<typeof ReaderDocSchema>;

export const ReaderCreateSchema = z.object({
  title: z.string().trim().min(1).max(200),
  format: ReaderFormatSchema.default('md'),
  body: z.string().max(READER_BODY_MAX),
});
export type ReaderCreate = z.input<typeof ReaderCreateSchema>;

export const ReaderUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    format: ReaderFormatSchema,
    body: z.string().max(READER_BODY_MAX),
    lastPos: z.number().min(0).max(1),
  })
  .partial();
export type ReaderUpdate = z.infer<typeof ReaderUpdateSchema>;

export const ReaderIdParamSchema = z.object({ id: z.string().regex(/^[a-f0-9-]{36}$/) });

/** A title from the document itself: its first heading or line, else the file name. */
export function readerTitleOf(body: string, fallback = 'Untitled'): string {
  const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/m.exec(body)?.[1];
  const firstLine = body
    .split('\n')
    .find((l) => l.trim())
    ?.trim();
  return (heading ?? firstLine ?? fallback).slice(0, 200) || fallback;
}
