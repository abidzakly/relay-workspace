import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Adb } from '@yume-chan/adb';
import { AdbServerClient } from '@yume-chan/adb';
import { AdbScrcpyClient, AdbScrcpyOptions3_3_3 } from '@yume-chan/adb-scrcpy';
import { AdbServerNodeTcpConnector } from '@yume-chan/adb-server-node-tcp';
import {
  AndroidKeyCode,
  AndroidKeyEventAction,
  AndroidMotionEventAction,
  AndroidMotionEventButton,
  DefaultServerPath,
  ScrcpyPointerId,
  type ScrcpyMediaStreamPacket,
} from '@yume-chan/scrcpy';
import { ReadableStream, WritableStream } from '@yume-chan/stream-extra';
import {
  DeviceSerialSchema,
  MIRROR_HEADER_BYTES,
  MirrorFrameKind,
  type AdbInput,
  type DeviceControl,
  type DeviceInfo,
  type DeviceList,
  type DeviceLogErrors,
  type MirrorMeta,
  type UiTree,
} from '@relay/shared';
import { ActionError } from '../actionError';
import type { Logger } from '../../util/logger';
import { SCRCPY_SERVER_VERSION } from './scrcpyVersion';
import { parseUiDump } from './uiTree';

/**
 * The phone side of the Test Bench. Runs where the phone is plugged in: inside the host agent
 * when the dashboard is in Docker, in-process otherwise. Talks to the local `adb` server (127.0.0.1:5037) through
 * Tango, pushes the pinned scrcpy server, and turns its H.264 stream into the framing of `MirrorFrameKind`.
 *
 * One viewer per phone: a new viewer replaces the old one (the new stream then starts on a keyframe). Input goes to
 * whichever mirror is running; with none running it is refused.
 */

export class DeviceError extends ActionError {
  constructor(status: number, code: string, message?: string) {
    super(status, code, message);
    this.name = 'DeviceError';
  }
}

export interface DeviceBridgeOptions {
  log: Logger;
  /** Directory holding `scrcpy-server-v<version>` (see `scripts/fetch-scrcpy-server.ts`). */
  scrcpyDir: string;
  adbHost?: string;
  adbPort?: number;
  /** `adb` binary for screenshots; default `adb` on PATH. */
  adbBin?: string;
}

/** One frame of the mirror stream (see `MIRROR_HEADER_BYTES`). */
export function encodeMirrorFrame(
  kind: number,
  payload: Uint8Array,
  opts: { keyframe?: boolean; pts?: bigint } = {},
): Buffer {
  const out = Buffer.allocUnsafe(MIRROR_HEADER_BYTES + payload.byteLength);
  out.writeUInt8(kind, 0);
  out.writeUInt8(opts.keyframe ? 1 : 0, 1);
  out.writeUInt32BE(payload.byteLength, 2);
  out.writeDoubleBE(opts.pts === undefined ? Number.NaN : Number(opts.pts), 6);
  out.set(payload, MIRROR_HEADER_BYTES);
  return out;
}

const json = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

interface Mirror {
  client: AdbScrcpyClient<AdbScrcpyOptions3_3_3<true>>;
  width: number;
  height: number;
  /** Ends the current viewer's stream. */
  stop: () => void;
}

const KEYS: Record<Extract<DeviceControl, { kind: 'key' }>['key'], AndroidKeyCode> = {
  back: AndroidKeyCode.AndroidBack,
  home: AndroidKeyCode.AndroidHome,
  app_switch: AndroidKeyCode.AndroidAppSwitch,
  power: AndroidKeyCode.Power,
  enter: AndroidKeyCode.Enter,
  delete: AndroidKeyCode.Backspace,
};

export class DeviceBridge {
  private readonly server: AdbServerClient;
  private readonly mirrors = new Map<string, Mirror>();
  private readonly adbs = new Map<string, Promise<Adb>>();
  private readonly exec = promisify(execFile);
  /** `uiautomator dump` fails when two run at once on a phone: one at a time per serial. */
  private readonly dumpLocks = new Map<string, Promise<unknown>>();

  constructor(private readonly o: DeviceBridgeOptions) {
    this.server = new AdbServerClient(
      new AdbServerNodeTcpConnector({ host: o.adbHost ?? '127.0.0.1', port: o.adbPort ?? 5037 }),
    );
  }

  get serverPath(): string {
    return join(this.o.scrcpyDir, `scrcpy-server-v${SCRCPY_SERVER_VERSION}`);
  }

