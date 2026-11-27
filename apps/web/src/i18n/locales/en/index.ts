import { cockpit } from './cockpit';
import { nav } from './nav';
import { overview } from './overview';
import { palette } from './palette';
import { settings } from './settings';
import { testBench } from './testBench';
import { shell } from './shell';

/** English, the source locale. Add a key here and its Indonesian twin in `../id` (typecheck enforces it). */
export const en = { nav, shell, palette, cockpit, testBench, settings, overview };
