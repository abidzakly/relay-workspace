import { ArrowLeft, BookOpen, FileUp, List, Pencil, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import { useSearchParams } from 'react-router';
import { readerTitleOf, READER_BODY_MAX, type ReaderDoc, type ReaderFormat } from '@relay/shared';
import { PageTitle } from '@/components/PageTitle';
import { TimeAgo } from '@/components/TimeAgo';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { describeError } from '@/lib/api';
import {
  saveReaderPos,
  useCreateReaderDoc,
  useDeleteReaderDoc,
  useReaderDoc,
  useReaderList,
  useUpdateReaderDoc,
} from '@/lib/readerApi';
import { cn } from '@/lib/utils';
import { ReaderBody, type Heading } from '@/reader/ReaderBody';

/** About 230 words a minute, 6 characters a word. */
const minutesOf = (chars: number) => Math.max(1, Math.round(chars / 6 / 230));

const formatOf = (name: string): ReaderFormat =>
  /\.(md|markdown|mdx)$/i.test(name) ? 'md' : 'txt';

/**
 * Reader: a library of Markdown / text documents kept on the server, read in one calm column with a table of contents,
 * highlighted code (Wake and Dream) and the place you left off. `?doc=<id>` opens one.
 */
export function Reader() {
  const [params, setParams] = useSearchParams();
  const id = params.get('doc');
  const open = (next: string | null) => setParams(next ? { doc: next } : {});
  return id ? <ReadView id={id} onBack={() => open(null)} /> : <Library onOpen={open} />;
}

function Library({ onOpen }: { onOpen: (id: string) => void }) {
  const list = useReaderList();
  const remove = useDeleteReaderDoc();
  const [composing, setComposing] = useState(false);
  return (
    <div className="mx-auto grid w-full max-w-3xl gap-6">
      <PageTitle
        accent={
          <Button size="sm" onClick={() => setComposing((c) => !c)}>
            <Plus className="size-4" /> New
          </Button>
        }
      >
        Reader
      </PageTitle>
      {composing && (
        <NewDoc
          onCreated={(id) => {
            setComposing(false);
            onOpen(id);
          }}
          onCancel={() => setComposing(false)}
        />
      )}
      {list.isError && (
        <Alert variant="destructive">
          <AlertDescription>{describeError(list.error)}</AlertDescription>
        </Alert>
      )}
      {list.data?.length === 0 && !composing && (
        <div className="grid justify-items-center gap-3 rounded-surface border border-dashed p-10 text-center text-sm text-muted-foreground">
          <BookOpen className="size-6" aria-hidden />
          <p>Nothing to read yet. Paste some Markdown or open a .md / .txt file.</p>
          <Button variant="outline" onClick={() => setComposing(true)}>
            <Plus className="size-4" /> New document
          </Button>
        </div>
      )}
      <ul className="grid gap-2">
        {list.data?.map((d) => (
          <li
            key={d.id}
            className="group flex items-center gap-3 rounded-surface border bg-card px-4 py-3"
          >
            <button
              type="button"
              onClick={() => onOpen(d.id)}
              className="grid min-w-0 flex-1 gap-1 text-left"
            >
              <span className="truncate text-base font-medium">{d.title}</span>
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <Badge variant="outline">{d.format === 'md' ? 'Markdown' : 'Text'}</Badge>
                <span>{minutesOf(d.size)} min read</span>
                {d.lastPos > 0.02 && <span>{Math.round(d.lastPos * 100)}% read</span>}
                <TimeAgo at={d.updatedAt} />
              </span>
            </button>
            <Button
              size="icon"
              variant="ghost"
              aria-label={`Delete ${d.title}`}
              disabled={remove.isPending}
              onClick={() => {
                if (window.confirm(`Delete “${d.title}”?`)) remove.mutate(d.id);
              }}
            >
              <Trash2 className="size-4" />
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function NewDoc({
  onCreated,
  onCancel,
}: {
  onCreated: (id: string) => void;
  onCancel: () => void;
}) {
  const create = useCreateReaderDoc();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [format, setFormat] = useState<ReaderFormat>('md');
  const [fileError, setFileError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    if (f.size > READER_BODY_MAX) {
      setFileError('That file is too large to keep (1 MB of text at most).');
      return;
    }
    setFileError(null);
    void f.text().then((text) => {
      setBody(text);
      setFormat(formatOf(f.name));
      setTitle((t) => t || readerTitleOf(text, f.name.replace(/\.[^.]+$/, '')));
    });
  };

  const save = () =>
    create.mutate(
      { title: title.trim() || readerTitleOf(body), format, body },
      { onSuccess: (d) => onCreated(d.id) },
    );

  return (
    <div className="grid gap-3 rounded-surface border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Title (optional: taken from the first heading)"
          className="min-w-0 flex-1"
        />
        <input
          ref={file}
          type="file"
          accept=".md,.markdown,.mdx,.txt,text/markdown,text/plain"
          className="hidden"
          onChange={onFile}
        />
        <Button variant="outline" onClick={() => file.current?.click()}>
          <FileUp className="size-4" /> Open file
        </Button>
      </div>
      <Textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Paste Markdown or plain text…"
        className="min-h-48 font-mono text-sm"
      />
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1" role="radiogroup" aria-label="Format">
          {(['md', 'txt'] as const).map((f) => (
            <Button
              key={f}
              size="sm"
              variant={format === f ? 'default' : 'outline'}
              role="radio"
              aria-checked={format === f}
              onClick={() => setFormat(f)}
            >
              {f === 'md' ? 'Markdown' : 'Plain text'}
            </Button>
          ))}
        </div>
        <span className="ml-auto" />
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button disabled={!body.trim() || create.isPending} onClick={save}>
          Save and read
        </Button>
      </div>
      {(fileError || create.isError) && (
        <p className="text-sm text-destructive">{fileError ?? describeError(create.error)}</p>
      )}
    </div>
  );
}

/** 0–1 of the page scrolled. */
const scrolled = () => {
  const max = document.documentElement.scrollHeight - window.innerHeight;
  return max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
};

function ReadView({ id, onBack }: { id: string; onBack: () => void }) {
  const doc = useReaderDoc(id);
  const [editing, setEditing] = useState(false);
  const [headings, setHeadings] = useState<Heading[]>([]);
  const onHeadings = useCallback((h: Heading[]) => setHeadings(h), []);

  if (doc.isError) {
    return (
      <div className="mx-auto grid w-full max-w-3xl gap-4">
        <BackLink onBack={onBack} />
        <Alert variant="destructive">
          <AlertDescription>{describeError(doc.error)}</AlertDescription>
        </Alert>
      </div>
    );
  }
  if (!doc.data) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const d = doc.data;
  return (
    <div className="mx-auto w-full max-w-5xl">
      <Progress key={d.id} doc={d} paused={editing} />
      <div className="mb-6 flex flex-wrap items-center gap-2">
        <BackLink onBack={onBack} />
        <span className="ml-auto" />
        {!editing && headings.length > 1 && <MobileToc headings={headings} />}
        <Button size="sm" variant="outline" onClick={() => setEditing((e) => !e)}>
          <Pencil className="size-4" /> {editing ? 'Stop editing' : 'Edit'}
        </Button>
      </div>
      {editing ? (
        <EditDoc doc={d} onDone={() => setEditing(false)} />
      ) : (
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_14rem]">
          <article className="min-w-0">
            <p className="mb-2 text-xs text-muted-foreground">
              {minutesOf(d.size)} min read · <TimeAgo at={d.updatedAt} />
            </p>
            {!/^\s{0,3}#\s/m.test(d.body.slice(0, 400)) && (
              <h1 className="mb-6 text-3xl font-semibold tracking-tight">{d.title}</h1>
            )}
            <ReaderBody body={d.body} format={d.format} onHeadings={onHeadings} />
          </article>
          {headings.length > 1 && (
            <nav aria-label="Contents" className="hidden lg:block">
              <div className="sticky top-8 grid max-h-[80vh] gap-1 overflow-y-auto text-sm">
                <p className="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  Contents
                </p>
                <TocLinks headings={headings} />
              </div>
            </nav>
          )}
        </div>
      )}
    </div>
  );
}

function BackLink({ onBack }: { onBack: () => void }) {
  return (
    <Button size="sm" variant="ghost" onClick={onBack}>
      <ArrowLeft className="size-4" /> Library
    </Button>
  );
}

function TocLinks({ headings, onPick }: { headings: Heading[]; onPick?: () => void }) {
  const top = Math.min(...headings.map((h) => h.level));
  return (
    <>
      {headings.map((h) => (
        <a
          key={h.id}
          href={`#${h.id}`}
          onClick={(e) => {
            e.preventDefault();
            document.getElementById(h.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            onPick?.();
          }}
          className={cn(
            'block truncate rounded-control px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground',
            h.level - top === 1 && 'pl-5',
            h.level - top >= 2 && 'pl-8 text-xs',
          )}
        >
          {h.text}
        </a>
      ))}
    </>
  );
}

/** Phones and narrow windows: the contents as a dropdown. */
function MobileToc({ headings }: { headings: Heading[] }) {
  const ref = useRef<HTMLDetailsElement>(null);
  return (
    <details ref={ref} className="relative lg:hidden">
      <summary className="flex h-8 cursor-pointer list-none items-center gap-1 rounded-control border px-3 text-sm">
        <List className="size-4" /> Contents
      </summary>
      <div className="absolute right-0 z-20 mt-1 grid max-h-[60vh] w-72 max-w-[calc(100vw-2rem)] gap-1 overflow-y-auto rounded-surface border bg-card p-2 text-sm shadow-float">
        <TocLinks
          headings={headings}
          onPick={() => {
            if (ref.current) ref.current.open = false;
          }}
        />
      </div>
    </details>
  );
}

/** A thin bar at the top of the window; restores the last place on open and saves it while reading. */
function Progress({ doc, paused }: { doc: ReaderDoc; paused: boolean }) {
  const [p, setP] = useState(0);
  useEffect(() => {
    if (paused) return;
    // After the body (and its code) has laid out.
    const restore = window.setTimeout(() => {
      if (doc.lastPos > 0.02) {
        const max = document.documentElement.scrollHeight - window.innerHeight;
        window.scrollTo({ top: doc.lastPos * max });
      }
    }, 150);
    let save: number | undefined;
    let last = doc.lastPos;
    const onScroll = () => {
      const now = scrolled();
      setP(now);
      window.clearTimeout(save);
      save = window.setTimeout(() => {
        if (Math.abs(now - last) < 0.01) return;
        last = now;
        void saveReaderPos(doc.id, Math.round(now * 1000) / 1000);
      }, 1000);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.clearTimeout(restore);
      window.clearTimeout(save);
      window.removeEventListener('scroll', onScroll);
    };
    // Restore once per document; `lastPos` changing from our own saves must not jump the page.
  }, [doc.id, paused]);
  return (
    <div
      aria-hidden
      className="fixed inset-x-0 top-0 z-30 h-0.5 origin-left bg-primary transition-transform duration-150"
      style={{ transform: `scaleX(${p})` }}
    />
  );
}

function EditDoc({ doc, onDone }: { doc: ReaderDoc; onDone: () => void }) {
  const update = useUpdateReaderDoc(doc.id);
  const [title, setTitle] = useState(doc.title);
  const [body, setBody] = useState(doc.body);
  const dirty = title !== doc.title || body !== doc.body;
  return (
    <div className="mx-auto grid max-w-3xl gap-3">
      <Input value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Title" />
      <Textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        aria-label="Text"
        className="min-h-[60vh] font-mono text-sm"
      />
      <div className="flex items-center gap-2">
        {update.isError && (
          <p className="text-sm text-destructive">{describeError(update.error)}</p>
        )}
        <span className="ml-auto" />
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button
          disabled={!dirty || !title.trim() || update.isPending}
          onClick={() =>
            update.mutate({ title: title.trim(), body }, { onSuccess: () => onDone() })
          }
        >
          Save
        </Button>
      </div>
    </div>
  );
}
