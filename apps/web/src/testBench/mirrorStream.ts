import { MIRROR_HEADER_BYTES, MirrorFrameKind, type MirrorMeta } from '@relay/shared';
import type { ScrcpyMediaStreamPacket } from '@yume-chan/scrcpy';

/**
 * Splits the server's mirror response into frames (see `MIRROR_HEADER_BYTES` in shared/device.ts) and hands the video
 * packets to a ReadableStream the WebCodecs decoder consumes. Pure apart from the callbacks.
 */
export interface MirrorHandlers {
  onMeta: (meta: MirrorMeta) => void;
  onSize: (size: { width: number; height: number }) => void;
}

export function mirrorPackets(
  body: ReadableStream<Uint8Array>,
  h: MirrorHandlers,
): ReadableStream<ScrcpyMediaStreamPacket> {
  const reader = body.getReader();
  let buf = new Uint8Array(0);
  const decoder = new TextDecoder();

  const append = (chunk: Uint8Array) => {
    const next = new Uint8Array(buf.byteLength + chunk.byteLength);
    next.set(buf, 0);
    next.set(chunk, buf.byteLength);
    buf = next;
  };

  return new ReadableStream<ScrcpyMediaStreamPacket>({
    async pull(controller) {
      for (;;) {
        if (buf.byteLength >= MIRROR_HEADER_BYTES) {
          const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
          const kind = view.getUint8(0);
          const keyframe = (view.getUint8(1) & 1) === 1;
          const len = view.getUint32(2);
          const pts = view.getFloat64(6);
          if (buf.byteLength >= MIRROR_HEADER_BYTES + len) {
            const payload = buf.slice(MIRROR_HEADER_BYTES, MIRROR_HEADER_BYTES + len);
            buf = buf.slice(MIRROR_HEADER_BYTES + len);
            if (kind === MirrorFrameKind.meta)
              h.onMeta(JSON.parse(decoder.decode(payload)) as MirrorMeta);
            else if (kind === MirrorFrameKind.size)
              h.onSize(JSON.parse(decoder.decode(payload)) as { width: number; height: number });
            else if (kind === MirrorFrameKind.config) {
              controller.enqueue({ type: 'configuration', data: payload });
              return;
            } else if (kind === MirrorFrameKind.data) {
              controller.enqueue({
                type: 'data',
                keyframe,
                ...(Number.isNaN(pts) ? {} : { pts: BigInt(Math.round(pts)) }),
                data: payload,
              });
              return;
            }
            continue;
          }
        }
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        append(value);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}
