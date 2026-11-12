import { describe, expect, it } from 'vitest';
import { nextPhase } from './RunView';
import { ctrlOf } from './ExtraKeys';

describe('flutter run status pill', () => {
  it('building → running → reloading → reloaded → stopped', () => {
    let p = nextPhase('building', 'Launching lib/main.dart on sdk gphone...');
    expect(p).toBe('building');
    p = nextPhase(p, '\x1b[1mFlutter run key commands.\x1b[0m\nr Hot reload.');
    expect(p).toBe('running');
    p = nextPhase(p, 'Performing hot reload...');
    expect(p).toBe('reloading');
    p = nextPhase(p, 'Reloaded 3 of 812 libraries in 412ms.');
    expect(p).toBe('reloaded');
    expect(nextPhase(p, 'Application finished.')).toBe('stopped');
  });
});

describe('extra keys', () => {
  it('Ctrl turns a letter into its control character', () => {
    expect(ctrlOf('c')).toBe('\x03');
    expect(ctrlOf('d')).toBe('\x04');
    expect(ctrlOf('↑')).toBe('↑');
  });
});
