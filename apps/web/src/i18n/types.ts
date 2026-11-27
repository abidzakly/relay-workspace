/**
 * The shape of a locale, taken from the English one: same keys, any string. An Indonesian file declared as
 * `Messages<typeof en>` fails `pnpm typecheck` when it misses a key or has one English does not.
 */
export type Messages<T> = { [K in keyof T]: T[K] extends string ? string : Messages<T[K]> };
