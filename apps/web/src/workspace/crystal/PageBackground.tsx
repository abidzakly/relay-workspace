import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import { Color } from 'three';

/** The page behind the crystals: Paper in Wake, Night in Dream. The glass refracts it. */
export function PageBackground({ color }: { color: string }) {
  const scene = useThree((s) => s.scene);
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    scene.background = new Color(color);
    invalidate();
  }, [scene, color, invalidate]);
  return null;
}
