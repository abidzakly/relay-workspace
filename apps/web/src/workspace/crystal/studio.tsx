import { useEffect, useSyncExternalStore } from 'react';
import { useThree } from '@react-three/fiber';
import {
  BackSide,
  BoxGeometry,
  Color,
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  PMREMGenerator,
  Scene,
} from 'three';

/**
 * A photo studio, built in code, for the crystals to reflect and refract: a black room with hard softboxes, thin
 * strips and a few coloured gels. Foil and glass show nothing but their surroundings, so this room is the look:
 * the black between the panels draws the dark streaks, the strips the sharp glints, the gels the warm and cool
 * fringes. HDR values (well above 1), so highlights stay white after tone mapping.
 * Generated locally: a preset HDR would be an outbound request, which the CSP refuses.
 */
function studioScene(dark: boolean): Scene {
  const scene = new Scene();
  const room = new Mesh(
    new BoxGeometry(20, 12, 20),
    new MeshBasicMaterial({ color: new Color(dark ? '#020207' : '#050506'), side: BackSide }),
  );
  scene.add(room);
  const panel = (w: number, h: number, color: string, k: number, at: [number, number, number]) => {
    const m = new Mesh(
      new PlaneGeometry(w, h),
      new MeshBasicMaterial({ color: new Color(color).multiplyScalar(k), side: DoubleSide }),
    );
    m.position.set(...at);
    m.lookAt(0, 0, 0);
    scene.add(m);
  };
  const L = dark ? 0.6 : 1;
  // key softbox overhead, a paper-coloured bounce in front (the page the crystal floats over), a floor
  panel(8, 3.5, '#ffffff', 7 * L, [0, 6, 1]);
  panel(9, 4, dark ? '#24244a' : '#ecebe6', dark ? 0.6 : 1.4, [0, -1, 9.8]);
  panel(10, 10, dark ? '#0c0c22' : '#cfcdc6', dark ? 0.25 : 0.55, [0, -6, 0]);
  // long edge strips: the bright lines down the rims
  panel(0.5, 9, '#ffffff', 12 * L, [-9, 1, 3]);
  panel(0.4, 9, '#ffffff', 9 * L, [9, 0.5, -1.5]);
  panel(0.3, 7, '#ffffff', 8 * L, [-4, 2, -9]);
  // gels: warm on one side, cool and pink on the other, for the fringes
  panel(2.5, 4, '#ff8a3d', 5 * L, [7, -1.5, 6]);
  panel(2, 3, '#ff5fae', 3.5 * L, [-7, -2.5, -5]);
  panel(3, 3, dark ? '#8f7bff' : '#48c8ff', 4 * L, [-6, 3, 7]);
  panel(4, 2, dark ? '#6d5cff' : '#bfe3ff', 2.5 * L, [2, 1.5, -9.8]);
  // thin strips all round: every chip and fold catches one
  const strips: [number, number, number, number][] = [
    [6, 4, 6, 0.12],
    [-7, -2, 5, 0.1],
    [3, 3, -8, 0.14],
    [-3, 5, 7, 0.08],
    [8, -3, 2, 0.1],
    [-8, 4, -3, 0.12],
    [1, -4, -8, 0.1],
    [5, 5, -5, 0.08],
  ];
  for (const [x, y, z, w] of strips) panel(w, 4, '#ffffff', 14 * L, [x, y, z]);
  return scene;
}

/** PMREM face size, and its roughest mip (three keeps 8-px faces at the bottom: log2(512) - 3). */
const STUDIO_SIZE = 512;
export const STUDIO_MAX_LOD = Math.log2(STUDIO_SIZE) - 3;

/**
 * Sets the studio as the scene's environment: a PMREM cubemap with GGX-blurred mips, which the standard materials
 * and the foil shader (`foil.ts`, by mip level) both read. 512 faces and no pre-blur, so mirror-sharp reflections
 * stay crisp bands. Rebuilt when Wake/Dream changes.
 */
export function StudioEnvironment({ dark }: { dark: boolean }) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    const generator = new PMREMGenerator(gl);
    const studio = studioScene(dark);
    const target = generator.fromScene(studio, 0, 0.1, 100, { size: STUDIO_SIZE });
    scene.environment = target.texture;
    invalidate();
    return () => {
      scene.environment = null;
      target.dispose();
      generator.dispose();
      studio.traverse((o) => {
        const m = o as Mesh;
        if (m.isMesh) {
          m.geometry.dispose();
          (m.material as MeshBasicMaterial).dispose();
        }
      });
    };
  }, [gl, scene, invalidate, dark]);
  return null;
}

/** Follows the `dark` class that `ThemeSync` puts on <html>: Dream is dark, Wake is light. */
export function useDarkTheme(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const observer = new MutationObserver(onChange);
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
      return () => observer.disconnect();
    },
    () => document.documentElement.classList.contains('dark'),
  );
}

/** The page colours, for the canvas background (same values as `index.css`). */
export const PAPER = '#ecebe6';
export const NIGHT = '#0c0c1c';
export const INK = '#121212';
