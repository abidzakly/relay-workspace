import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useNotionDataSources, useOAuthStatus } from '@/lib/oauthApi';
import { ErrorAlert } from './SectionCard';

/**
 * Picks the data source from what the Notion sign-in (or saved token) can see, so its id never has to be found and
 * typed. The list is read only when asked for.
 */
export function NotionSourcePicker({
  tokenSet,
  value,
  onPick,
}: {
  tokenSet: boolean;
  value: string;
  onPick: (id: string) => void;
}) {
  const oauth = useOAuthStatus();
  const usable = tokenSet || !!oauth.data?.notion.connected;
  const [open, setOpen] = useState(false);
  const list = useNotionDataSources(open && usable);
  if (!usable) return null;
  if (!open) {
    return (
      <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
        Pick from Notion
      </Button>
    );
  }
  if (list.error) return <ErrorAlert error={list.error} />;
  if (!list.data) return <p className="text-xs text-muted-foreground">Reading Notion…</p>;
  if (list.data.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        Relay sees no database yet. In Notion, open the database, then ••• &gt; Connections and add
        Relay (or Connect again and tick it).
      </p>
    );
  }
  return (
    <select
      aria-label="Notion data source"
      className="h-9 w-full rounded-control border border-hairline bg-background px-2 text-sm"
      value={list.data.some((d) => d.id === value) ? value : ''}
      onChange={(e) => e.target.value && onPick(e.target.value)}
    >
      <option value="">Choose a database…</option>
      {list.data.map((d) => (
        <option key={d.id} value={d.id}>
          {d.title}
        </option>
      ))}
    </select>
  );
}
