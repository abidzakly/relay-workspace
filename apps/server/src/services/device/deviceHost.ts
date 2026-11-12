import {
  DeviceListSchema,
  DeviceLogErrorsSchema,
  UiTreeSchema,
  type AdbInput,
  type DeviceControl,
  type DeviceList,
  type DeviceLogErrors,
  type UiTree,
} from '@relay/shared';
import {
  AgentRefusedError,
  AgentUnreachableError,
  type HostAgentClient,
} from '../../hostAgent/client';
import type { DeviceBridge } from './deviceBridge';
import { DeviceError } from './deviceBridge';

/**
 * Where the phone is: `LocalDeviceHost` when the dashboard runs on the Mac, `RemoteDeviceHost`
 * when it runs in Docker and the phone is reached through `pnpm agent`. Same calls, same errors.
 */
export interface DeviceHost {
  list(): Promise<DeviceList>;
  /** Framed mirror bytes until `signal` aborts or another viewer takes over. */
  mirror(serial: string, signal: AbortSignal): AsyncIterable<Uint8Array>;
  control(serial: string, events: DeviceControl[]): Promise<void>;
  screenshot(serial: string): Promise<Buffer>;
  input(serial: string, ev: AdbInput): Promise<void>;
  /** The screen's accessibility tree (`uiautomator dump`). */
  uiTree(serial: string): Promise<UiTree>;
  /** Crashes and ANRs logged after `since` (device epoch seconds; null = only set the mark). */
  logErrors(serial: string, since: number | null): Promise<DeviceLogErrors>;
  restartApp(serial: string, pkg: string): Promise<void>;
}

export class LocalDeviceHost implements DeviceHost {
  constructor(private readonly bridge: DeviceBridge) {}
  list(): Promise<DeviceList> {
    return this.bridge.list();
  }
  mirror(serial: string, signal: AbortSignal): AsyncIterable<Uint8Array> {
    return this.bridge.mirror(serial, signal);
  }
  control(serial: string, events: DeviceControl[]): Promise<void> {
    return this.bridge.control(serial, events);
  }
  screenshot(serial: string): Promise<Buffer> {
    return this.bridge.screenshot(serial);
  }
  input(serial: string, ev: AdbInput): Promise<void> {
    return this.bridge.input(serial, ev);
  }
  uiTree(serial: string): Promise<UiTree> {
    return this.bridge.uiTree(serial);
  }
  logErrors(serial: string, since: number | null): Promise<DeviceLogErrors> {
    return this.bridge.logErrors(serial, since);
  }
  restartApp(serial: string, pkg: string): Promise<void> {
    return this.bridge.restartApp(serial, pkg);
  }
}

/** Agent refusals carry `{ error, message }`; turn them back into the same `DeviceError`. */
async function viaAgent<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof AgentUnreachableError) {
      throw new DeviceError(
        503,
        'agent_unreachable',
        'The host agent on the Mac is not running (`pnpm agent`).',
      );
    }
    if (e instanceof AgentRefusedError) {
      let body: { error?: string; message?: string } = {};
      try {
        body = JSON.parse(e.detail) as typeof body;
      } catch {
        /* not JSON */
      }
      throw new DeviceError(
        e.status,
        body.error ?? 'agent_refused',
        body.message ?? 'The host agent refused.',
      );
    }
    throw e;
  }
}

export class RemoteDeviceHost implements DeviceHost {
  constructor(private readonly agent: HostAgentClient) {}

  async list(): Promise<DeviceList> {
    return DeviceListSchema.parse(
      await viaAgent(() => this.agent.json('GET', '/v1/device/list', undefined, 10_000)),
    );
  }

  async *mirror(serial: string, signal: AbortSignal): AsyncIterable<Uint8Array> {
    const body = await viaAgent(() =>
      this.agent.stream(`/v1/device/${encodeURIComponent(serial)}/mirror`, signal),
    );
    try {
      for await (const chunk of body) yield chunk;
    } catch (e) {
      if (!signal.aborted) throw e;
    }
  }

  async control(serial: string, events: DeviceControl[]): Promise<void> {
    await viaAgent(() =>
      this.agent.json(
        'POST',
        `/v1/device/${encodeURIComponent(serial)}/control`,
        { events },
        10_000,
      ),
    );
  }

  async screenshot(serial: string): Promise<Buffer> {
    return viaAgent(() =>
      this.agent.bytes(`/v1/device/${encodeURIComponent(serial)}/screenshot`, 20_000),
    );
  }

  async input(serial: string, ev: AdbInput): Promise<void> {
    await viaAgent(() =>
      this.agent.json('POST', `/v1/device/${encodeURIComponent(serial)}/input`, ev, 20_000),
    );
  }
  async uiTree(serial: string): Promise<UiTree> {
    return UiTreeSchema.parse(
      await viaAgent(() =>
        this.agent.json(
          'GET',
          `/v1/device/${encodeURIComponent(serial)}/ui-tree`,
          undefined,
          45_000,
        ),
      ),
    );
  }

  async logErrors(serial: string, since: number | null): Promise<DeviceLogErrors> {
    return DeviceLogErrorsSchema.parse(
      await viaAgent(() =>
        this.agent.json(
          'POST',
          `/v1/device/${encodeURIComponent(serial)}/log-errors`,
          { since },
          20_000,
        ),
      ),
    );
  }

  async restartApp(serial: string, pkg: string): Promise<void> {
    await viaAgent(() =>
      this.agent.json(
        'POST',
        `/v1/device/${encodeURIComponent(serial)}/restart-app`,
        { pkg },
        40_000,
      ),
    );
  }
}
