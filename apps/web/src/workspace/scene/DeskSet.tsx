import { KEYBOARD, MOUSE } from '../layout';
import type { EnvPalette } from './palette';
import { Ball, Box, Cone, Cyl } from './parts';

/**
 * The avatar's desk set, used wherever it sits (`environment/Seat.tsx`): desk, desk lamp, chair, and the small LED
 * the worlds' objects use for a status light. Modelled in the chair's frame (`SEAT_ORIGIN`), so the avatar's hands
 * find the keyboard and the mouse.
 */
export function Desk({ pal }: { pal: EnvPalette }) {
  const legs: [number, number][] = [
    [-1.08, -2.32],
    [1.08, -2.32],
    [-1.08, -1.58],
    [1.08, -1.58],
  ];
  return (
    <group>
      <Box size={[2.3, 0.06, 0.9]} position={[0, 0.72, -1.95]} color={pal.desk} />
      {legs.map(([x, z]) => (
        <Box
          key={`${x}${z}`}
          size={[0.06, 0.7, 0.06]}
          position={[x, 0.35, z]}
          color={pal.deskLeg}
        />
      ))}
      {/* keyboard + mouse */}
      <Box size={[0.52, 0.02, 0.16]} position={[KEYBOARD[0], 0.76, KEYBOARD[2]]} color="#2d333b" />
      <Box size={[0.07, 0.025, 0.1]} position={[MOUSE[0], 0.76, MOUSE[2]]} color="#2d333b" />
    </group>
  );
}

export function DeskLamp({ pal, glow }: { pal: EnvPalette; glow: number }) {
  return (
    <group position={[-0.5, 0.75, -2.22]}>
      <Cyl r={0.08} h={0.03} position={[0, 0.015, 0]} color={pal.deskLeg} />
      <Box
        size={[0.025, 0.38, 0.025]}
        position={[0, 0.2, 0]}
        rotation={[0, 0, 0.25]}
        color={pal.deskLeg}
      />
      <Cone
        r={0.09}
        h={0.12}
        position={[-0.07, 0.4, 0.02]}
        rotation={[0, 0, 2.6]}
        color={pal.accent}
      />
      <Ball
        r={0.035}
        position={[-0.11, 0.36, 0.02]}
        color="#fff6d8"
        emissive="#ffd890"
        emissiveIntensity={0.4 + glow * 2.5}
        noGlow
      />
      <pointLight
        position={[-0.15, 0.3, 0.05]}
        intensity={glow * 1.6}
        distance={2.6}
        color="#ffcf8a"
      />
    </group>
  );
}

/** The desk chair, in its own frame (see `SEAT_ORIGIN`): seat top at y 0.505, front edge at `front`, backrest front at z +0.21, top 0.76. */
export function Chair({ pal, front = -0.21 }: { pal: EnvPalette; front?: number }) {
  const depth = 0.21 - front;
  return (
    <group>
      <Box size={[0.5, 0.07, depth]} position={[0, 0.47, 0.21 - depth / 2]} color={pal.chair} />
      {/* A low backrest (top at 0.76 m), so the avatar's big head clears it. */}
      <Box size={[0.5, 0.24, 0.07]} position={[0, 0.64, 0.245]} color={pal.chair} />
      <Cyl r={0.03} h={0.4} position={[0, 0.25, 0]} color="#30343a" />
      {[0, 1, 2, 3, 4].map((i) => (
        <Box
          key={i}
          size={[0.04, 0.03, 0.3]}
          position={[
            Math.sin((i / 5) * Math.PI * 2) * 0.14,
            0.04,
            Math.cos((i / 5) * Math.PI * 2) * 0.14,
          ]}
          rotation={[0, (i / 5) * Math.PI * 2, 0]}
          color="#30343a"
        />
      ))}
    </group>
  );
}

export function Led({
  position,
  color,
  on = true,
}: {
  position: [number, number, number];
  color: string;
  on?: boolean;
}) {
  return (
    <Ball
      r={0.012}
      position={position}
      color={color}
      emissive={color}
      emissiveIntensity={on ? 2.2 : 0.2}
      shadow={false}
      noGlow
    />
  );
}
