import type { Messages } from '../../types';
import type { en } from '../en';
import { cockpit } from './cockpit';
import { nav } from './nav';
import { overview } from './overview';
import { palette } from './palette';
import { settings } from './settings';
import { testBench } from './testBench';
import { shell } from './shell';

/** Bahasa Indonesia. Same keys as `../en`. */
export const id: Messages<typeof en> = {
  nav,
  shell,
  palette,
  cockpit,
  testBench,
  settings,
  overview,
};