  async list(): Promise<DeviceList> {
    try {
      const devices = await this.server.getDevices(['device', 'unauthorized', 'offline']);
      return {
        devices: devices
          .filter((d) => DeviceSerialSchema.safeParse(d.serial).success)
          .map((d): DeviceInfo => ({
            serial: d.serial,
            state: d.state,
            model: d.model ?? null,
            product: d.product ?? null,
            mirroring: this.mirrors.has(d.serial),
          })),
        error: null,
      };
    } catch (e) {
      this.o.log.warn({ err: (e as Error).message }, 'adb device list failed');
      return {
        devices: [],
        error: 'The adb server is not reachable on the Mac. Run `adb devices` once.',
      };
    }
  }

  private adb(serial: string): Promise<Adb> {
    let p = this.adbs.get(serial);
    if (!p) {
      p = this.server.createAdb({ serial }).catch((e: unknown) => {
        this.adbs.delete(serial);
        throw new DeviceError(
          409,
          'device_unavailable',
          `The phone ${serial} is not connected: ${(e as Error).message}`,
        );
      });
      this.adbs.set(serial, p);
    }
    return p;
  }

  /**
   * Starts (or restarts) the mirror and yields framed bytes until the viewer goes away (`signal`) or another viewer
   * takes over. The caller writes them to its HTTP response as they come.
   */
  async *mirror(serial: string, signal: AbortSignal): AsyncGenerator<Buffer> {
    DeviceSerialSchema.parse(serial);
    try {
      await access(this.serverPath);
    } catch {
      throw new DeviceError(
        409,
        'scrcpy_missing',
        'The scrcpy server is not downloaded: run `pnpm --filter @relay/server device:setup` on the Mac.',
      );
    }
    this.mirrors.get(serial)?.stop();
    const adb = await this.adb(serial);
    const bin = await readFile(this.serverPath);
    await AdbScrcpyClient.pushServer(
      adb,
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array(bin));
          c.close();
        },
      }),
    );
    const options = new AdbScrcpyOptions3_3_3({
      audio: false,
      video: true,
      control: true,
      tunnelForward: true,
      maxSize: 1280,
      maxFps: 30,
      videoBitRate: 4_000_000,
      stayAwake: true,
      clipboardAutosync: false,
      cleanup: true,
    });
    let client: AdbScrcpyClient<AdbScrcpyOptions3_3_3<true>>;
    try {
      client = await AdbScrcpyClient.start(adb, DefaultServerPath, options);
    } catch (e) {
      this.adbs.delete(serial);
      this.o.log.warn({ serial, err: (e as Error).message }, 'scrcpy start failed');
      throw new DeviceError(502, 'mirror_failed', 'The mirror could not start on the phone.');
    }
    // The server logs to `output`; it must be drained or the process blocks.
    void client.output.pipeTo(new WritableStream<string>({ write() {} })).catch(() => {});

    const video = await client.videoStream;
    const queue: Buffer[] = [];
    let wake: (() => void) | null = null;
    let done = false;
    const finish = () => {
      done = true;
      wake?.();
    };
    const mirror: Mirror = { client, width: video.width, height: video.height, stop: finish };
    this.mirrors.set(serial, mirror);
    signal.addEventListener('abort', finish, { once: true });

    const meta: MirrorMeta = {
      codec: video.metadata.codec,
      width: video.width,
      height: video.height,
      deviceName: video.metadata.deviceName ?? null,
    };
    queue.push(encodeMirrorFrame(MirrorFrameKind.meta, json(meta)));
    const sizeSub = video.sizeChanged(({ width, height }) => {
      mirror.width = width;
      mirror.height = height;
      queue.push(encodeMirrorFrame(MirrorFrameKind.size, json({ width, height })));
      wake?.();
    });
    const pump = video.stream
      .pipeTo(
        new WritableStream<ScrcpyMediaStreamPacket>({
          write(p) {
            if (done) return;
            if (p.type === 'configuration')
              queue.push(encodeMirrorFrame(MirrorFrameKind.config, p.data));
            else
              queue.push(
                encodeMirrorFrame(MirrorFrameKind.data, p.data, {
                  keyframe: p.keyframe ?? false,
                  ...(p.pts !== undefined ? { pts: p.pts } : {}),
                }),
              );
            wake?.();
          },
        }),
      )
      .catch(() => {})
      .finally(finish);

    try {
      while (!done || queue.length) {
        if (!queue.length) {
          await new Promise<void>((r) => (wake = r));
          wake = null;
          continue;
        }
        // A slow viewer: drop backlog up to the newest keyframe rather than fall further behind.
        if (queue.length > 120) {
          const lastKey = queue.findLastIndex(
            (b) => b[0] === MirrorFrameKind.data && (b[1]! & 1) === 1,
          );
          if (lastKey > 0) queue.splice(0, lastKey);
        }
        yield queue.shift()!;
        if (done && signal.aborted) break;
      }
    } finally {
      sizeSub();
      if (this.mirrors.get(serial) === mirror) this.mirrors.delete(serial);
      await client.close().catch(() => {});
      await pump;
    }
  }

  async control(serial: string, events: DeviceControl[]): Promise<void> {
    const m = this.mirrors.get(serial);
    const ctl = m?.client.controller;
    if (!m || !ctl) throw new DeviceError(409, 'no_mirror', 'Start the mirror first.');
    for (const e of events) {
      switch (e.kind) {
        case 'touch': {
          const action =
            e.action === 'down'
              ? AndroidMotionEventAction.Down
              : e.action === 'up'
                ? AndroidMotionEventAction.Up
                : AndroidMotionEventAction.Move;
          await ctl.injectTouch({
            action,
            pointerId: e.pointerId === 0 ? ScrcpyPointerId.Finger : BigInt(e.pointerId),
            pointerX: e.x * m.width,
            pointerY: e.y * m.height,
            videoWidth: m.width,
            videoHeight: m.height,
            pressure: e.action === 'up' ? 0 : 1,
            actionButton: AndroidMotionEventButton.Primary,
            buttons: e.action === 'up' ? 0 : AndroidMotionEventButton.Primary,
          });
          break;
        }
        case 'key':
          for (const action of [AndroidKeyEventAction.Down, AndroidKeyEventAction.Up]) {
            await ctl.injectKeyCode({ action, keyCode: KEYS[e.key], repeat: 0, metaState: 0 });
          }
          break;
        case 'text':
          await ctl.injectText(e.text);
          break;
        case 'scroll':
          await ctl.injectScroll({
            pointerX: e.x * m.width,
            pointerY: e.y * m.height,
            videoWidth: m.width,
            videoHeight: m.height,
            scrollX: e.dx,
            scrollY: e.dy,
            buttons: 0,
          });
          break;
      }
    }
  }

  /** PNG of the screen (`adb exec-out screencap -p`). Works without a mirror running. */
  async screenshot(serial: string): Promise<Buffer> {
    DeviceSerialSchema.parse(serial);
    try {
      const { stdout } = await this.exec(
        this.o.adbBin ?? 'adb',
        ['-s', serial, 'exec-out', 'screencap', '-p'],
        {
          encoding: 'buffer',
          maxBuffer: 32 * 1024 * 1024,
          timeout: 15_000,
        },
      );
      if (stdout.length < 8 || stdout.readUInt32BE(0) !== 0x89504e47) {
        throw new Error('not a PNG');
      }
      return stdout;
    } catch (e) {
      throw new DeviceError(
        502,
        'screenshot_failed',
        `Could not capture the screen: ${(e as Error).message}`,
      );
    }
  }

  /** `adb shell input …` in screenshot pixels (the AI test agent's hands). Needs no mirror. */
  async input(serial: string, ev: AdbInput): Promise<void> {
    DeviceSerialSchema.parse(serial);
    const KEY: Record<Extract<AdbInput, { kind: 'key' }>['key'], string> = {
      back: 'KEYCODE_BACK',
      home: 'KEYCODE_HOME',
      app_switch: 'KEYCODE_APP_SWITCH',
      enter: 'KEYCODE_ENTER',
      delete: 'KEYCODE_DEL',
      tab: 'KEYCODE_TAB',
    };
    const args =
      ev.kind === 'clear'
        ? ['keyevent', 'KEYCODE_MOVE_END', ...Array<string>(ev.chars).fill('KEYCODE_DEL')]
        : ev.kind === 'tap'
          ? ['tap', String(ev.x), String(ev.y)]
          : ev.kind === 'swipe'
            ? ['swipe', String(ev.x1), String(ev.y1), String(ev.x2), String(ev.y2), String(ev.ms)]
            : ev.kind === 'key'
              ? ['keyevent', KEY[ev.key]]
              : // The device shell re-parses the line: spaces become %s and the rest is single-quoted.
                ['text', `'${ev.text.replace(/'/g, `'\\''`).replace(/ /g, '%s')}'`];
    try {
      await this.exec(this.o.adbBin ?? 'adb', ['-s', serial, 'shell', 'input', ...args], {
        timeout: 15_000,
      });
    } catch (e) {
      throw new DeviceError(
        502,
        'input_failed',
        `adb input failed: ${(e as Error).message.split('\n')[0]}`,
      );
    }
  }

  private adbRun(serial: string, args: string[], timeout = 15_000): Promise<string> {
    return this.exec(this.o.adbBin ?? 'adb', ['-s', serial, ...args], {
      timeout,
      maxBuffer: 16 * 1024 * 1024,
    }).then((r) => r.stdout);
  }

  /**
   * The accessibility tree of the screen (`uiautomator dump`): what the AI tester reads instead of guessing from
   * pixels. Retries once, since the first dump after an app start can come back empty while Flutter builds its
   * Semantics, and a dump refuses while the UI never goes idle (an endless animation).
   */
  async uiTree(serial: string): Promise<UiTree> {
    DeviceSerialSchema.parse(serial);
    const prev = this.dumpLocks.get(serial) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(() => this.dumpOnce(serial));
    this.dumpLocks.set(serial, run);
    try {
      return await run;
    } finally {
      if (this.dumpLocks.get(serial) === run) this.dumpLocks.delete(serial);
    }
  }

  private async dumpOnce(serial: string): Promise<UiTree> {
    let lastErr = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const out = await this.adbRun(
          serial,
          ['exec-out', 'uiautomator', 'dump', '/dev/tty'],
          20_000,
        );
        const start = out.indexOf('<?xml');
        const end = out.lastIndexOf('</hierarchy>');
        if (start < 0 || end < 0) {
          lastErr =
            out
              .split('\n')
              .find((l) => l.trim())
              ?.trim() ?? 'empty dump';
        } else {
          const tree = parseUiDump(out.slice(start, end + '</hierarchy>'.length));
          if (tree.nodes.length > 0 || attempt === 1) return tree;
        }
      } catch (e) {
        lastErr = (e as Error).message.split('\n')[0] ?? 'dump failed';
      }
      await new Promise((r) => setTimeout(r, 700));
    }
    throw new DeviceError(
      502,
      'ui_dump_failed',
      /idle/i.test(lastErr)
        ? 'The screen never stops animating, so its element list cannot be read. Use the screenshot and pixel taps.'
        : `Could not read the screen's elements: ${lastErr}`,
    );
  }

  /**
   * Crashes and ANRs logged since `since` (device epoch seconds, from a previous call; null = only set the mark).
   * Flutter's own exceptions come from the `flutter run` output instead.
   */
  async logErrors(serial: string, since: number | null): Promise<DeviceLogErrors> {
    DeviceSerialSchema.parse(serial);
    let out: string;
    try {
      out = await this.adbRun(serial, [
        'logcat',
        '-d',
        '-v',
        'epoch',
        '-t',
        '400',
        'AndroidRuntime:E',
        'ActivityManager:E',
        '*:S',
      ]);
    } catch (e) {
      this.o.log.warn({ serial, err: (e as Error).message }, 'logcat failed');
      return { lines: [], last: since };
    }
    let last = since;
    const lines: string[] = [];
    for (const line of out.split('\n')) {
      const m = /^\s*(\d+\.\d+)\s+\d+\s+\d+\s+\w\s+(.*)$/.exec(line);
      if (!m) continue;
      const ts = Number(m[1]);
      if (last === null || ts > last) last = ts;
      if (since === null || ts <= since) continue;
      if (/ActivityManager/.test(m[2]!) && !/ANR in/.test(m[2]!)) continue;
      lines.push(m[2]!.slice(0, 300));
    }
    return { lines: lines.slice(0, 30), last };
  }

  /** Force-stops the app and opens it again from its launcher entry. */
  async restartApp(serial: string, pkg: string): Promise<void> {
    DeviceSerialSchema.parse(serial);
    if (!/^[A-Za-z][\w.]{1,200}$/.test(pkg))
      throw new DeviceError(400, 'bad_package', 'Bad package name.');
    try {
      await this.adbRun(serial, ['shell', 'am', 'force-stop', pkg]);
      await this.adbRun(serial, [
        'shell',
        'monkey',
        '-p',
        pkg,
        '-c',
        'android.intent.category.LAUNCHER',
        '1',
      ]);
    } catch (e) {
      throw new DeviceError(
        502,
        'restart_failed',
        `Could not restart the app: ${(e as Error).message.split('\n')[0]}`,
      );
    }
  }

  async close(): Promise<void> {
    for (const m of this.mirrors.values()) m.stop();
  }
}
