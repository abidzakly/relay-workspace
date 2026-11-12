import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

/** What choosing the PTY engine gives up. Shown in Settings, before a start, and on every PTY job. */
export function PtyNotice() {
  return (
    <Alert variant="warning">
      <AlertTitle>Custom release command: this runs your real release script</AlertTitle>
      <AlertDescription>
        <ul className="list-disc space-y-1 pl-4">
          <li>
            It builds through frm, inside vu. This bypasses the dashboard&apos;s build queue, Drive
            upload and QA share, so no QA link comes out of it.
          </li>
          <li>
            There is no step-level resume. If vu stops, start again: vu picks up an open version MR
            by itself, but anything after a finished merge has to be done by hand.
          </li>
          <li>Notion cards are not updated: it runs with --no-notion-scan, which skips vcheck.</li>
          <li>It cannot run in dry-run, and it refuses repos that require version MR approval.</li>
          <li>
            Only Enter at vu&apos;s review prompt is sent. If vu asks for anything else, such as a
            token, the dashboard does not answer: cancel and fix the cause.
          </li>
        </ul>
      </AlertDescription>
    </Alert>
  );
}
