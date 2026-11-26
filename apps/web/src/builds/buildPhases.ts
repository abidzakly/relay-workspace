import type { Job } from '@relay/shared';
import type { Stage } from '@/release/model';

/** Lines the build queue writes itself (`buildQueue.ts`, `note()`), so they are stable. Flutter's own lines are not. */
const NOTE = '[dashboard] ';

type PhaseId = 'prepare' | 'flavor' | 'apk' | 'aab' | 'saved';

const LABEL: Record<PhaseId, string> = {
  prepare: 'Prepare',
  flavor: 'Flavor',
  apk: 'Build APK',
  aab: 'Build AAB',
  saved: 'Saved',
};

export interface BuildPhases {
  stages: Stage[];
  /** The newest line that is not one of the queue's own notes: what flutter or gradle is doing now. */
  activity: string | null;
  /** The phase the build stopped in or is working on. */
  current: number;
}

interface Seen {
  reached: boolean;
  note: string;
}

/**
 * The build's phases, read from its log. The log is flat (a build job has one step), so the queue's own notes mark the
 * phases: sync or merge, flavor, each flutter command, the saved artefact. The job's status has the last word: a failed
 * build fails the phase it was in, a finished one marks what it never reached as skipped.
 */
export function buildPhases(job: Job, lines: readonly string[]): BuildPhases {
  const prod = job.mode === 'prod';
  const order: PhaseId[] = prod
    ? ['prepare', 'flavor', 'apk', 'aab', 'saved']
    : ['prepare', 'flavor', 'apk', 'saved'];
  const seen: Record<PhaseId, Seen> = {
    prepare: { reached: false, note: '' },
    flavor: { reached: false, note: '' },
    apk: { reached: false, note: '' },
    aab: { reached: false, note: '' },
    saved: { reached: false, note: '' },
  };
  let saved = 0;
  let activity: string | null = null;

  for (const line of lines) {
    if (!line.startsWith(NOTE)) {
      if (line.trim() !== '') activity = line;
      continue;
    }
    const note = line.slice(NOTE.length);
    if (note.startsWith('Syncing the bot clone'))
      seen.prepare = { reached: true, note: 'Syncing clone' };
    else if (note.startsWith('Merging !')) seen.prepare = { reached: true, note: note.slice(8) };
    else if (note.startsWith('Merged '))
      seen.prepare = { reached: true, note: note.split('. ')[0] ?? note };
    else if (note.startsWith('Dry run: would merge'))
      seen.prepare = { reached: true, note: 'Simulated' };
    else if (note.startsWith('Flavor ')) {
      const m = /^Flavor (\S+) \([^)]*\), version (\S+)/.exec(note);
      seen.flavor = { reached: true, note: m ? `${m[1]} ${m[2]}` : note.slice(7) };
    } else if (/^(Running|Dry run: would run):.* build apk\b/.test(note)) {
      seen.apk = { reached: true, note: note.startsWith('Dry') ? 'Simulated' : 'Compiling' };
    } else if (/^(Running|Dry run: would run):.* build appbundle\b/.test(note)) {
      seen.aab = { reached: true, note: note.startsWith('Dry') ? 'Simulated' : 'Compiling' };
    } else if (note.startsWith('Saved ')) {
      saved += 1;
      seen.saved = { reached: true, note: note.slice(6).replace(/ \(\d+ bytes\)$/, '') };
    }
  }

  // The furthest phase the log reached. Prepare is optional (QA previews and standalone builds only).
  let furthest = -1;
  order.forEach((id, i) => {
    if (seen[id].reached) furthest = i;
  });
  const status = job.status;
  const over = status === 'succeeded' || status === 'failed' || status === 'cancelled';
  const allSaved = saved >= (prod ? 2 : 1);

  const stages: Stage[] = order.map((id, i) => {
    const label = LABEL[id];
    const { reached, note } = seen[id];
    if (status === 'queued') return { label, state: 'idle', note: 'Queued' };
    if (status === 'succeeded') {
      if (job.dryRun && !reached) return { label, state: 'skipped', note: 'Not in a dry run' };
      if (!reached) return { label, state: 'skipped', note: id === 'prepare' ? 'Not needed' : '' };
      return { label, state: 'done', note: job.dryRun && note === '' ? 'Simulated' : note };
    }
    if (i < furthest)
      return { label, state: reached ? 'done' : 'skipped', note: reached ? note : 'Not needed' };
    if (i === furthest) {
      if (id === 'saved' && allSaved && !over) return { label, state: 'done', note };
      if (status === 'failed') return { label, state: 'failed', note: job.error ?? 'Failed' };
      if (status === 'cancelled') return { label, state: 'failed', note: 'Cancelled' };
      return { label, state: 'active', note };
    }
    if (furthest === -1 && i === 0 && status === 'failed') {
      return { label, state: 'failed', note: job.error ?? 'Failed' };
    }
    if (over) return { label, state: 'idle', note: 'Not reached' };
    // Nothing logged yet: the first phase is the one under way.
    if (furthest === -1 && i === 0) return { label, state: 'active', note: 'Starting' };
    return { label, state: 'idle', note: '' };
  });

  const working = stages.findIndex((s) => s.state === 'active' || s.state === 'failed');
  return { stages, activity, current: working >= 0 ? working : Math.max(0, furthest) };
}
