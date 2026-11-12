import type { SkyPhase } from '@/lib/daypart';
import type { EnvId } from '../envFor';

/** The Tiny Studio's colours for three.js, which cannot read the CSS tokens. Same values as `index.css`. */
export const STUDIO = {
  clayDusk: '#2B211D',
  oat: '#F5EBDC',
  moss: '#6B8A58',
  marigold: '#F7B500',
  brick: '#A32A21',
  river: '#4F7F8F',
  sea: '#3F8278',
  stone: '#8A7F72',
} as const;

/** Each world's desk-set colours, the light bounced off its ground, and how the day lights it. Pure data. */
export interface EnvPalette {
  /** The colour light bounces off the ground in (the hemisphere light's lower half). */
  ground: string;
  desk: string;
  deskLeg: string;
  chair: string;
  accent: string;
  /** 0–1: how much the world's own lamps glow (a dim sick day, a cosy cabin night). */
  lampBoost: number;
  /** Multiplies the daylight: a resting day stays soft. */
  daylight: number;
}

export const PALETTES: Record<EnvId, EnvPalette> = {
  home: {
    ground: '#b98a5e',
    desk: '#c99a6b',
    deskLeg: '#5b4636',
    chair: '#3f5b54',
    accent: '#e8a33d',
    lampBoost: 0.6,
    daylight: 1,
  },
  office: {
    ground: '#9a9184',
    desk: '#f4f4f2',
    deskLeg: '#463d36',
    chair: '#3f3a36',
    accent: STUDIO.river,
    lampBoost: 0.4,
    daylight: 1.1,
  },
  sick: {
    ground: '#8f7f72',
    desk: '#b9a48f',
    deskLeg: '#4c4140',
    chair: '#6e5f58',
    accent: '#f1b36b',
    lampBoost: 1,
    daylight: 0.45,
  },
  trip: {
    ground: '#6f5a4a',
    desk: '#a8744a',
    deskLeg: '#2c2c2c',
    chair: '#c58b4e',
    accent: STUDIO.sea,
    lampBoost: 0.5,
    daylight: 1.05,
  },
  leave: {
    ground: '#7a5333',
    desk: '#d2a46c',
    deskLeg: '#4a3020',
    chair: '#c95f4a',
    accent: STUDIO.sea,
    lampBoost: 0.9,
    daylight: 1,
  },
};

export interface PhaseLight {
  skyTop: string;
  skyBottom: string;
  sun: string;
  sunIntensity: number;
  /** Where the sun stands (a direction; the lights scale it to the world). */
  sunPos: [number, number, number];
  ambient: string;
  ambientIntensity: number;
  /** Lamps switch on at dusk. */
  lamps: number;
}

export const PHASES: Record<SkyPhase, PhaseLight> = {
  dawn: {
    skyTop: '#E9A77C',
    skyBottom: STUDIO.oat,
    sun: '#F7C98A',
    sunIntensity: 1.6,
    sunPos: [-7, 3.2, 1.5],
    ambient: '#F2DCC4',
    ambientIntensity: 0.75,
    lamps: 0.5,
  },
  day: {
    skyTop: '#9DBFCB',
    skyBottom: STUDIO.oat,
    sun: '#FFF1D6',
    sunIntensity: 2.4,
    sunPos: [-6, 7, 3],
    ambient: STUDIO.oat,
    ambientIntensity: 0.95,
    lamps: 0.15,
  },
  dusk: {
    skyTop: '#6E4A4E',
    skyBottom: '#E08A4F',
    sun: '#F09A5A',
    sunIntensity: 1.3,
    sunPos: [-7, 2, -1],
    ambient: '#CFA58F',
    ambientIntensity: 0.6,
    lamps: 0.85,
  },
  night: {
    skyTop: '#1E1A24',
    skyBottom: STUDIO.clayDusk,
    sun: '#C9BFD0',
    sunIntensity: 0.35,
    sunPos: [-6, 6, 2],
    ambient: '#8A7F86',
    ambientIntensity: 0.35,
    lamps: 1,
  },
};

export const TONE_COLOR = {
  idle: STUDIO.stone,
  ok: STUDIO.moss,
  warn: STUDIO.marigold,
  bad: STUDIO.brick,
} as const;

/** Text on a `TONE_COLOR` fill: Marigold takes Clay Dusk, never white. */
export const TONE_INK = {
  idle: '#FFFFFF',
  ok: '#FFFFFF',
  warn: STUDIO.clayDusk,
  bad: '#FFFFFF',
} as const;
