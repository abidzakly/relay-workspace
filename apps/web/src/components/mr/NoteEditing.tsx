import { Loader2, Pencil, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { DiscussionNote } from '@relay/shared';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Composer, type Person } from '@/components/composer/Composer';
import { describeError } from '@/lib/api';
import { useDeleteNote, useEditNote } from '@/lib/mrApi';
import { useMyUsernames, useSettings } from '@/lib/settingsApi';

/**
 * Edit and delete for my own sent comments (MR drawer and Code Reviewer). Returns the pieces each note layout places
 * itself: the two icon buttons for the note's head, the editor that replaces the body while editing, and the
 * delete confirmation. Images and attachments stay: they are markdown links in the body, and the editor can add more.
 */
export function useNoteEditing({
  repo,
  iid,
  discussionId,
  note,
  people,
}: {
  repo: string;
  iid: number;
  discussionId: string;
  note: Pick<DiscussionNote, 'id' | 'author' | 'body'>;
  people?: readonly Person[];
}): { canChange: boolean; actions: ReactNode; editor: ReactNode; extra: ReactNode } {
  const me = useMyUsernames().data;
  const dryRun = useSettings().data?.dryRun ?? false;
  const edit = useEditNote(repo, iid);
  const del = useDeleteNote(repo, iid);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const canChange =
    note.id > 0 &&
    !!note.author &&
    !!me?.includes(note.author.toLowerCase()) &&
    !discussionId.startsWith('pending-');
  if (!canChange) return { canChange, actions: null, editor: null, extra: null };

  const busy = edit.isPending || del.isPending;
  const actions = (
    <span className="flex items-center">
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="size-7 p-0"
        aria-label="Edit comment"
        title="Edit comment"
        disabled={busy || editing}
        onClick={() => {
          edit.reset();
          setEditing(true);
        }}
      >
        <Pencil className="size-3.5" aria-hidden />
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="size-7 p-0 text-muted-foreground hover:text-destructive"
        aria-label="Delete comment"
        title="Delete comment"
        disabled={busy}
        onClick={() => {
          del.reset();
          setConfirming(true);
        }}
      >
        {del.isPending ? (
          <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden />
        ) : (
          <Trash2 className="size-3.5" aria-hidden />
        )}
      </Button>
    </span>
  );

  const editor = editing ? (
    <Composer
      repo={repo}
      iid={iid}
      people={people ?? []}
      initialValue={note.body}
      placeholder="Edit your comment… (markdown, paste or drop images)"
      submitLabel="Save"
      pending={edit.isPending}
      error={edit.error}
      autoFocus
      onCancel={() => setEditing(false)}
      onSubmit={(body, done) => {
        if (body.trim() === note.body.trim()) {
          setEditing(false);
          return;
        }
        edit.mutate(
          { discussionId, noteId: note.id, body },
          {
            onSuccess: () => {
              done();
              setEditing(false);
            },
          },
        );
      }}
    />
  ) : null;

  const extra = (
    <>
      {(edit.isSuccess && edit.data.dryRun) || (del.isSuccess && del.data.dryRun) ? (
        <p className="text-xs text-muted-foreground">
          Dry-run: simulated and logged in the audit log, nothing was sent to GitLab.
        </p>
      ) : null}
      {del.error && (
        <Alert variant="destructive">
          <AlertTitle>Delete failed</AlertTitle>
          <AlertDescription>{describeError(del.error)}</AlertDescription>
        </Alert>
      )}
      <Dialog open={confirming} onOpenChange={(o) => !del.isPending && setConfirming(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this comment?</DialogTitle>
            <DialogDescription>
              It is deleted on GitLab too, for everyone. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <p className="line-clamp-4 rounded-control bg-muted/60 p-2 text-sm whitespace-pre-wrap text-muted-foreground">
            {note.body}
          </p>
          {dryRun && (
            <Alert variant="warning">
              <AlertTitle>Dry-run is ON</AlertTitle>
              <AlertDescription>Nothing will be deleted on GitLab.</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={del.isPending}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              variant="destructive"
              disabled={del.isPending}
              onClick={() =>
                del.mutate(
                  { discussionId, noteId: note.id },
                  { onSettled: () => setConfirming(false) },
                )
              }
            >
              {del.isPending && <Loader2 className="size-4 motion-safe:animate-spin" />}
              {dryRun ? 'Simulate' : 'Delete comment'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );

  return { canChange, actions, editor, extra };
}
