import type { V3 } from '../layout';
import { SEAT_ORIGIN } from '../layout';
import { Avatar } from '../scene/Avatar';
import { Chair, Desk, DeskLamp } from '../scene/DeskSet';
import type { EnvPalette } from '../scene/palette';
import { Box } from '../scene/parts';
import type { SceneryProps } from '../world/types';

/**
 * Where the avatar spends the day in a world: the desk set, chair and avatar moved as one frame, so the
 * avatar keeps every animation, its customisation, breathing and blinking. Without a desk it sits in a deck chair:
 * resting, holding a mug, looking out (Leave, Sick).
 */
export function Seat({
  pos,
  rotY,
  avatar,
  animate,
  pal,
  lamps,
  desk,
  laptop = true,
}: {
  pos: V3;
  rotY: number;
  avatar: SceneryProps['avatar'];
  animate: boolean;
  pal: EnvPalette;
  lamps: number;
  desk: boolean;
  laptop?: boolean;
}) {
  return (
    <group position={[...pos]} rotation={[0, rotY, 0]}>
      {desk && (
        <>
          <Desk pal={pal} />
          <DeskLamp pal={pal} glow={Math.min(1, lamps)} />
          {laptop && (
            <group position={[0, 0.76, -1.95]}>
              <Box size={[0.42, 0.015, 0.28]} color="#9aa3ad" metalness={0.4} />
              <Box
                size={[0.42, 0.28, 0.012]}
                position={[0, 0.14, -0.14]}
                rotation={[-0.25, 0, 0]}
                color="#2b2f36"
              />
            </group>
          )}
        </>
      )}
      <group position={SEAT_ORIGIN} rotation={[0, desk ? avatar.restTurn : 0, 0]}>
        <Chair pal={pal} />
        <Avatar
          activity={avatar.activity}
          animate={animate}
          color={avatar.color}
          greet={avatar.greet}
        />
      </group>
    </group>
  );
}
