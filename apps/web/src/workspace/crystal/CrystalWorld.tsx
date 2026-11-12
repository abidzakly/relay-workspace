import { useEffect, useMemo, useRef, useState } from 'react';
import { OBJECTS, type ObjectId, type PickId } from '../registry';
import type { QualityTier } from '../environment/quality';
import { Interactive, type PickHandlers } from '../scene/Interactive';
import type { SceneData } from '../signals';
import { OBJECT_ROCKS, useCrystalAssets } from './assets';
import { Crystal, seedOf, type BreakState } from './Crystal';
import { CRYSTAL_CENTRE, CRYSTAL_LAYOUT as LAYOUT, CORE_SCALE, CRYSTAL_SCALE } from './layout';

export interface CrystalWorldProps {
  data: SceneData;
  handlers: PickHandlers;
  quality: QualityTier;
  dark: boolean;
  animate: boolean;
  /** Off-duty (sick, leave): everything rests. */
  stowed: boolean;
  /** The object the camera is on (its page is opening or open). */
  focus: ObjectId | null;
  /** A big win is playing: every crystal bursts, then mends. */
  celebrating: boolean;
}

/** How long a pick may wait for its page before it counts as cancelled (a touch's first tap only arms). */
const PICK_GRACE_MS = 900;

/**
 * Remembers which crystal was opened, so it breaks while its page opens and comes back together when the visitor
 * returns to the world. Mirrors the shell's touch rule: the first tap on touch only names the object, the second opens.
 */
function useBreaks(handlers: PickHandlers, focus: ObjectId | null, celebrating: boolean) {
  const [pressed, setPressed] = useState<PickId | null>(null);
  const [opened, setOpened] = useState<{ id: PickId; at: number } | null>(null);
  const armed = useRef<PickId | null>(null);

  // Back in the world: the opened crystal reforms.
  useEffect(() => {
    if (!opened || focus !== null) return;
    const wait = Math.max(0, PICK_GRACE_MS - (performance.now() - opened.at));
    const timer = setTimeout(() => setOpened(null), wait);
    return () => clearTimeout(timer);
  }, [focus, opened]);

  const wrapped: PickHandlers = useMemo(
    () => ({
      ...handlers,
      onPress: (id) => setPressed(id),
      onPick: (id, touch) => {
        setPressed(null);
        const opens = !touch || armed.current === id;
        armed.current = touch && !opens ? id : null;
        if (opens) setOpened({ id, at: performance.now() });
        handlers.onPick(id, touch);
      },
    }),
    [handlers],
  );

  const stateOf = (id: PickId): BreakState =>
    celebrating || opened?.id === id || focus === id
      ? 'broken'
      : pressed === id
        ? 'pressed'
        : 'whole';
  return { handlers: wrapped, stateOf };
}

/**
 * Every dashboard object as a crystal on the orbit, the core in the middle and the helpers' crystal in front. What
 * each opens and what it shows is the registry's and the signals', as before; only the drawing changed. Hold one
 * down and it cracks; open it and it breaks apart, then mends when you come back.
 */
export function CrystalWorld({
  data,
  handlers: given,
  quality,
  dark,
  animate,
  stowed,
  focus,
  celebrating,
}: CrystalWorldProps) {
  const assets = useCrystalAssets();
  const { handlers, stateOf } = useBreaks(given, focus, celebrating);

  return (
    <>
      <ambientLight intensity={dark ? 0.25 : 0.5} />
      <directionalLight position={[4, 8, 6]} intensity={dark ? 0.9 : 1.6} />
      <directionalLight
        position={[-6, 2, -4]}
        intensity={0.6}
        color={dark ? '#9b8cff' : '#dfe8ff'}
      />

      {OBJECTS.map((o, i) => {
        const place = LAYOUT.place[o.id];
        return (
          <Interactive
            key={o.id}
            id={o.id}
            pivot={LAYOUT.pivot[o.id]}
            handlers={handlers}
            hit={LAYOUT.hit[o.id]}
            position={[...place.pos] as [number, number, number]}
            rotation={[0, place.rotY, 0]}
          >
            <Crystal
              assets={assets}
              rock={OBJECT_ROCKS[i % OBJECT_ROCKS.length]!}
              emblem={o.id}
              scale={CRYSTAL_SCALE}
              centre={CRYSTAL_CENTRE}
              quality={quality}
              dark={dark}
              animate={animate}
              tone={data.signals[o.id].tone}
              seed={seedOf(o.id)}
              still={stowed}
              state={stateOf(o.id)}
            />
          </Interactive>
        );
      })}

      {/* The core: Overview. */}
      <Interactive
        id="observatory"
        pivot={[0, 0, 0]}
        handlers={handlers}
        hit={LAYOUT.observatory.hit}
        position={[...LAYOUT.observatory.place.pos] as [number, number, number]}
        rotation={[0, 0, 0]}
      >
        <Crystal
          assets={assets}
          rock="rock-core"
          emblem="core"
          scale={CORE_SCALE}
          centre={1.2}
          quality={quality}
          dark={dark}
          animate={animate}
          seed={0.31}
          spin={0.6}
          still={stowed}
          state={stateOf('observatory')}
        />
      </Interactive>

      {/* The helpers' crystal: the way to the Cockpit. */}
      <Interactive
        id="bench"
        pivot={[0, 0, 0]}
        handlers={handlers}
        hit={LAYOUT.bench.hit}
        position={[...LAYOUT.bench.place.pos] as [number, number, number]}
        rotation={[0, 0, 0]}
      >
        <Crystal
          assets={assets}
          rock="shard-b"
          emblem="bench"
          scale={0.7}
          centre={0.45}
          quality={quality}
          dark={dark}
          animate={animate}
          seed={0.77}
          spin={1.4}
          still={stowed}
          state={stateOf('bench')}
        />
      </Interactive>
    </>
  );
}
