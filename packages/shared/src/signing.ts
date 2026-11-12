import { z } from 'zod';

/** A keystore is a few KB. The cap keeps the base64 body inside the dashboard's 1 MB request limit. */
export const SIGNING_FILE_MAX_BYTES = 512 * 1024;

export const SigningFileStatusSchema = z.object({
  /** The exact file name an upload must have. */
  name: z.string(),
  /** Relative to the clone. */
  path: z.string(),
  present: z.boolean(),
});
export type SigningFileStatus = z.infer<typeof SigningFileStatusSchema>;

/** Answer of `GET /api/builds/signing/:repo`. Holds names and paths only, never a file's contents. */
export const SigningStatusSchema = z.object({
  /** False when the repo's Gradle files do not read a signing properties file: uploading cannot help. */
  supported: z.boolean(),
  properties: SigningFileStatusSchema.nullable(),
  /** Null until the properties file says where the keystore goes. */
  keystore: SigningFileStatusSchema.nullable(),
  /** Why the files cannot be placed or used as they are, in plain words. */
  problem: z.string().nullable(),
});
export type SigningStatus = z.infer<typeof SigningStatusSchema>;

export const SigningUploadRequestSchema = z
  .object({
    fileName: z.string().min(1).max(255),
    contentBase64: z
      .string()
      .min(1)
      .max(Math.ceil(SIGNING_FILE_MAX_BYTES / 3) * 4),
  })
  .strict();
export type SigningUploadRequest = z.infer<typeof SigningUploadRequestSchema>;

const SIGNING_FAILURES: readonly RegExp[] = [
  /SigningConfig "[^"]*" is missing required property/i,
  /Keystore file (?:\S+ )?not (?:found|set)/i,
  /Keystore was tampered with|password was incorrect/i,
  /Failed to read key \S+ from store/i,
  /key[^\s/]*\.properties \(No such file or directory\)/i,
];

/** Whether a failed build's error says its Android signing files are missing or wrong. */
export function isSigningFailure(error: string | null | undefined): boolean {
  return error != null && SIGNING_FAILURES.some((pattern) => pattern.test(error));
}
