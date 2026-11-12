import { Check, Circle, Loader2 } from 'lucide-react';
import { isSigningFailure, type SigningFileStatus } from '@relay/shared';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { describeError } from '@/lib/api';
import { useSigningStatus, useUploadSigningFiles } from '@/lib/buildApi';

function FileLine({ file }: { file: SigningFileStatus }) {
  return (
    <li className="flex flex-wrap items-center gap-2">
      {file.present ? (
        <Check aria-hidden className="size-4" />
      ) : (
        <Circle aria-hidden className="size-4" />
      )}
      <span className="font-mono text-xs break-all">{file.path}</span>
      <span className="text-xs text-muted-foreground">{file.present ? 'in place' : 'missing'}</span>
    </li>
  );
}

/**
 * Shown under a build that failed on Android signing. The server puts each uploaded file where the repo expects it, so
 * nobody has to look for the bot clone on disk.
 */
export function SigningUpload({
  repo,
  error,
  next,
}: {
  repo: string;
  error: string | null;
  /** What to do once the files are in place. */
  next: string;
}) {
  const relevant = isSigningFailure(error);
  const status = useSigningStatus(repo, relevant);
  const upload = useUploadSigningFiles(repo);
  if (!relevant) return null;

  const data = status.data;
  const complete = data?.properties?.present === true && data.keystore?.present === true;
  return (
    <Alert variant="warning">
      <AlertTitle>
        {complete ? 'Signing files are in place' : 'Signing files are needed'}
      </AlertTitle>
      <AlertDescription className="grid gap-2">
        {status.isError && <p>{describeError(status.error)}</p>}
        {data && !data.supported && <p>{data.problem}</p>}
        {data?.supported && (
          <>
            <p>
              {complete
                ? `${next} If it fails on signing again, the password or the keystore is wrong: upload corrected files here.`
                : 'The build could not sign the app. These files are git-ignored, so the bot clone does not have them. Upload them here and they go to the right place.'}
            </p>
            <ul className="grid gap-1">
              {data.properties && <FileLine file={data.properties} />}
              {data.keystore ? (
                <FileLine file={data.keystore} />
              ) : (
                !data.problem && (
                  <li className="text-xs text-muted-foreground">
                    The keystore&apos;s name comes from {data.properties?.name}: select both, or
                    upload that one first.
                  </li>
                )
              )}
            </ul>
            {data.problem && <p>{data.problem}</p>}
            <div className="flex flex-wrap items-center gap-2">
              <Input
                type="file"
                multiple
                aria-label="Signing files"
                className="max-w-sm"
                disabled={upload.isPending}
                onChange={(e) => {
                  const files = [...(e.target.files ?? [])];
                  // Cleared so that picking the same file again, after fixing it, still fires.
                  e.target.value = '';
                  if (files.length > 0) upload.mutate(files);
                }}
              />
              {upload.isPending && <Loader2 className="size-4 motion-safe:animate-spin" />}
            </div>
            {upload.isError && <p className="text-destructive">{describeError(upload.error)}</p>}
          </>
        )}
      </AlertDescription>
    </Alert>
  );
}
