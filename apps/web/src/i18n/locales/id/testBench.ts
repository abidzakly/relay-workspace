import type { Messages } from '../../types';
import type { testBench as en } from '../en/testBench';

export const testBench: Messages<typeof en> = {
  mirror: {
    noAnswer:
      'Ponsel tidak menjawab tepat waktu. Buka kuncinya (atau pastikan emulator berjalan), lalu tekan Reconnect.',
  },
};
