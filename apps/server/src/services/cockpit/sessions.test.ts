import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NodePtyModule, NodePtyProcess } from '../ptyBackend';
import { silentLog } from '../../testing/memDb';
import { CURSOR_MODEL } from './cursorCli';
import { CockpitHostError } from './host';
import {
  chooseRunFlavor,
  commandFor,
  flutterRunCommand,
  IDLE_MS,
  parseDevices,
  parseEmulators,
  readRunTargets,
  RingBuffer,
  SessionManager,
  sessionEnv,
  type SessionEvent,
} from './sessions';
import { asPrompt } from './sessionService';

const dev = { flavor: 'development' as const, mode: 'debug' as const, ios: false };

describe('RingBuffer', () => {
  it('replays from an offset and reports a reset once data was dropped', () => {
    const r = new RingBuffer(10);
    r.append('hello ');
    r.append('world');
    expect(r.since(6)).toEqual({ data: 'world', reset: false, from: 6 });
    r.append('!!!!!!');
    // Over the cap: the oldest chunks are dropped; a client at 0 must clear and gets what is left.
    const s = r.since(0);
    expect(s.reset).toBe(true);
    expect(s.data).toBe('!!!!!!');
    expect(s.from).toBe(11);
    expect(r.since(r.end).data).toBe('');
  });
});

describe('commandFor', () => {
  it('only runs the allowlisted programs', () => {
    expect(commandFor('claude', '/w', undefined).args).toEqual(
      expect.arrayContaining(['--permission-mode', 'plan', '--permission-prompt-tool', 'stdio']),
    );
    expect(commandFor('cursor', '/w', undefined)).toMatchObject({
      file: 'cursor-agent',
      args: ['--mode', 'plan', '--model', CURSOR_MODEL],
    });
    expect(commandFor('shell', '/w', undefined, '/bin/zsh')).toMatchObject({
      file: '/bin/zsh',
      args: ['-l'],
    });
    expect(commandFor('shell', '/w', undefined, '/usr/bin/evil').file).toBe('/bin/zsh');
    expect(
      commandFor('flutter', '/nonexistent', 'emulator-5554', undefined, undefined, dev),
    ).toMatchObject({
      file: 'flutter',
      args: [
        'run',
        '-t',
        'lib/main_development.dart',
        '--flavor',
        'development',
        '-d',
        'emulator-5554',
      ],
      title: 'Run · development · emulator-5554',
    });
    expect(() => commandFor('flutter', '/nonexistent', 'emulator-5554')).toThrow(/resolved target/);
    expect(() => commandFor('flutter', '/w', '--help; rm', undefined, undefined, dev)).toThrow();
  });
  it('session env drops dashboard secrets and the API key', () => {
    const env = sessionEnv({ PATH: '/bin', MASTER_KEY: 'x', ANTHROPIC_API_KEY: 'k', HOME: '/h' });
    expect(env).toMatchObject({ PATH: '/bin', HOME: '/h', TERM: 'xterm-256color' });
    expect(env).not.toHaveProperty('MASTER_KEY');
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
  });
});

