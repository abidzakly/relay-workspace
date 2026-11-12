/**
 * The scrcpy server must be EXACTLY the version the client speaks (no compatibility across versions). Bump the three
 * together: this version, its checksum (GitHub release asset digest), and the options class in `deviceBridge.ts`.
 */
export const SCRCPY_SERVER_VERSION = '3.3.3';
export const SCRCPY_SERVER_SHA256 =
  '7e70323ba7f259649dd4acce97ac4fefbae8102b2c6d91e2e7be613fd5354be0';
