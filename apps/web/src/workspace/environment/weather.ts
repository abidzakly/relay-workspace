import type { EnvId } from '../envFor';
import { hash01 } from './placement';

/**
 * Decorative weather: deterministic per environment and day, so a day keeps its weather across reloads,
 * and never read from productivity or health — only the place decides the odds. No live weather source.
 */
export type Weather = 'clear' | 'cloudy' | 'rain' | 'mist' | 'windy';

/** Odds per environment (they sum to 1). An island on leave is mostly sunny; a mountain retreat is often misty. */
const ODDS: Record<EnvId, readonly (readonly [Weather, number])[]> = {
  home: [
    ['clear', 0.4],
    ['cloudy', 0.25],
    ['rain', 0.15],
    ['mist', 0.1],
    ['windy', 0.1],
  ],
  office: [
    ['clear', 0.5],
    ['cloudy', 0.35],
    ['windy', 0.15],
  ],
  trip: [
    ['clear', 0.45],
    ['windy', 0.3],
    ['cloudy', 0.2],
    ['rain', 0.05],
  ],
  sick: [
    ['mist', 0.35],
    ['rain', 0.25],
    ['cloudy', 0.25],
    ['clear', 0.15],
  ],
  leave: [
    ['clear', 0.7],
    ['cloudy', 0.2],
    ['windy', 0.1],
  ],
};

/** A stable number for a string (the day and the place). */
function seedOf(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function weatherFor(env: EnvId, day: string): Weather {
  const r = hash01(seedOf(`${env}|${day}`));
  let acc = 0;
  for (const [w, p] of ODDS[env]) {
    acc += p;
    if (r < acc) return w;
  }
  return ODDS[env][0]![0];
}

/** What each weather does to the world: clouds and wind multipliers, fog distance, rain. */
export interface WeatherFx {
  clouds: number;
  wind: number;
  fog: readonly [number, number];
  rain: boolean;
}

export const WEATHER_FX: Record<Weather, WeatherFx> = {
  clear: { clouds: 0.6, wind: 1, fog: [55, 300], rain: false },
  cloudy: { clouds: 1.6, wind: 1.2, fog: [45, 240], rain: false },
  rain: { clouds: 2, wind: 1.5, fog: [30, 170], rain: true },
  mist: { clouds: 1.2, wind: 0.6, fog: [12, 110], rain: false },
  windy: { clouds: 1.3, wind: 2.2, fog: [50, 280], rain: false },
};

/** A local day key, YYYY-MM-DD. */
export const dayKey = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
