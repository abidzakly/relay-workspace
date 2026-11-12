import type { GimbalSlots } from './Gimbal';
import { MODE_A_GLOW as MATERIAL } from './glow';
import { LIGHTS_AT, type ProgressModel } from './progressMapping';
import { RADII, RING_ROTATION, SHELL_RADIUS, TUBE } from './rig';
import { RingSegments } from './RingSegments';

/** A little thicker than the ring, so a lit slice sheathes the metal instead of fighting it for the same pixels. */
const SEGMENT_TUBE = TUBE * 1.4;
const SHELL_TUBE = 0.025;
const SHELL_ROTATION = [0, 0, 0] as const;

/** Mode A, the ring pipeline: the structure assembles from the outside in as cards advance. */
export function modeASlots(model: ProgressModel, animate: boolean): GimbalSlots {
  return {
    outer: (
      <RingSegments
        key={model.scope}
        segments={model.segments}
        threshold={LIGHTS_AT.outer}
        radius={RADII.outer}
        tube={SEGMENT_TUBE}
        material={MATERIAL.outer}
        rotation={RING_ROTATION.outer}
        animate={animate}
      />
    ),
    middle: (
      <RingSegments
        key={model.scope}
        segments={model.segments}
        threshold={LIGHTS_AT.middle}
        radius={RADII.middle}
        tube={SEGMENT_TUBE}
        material={MATERIAL.middle}
        rotation={RING_ROTATION.middle}
        animate={animate}
      />
    ),
    inner: (
      <>
        <RingSegments
          key={model.scope}
          segments={model.segments}
          threshold={LIGHTS_AT.inner}
          radius={RADII.inner}
          tube={SEGMENT_TUBE}
          material={MATERIAL.inner}
          rotation={RING_ROTATION.inner}
          animate={animate}
        />
        <RingSegments
          key={`shell-${model.scope}`}
          segments={model.segments}
          threshold={LIGHTS_AT.core}
          radius={SHELL_RADIUS}
          tube={SHELL_TUBE}
          material={MATERIAL.shell}
          rotation={SHELL_ROTATION}
          animate={animate}
        />
      </>
    ),
  };
}