describe('flutter run target', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  function repo(files: string[], extra: string[] = []): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'flutter-run-')));
    dirs.push(dir);
    mkdirSync(join(dir, 'lib'));
    for (const file of files) writeFileSync(join(dir, 'lib', file), 'void main() {}\n');
    for (const file of extra) writeFileSync(join(dir, file), '{}\n');
    return dir;
  }

  it('uses the only flavored entrypoint, even when lib/main.dart is also there', async () => {
    const dir = repo(['main.dart', 'main_development.dart']);
    const targets = await readRunTargets(dir);
    expect(targets).toEqual({ flavors: ['development'], plainMain: false });
    expect(chooseRunFlavor(targets, undefined)).toBe('development');
  });

  it('requires a choice when several flavors exist and refuses one that is not on disk', async () => {
    const dir = repo(['main_staging.dart', 'main_development.dart']);
    const targets = await readRunTargets(dir);
    expect(targets.flavors).toEqual(['development', 'staging']);
    expect(() => chooseRunFlavor(targets, undefined)).toThrow(CockpitHostError);
    expect(() => chooseRunFlavor(targets, undefined)).toThrow(
      /Choose a flavor: development, staging/,
    );
    expect(() => chooseRunFlavor(targets, 'qa')).toThrow(CockpitHostError);
    try {
      chooseRunFlavor(targets, 'qa');
    } catch (e) {
      expect(e).toMatchObject({
        code: 'entrypoint_missing',
        status: 422,
        details: { flavors: ['development', 'staging'] },
      });
    }
    expect(chooseRunFlavor(targets, 'staging')).toBe('staging');
  });

  it('falls back to lib/main.dart only when no flavored entrypoint exists', async () => {
    const plain = await readRunTargets(repo(['main.dart']));
    expect(plain).toEqual({ flavors: [], plainMain: true });
    expect(chooseRunFlavor(plain, undefined)).toBeNull();
    expect(
      flutterRunCommand('emulator-5554', {
        flavor: null,
        mode: 'debug',
        ios: false,
        useFvm: false,
      }),
    ).toMatchObject({
      file: 'flutter',
      args: ['run', '-d', 'emulator-5554'],
      title: 'Run · emulator-5554',
    });

    const empty = await readRunTargets(repo([]));
    expect(empty).toEqual({ flavors: [], plainMain: false });
    expect(() => chooseRunFlavor(empty, undefined)).toThrow(/No lib\/main\.dart/);
  });

  it('drops --flavor on iOS and adds the mode flag otherwise', () => {
    expect(
      flutterRunCommand('ios-sim', {
        flavor: 'development',
        mode: 'debug',
        ios: true,
        useFvm: false,
      }).args,
    ).toEqual(['run', '-t', 'lib/main_development.dart', '-d', 'ios-sim']);
    expect(
      flutterRunCommand('emulator-5554', {
        flavor: 'production',
        mode: 'profile',
        ios: false,
        useFvm: false,
      }).args,
    ).toEqual([
      'run',
      '-t',
      'lib/main_production.dart',
      '--flavor',
      'production',
      '-d',
      'emulator-5554',
      '--profile',
    ]);
    expect(
      flutterRunCommand('emulator-5554', {
        flavor: 'production',
        mode: 'release',
        ios: false,
        useFvm: true,
      }),
    ).toMatchObject({
      file: 'fvm',
      args: [
        'flutter',
        'run',
        '-t',
        'lib/main_production.dart',
        '--flavor',
        'production',
        '-d',
        'emulator-5554',
        '--release',
      ],
    });
  });

  it('uses fvm when the workspace has .fvmrc', () => {
    const dir = repo(['main_development.dart'], ['.fvmrc']);
    expect(commandFor('flutter', dir, 'emulator-5554', undefined, undefined, dev)).toMatchObject({
      file: 'fvm',
      args: [
        'flutter',
        'run',
        '-t',
        'lib/main_development.dart',
        '--flavor',
        'development',
        '-d',
        'emulator-5554',
      ],
    });
  });
});

describe('flutter parsers', () => {
  it('reads devices JSON and emulator text', () => {
    expect(
      parseDevices(
        'Waiting...\n[{"id":"emulator-5554","name":"sdk gphone","targetPlatform":"android-arm64","emulator":true}]',
      ),
    ).toEqual([
      {
        id: 'emulator-5554',
        name: 'sdk gphone',
        platform: 'android-arm64',
        emulator: true,
        source: 'device',
      },
    ]);
    expect(
      parseEmulators(
        '2 available emulators:\n\nId • Name • Manufacturer • Platform\nPixel_7 • Pixel 7 • Google • android\n',
      ),
    ).toEqual([
      { id: 'Pixel_7', name: 'Pixel 7', platform: 'android', emulator: true, source: 'emulator' },
    ]);
  });
});

function fakePty() {
  let onData: (d: string) => void = () => {};
  let onExit: (e: { exitCode: number }) => void = () => {};
  const written: string[] = [];
  const proc: NodePtyProcess = {
    pid: 999_999,
    onData: (l) => (onData = l),
    onExit: (l) => (onExit = l),
    write: (d) => written.push(d),
    kill: () => onExit({ exitCode: 0 }),
    resize: () => {},
  };
  const mod: NodePtyModule = { spawn: () => proc };
  return { mod, emit: (d: string) => onData(d), exit: () => onExit({ exitCode: 0 }), written };
}

describe('SessionManager', () => {
  it('replays scrollback on reattach and flags an agent as waiting after an idle burst', () => {
    vi.useFakeTimers();
    let now = 1_000;
    const pty = fakePty();
    const m = new SessionManager(silentLog, () => now, pty.mod);
    const s = m.start({ cwd: '/w', wsId: 'app', kind: 'cursor', cols: 80, rows: 24 });
    pty.emit('x'.repeat(300));
    const events: SessionEvent[] = [];
    const detach = m.attach(s.id, 100, (e) => events.push(e));
    expect(events[0]).toEqual({ t: 'data', data: 'x'.repeat(200), offset: 100 });
    now += IDLE_MS + 10;
    vi.advanceTimersByTime(1_000);
    expect(m.list()[0]).toMatchObject({ state: 'idle', waiting: true });
    m.input(s.id, 'next\r');
    expect(m.list()[0]!.waiting).toBe(false);
    expect(pty.written).toEqual(['next\r']);
    pty.exit();
    expect(events.at(-1)).toEqual({ t: 'exit', exitCode: 0 });
    detach();
    m.close();
    vi.useRealTimers();
  });
});

describe('asPrompt', () => {
  it('wraps a prompt in bracketed paste', () => {
    expect(asPrompt('a\r\nb')).toBe('\x1b[200~a\nb\x1b[201~');
  });
});
