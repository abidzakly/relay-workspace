import { z } from 'zod';

/**
 * Real-device bridge: the phone is plugged into the Mac, `adb` runs there, and the dashboard shows
 * its screen and sends input through the host agent. Android only for now.
 */

export const DeviceSerialSchema = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{1,120}$/, 'invalid device serial');

export const DeviceInfoSchema = z.object({
  serial: DeviceSerialSchema,
  /** `unauthorized` = accept the RSA prompt on the phone. */
  state: z.enum(['device', 'unauthorized', 'offline']),
  model: z.string().nullable(),
  product: z.string().nullable(),
  /** A mirror is running for it. */
  mirroring: z.boolean(),
});
export type DeviceInfo = z.infer<typeof DeviceInfoSchema>;

export const DeviceListSchema = z.object({
  devices: z.array(DeviceInfoSchema),
  /** Why the list could not be read (adb server not running …). */
  error: z.string().nullable(),
});
export type DeviceList = z.infer<typeof DeviceListSchema>;

const Unit = z.number().min(0).max(1);

/** Input sent to the phone. Coordinates are 0..1 of the video frame, so the browser never needs the device size. */
export const DeviceControlSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('touch'),
    action: z.enum(['down', 'move', 'up']),
    x: Unit,
    y: Unit,
    pointerId: z.number().int().min(0).max(9).default(0),
  }),
  z.object({
    kind: z.literal('key'),
    key: z.enum(['back', 'home', 'app_switch', 'power', 'enter', 'delete']),
  }),
  z.object({ kind: z.literal('text'), text: z.string().min(1).max(300) }),
  z.object({
    kind: z.literal('scroll'),
    x: Unit,
    y: Unit,
    dx: z.number().min(-16).max(16),
    dy: z.number().min(-16).max(16),
  }),
]);
export type DeviceControl = z.infer<typeof DeviceControlSchema>;

/** A batch keeps a drag in order and cheap (one request per animation frame). */
export const DeviceControlBatchSchema = z.object({
  events: z.array(DeviceControlSchema).min(1).max(64),
});

/**
 * Mirror stream framing (one HTTP response, binary). Each frame:
 *   u8 kind | u8 flags (bit0 = keyframe) | u32 BE payload length | f64 BE pts (µs, NaN when none) | payload
 * kind 0 = metadata JSON (`MirrorMeta`), 1 = codec configuration, 2 = video data, 3 = size change JSON.
 */
export const MIRROR_HEADER_BYTES = 14;
export const MirrorFrameKind = { meta: 0, config: 1, data: 2, size: 3 } as const;

export const MirrorMetaSchema = z.object({
  codec: z.number().int(),
  width: z.number().int().nonnegative(),
  height: z.number().int().nonnegative(),
  deviceName: z.string().nullable(),
});
export type MirrorMeta = z.infer<typeof MirrorMetaSchema>;

/**
 * Input the AI test agent sends through `adb shell input`, in screenshot pixels. Works with no
 * mirror running. Text is limited to printable ASCII: `adb shell input text` cannot type anything else reliably.
 */
export const AdbInputSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('tap'),
    x: z.number().int().min(0).max(10_000),
    y: z.number().int().min(0).max(10_000),
  }),
  z.object({
    kind: z.literal('swipe'),
    x1: z.number().int().min(0).max(10_000),
    y1: z.number().int().min(0).max(10_000),
    x2: z.number().int().min(0).max(10_000),
    y2: z.number().int().min(0).max(10_000),
    ms: z.number().int().min(50).max(5_000).default(300),
  }),
  z.object({
    kind: z.literal('text'),
    text: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[\x20-\x7e]+$/, 'printable ASCII only'),
  }),
  z.object({
    kind: z.literal('key'),
    key: z.enum(['back', 'home', 'app_switch', 'enter', 'delete', 'tab']),
  }),
  /** Empties the focused field: cursor to the end, then `chars` backspaces in one `input keyevent` call. */
  z.object({
    kind: z.literal('clear'),
    chars: z.number().int().min(1).max(500),
  }),
]);
export type AdbInput = z.infer<typeof AdbInputSchema>;

/**
 * One element of the phone's accessibility tree (`uiautomator dump`), as the AI tester sees it. Flutter apps expose
 * their Semantics here. `bounds` are screen pixels `[left, top, right, bottom]`, the same pixels as a screenshot.
 */
export const UiNodeSchema = z.object({
  /** Number the agent uses to act on it; valid for the dump it came from only. */
  n: z.number().int().nonnegative(),
  text: z.string(),
  desc: z.string(),
  resourceId: z.string(),
  cls: z.string(),
  pkg: z.string(),
  bounds: z.tuple([z.number().int(), z.number().int(), z.number().int(), z.number().int()]),
  clickable: z.boolean(),
  scrollable: z.boolean(),
  focused: z.boolean(),
  enabled: z.boolean(),
  /** null = not checkable. */
  checked: z.boolean().nullable(),
  selected: z.boolean(),
  password: z.boolean(),
});
export type UiNode = z.infer<typeof UiNodeSchema>;

export const UiTreeSchema = z.object({
  nodes: z.array(UiNodeSchema),
  width: z.number().int().nonnegative(),
  height: z.number().int().nonnegative(),
  /** Package of the foreground window (the app under test, a system dialog, the launcher…). */
  pkg: z.string().nullable(),
});
export type UiTree = z.infer<typeof UiTreeSchema>;

/** App errors on the phone since a point in time (`logcat -v epoch`): crashes and ANRs. */
export const DeviceLogErrorsSchema = z.object({
  lines: z.array(z.string()),
  /** Newest log timestamp seen (device clock, epoch seconds); pass back as `since`. */
  last: z.number().nullable(),
});
export type DeviceLogErrors = z.infer<typeof DeviceLogErrorsSchema>;
