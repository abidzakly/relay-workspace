// Bundles the server with esbuild. Workspace package @relay/shared is bundled in
// (it ships TypeScript source); every other dependency stays external (native modules etc.).
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const external = Object.keys({ ...pkg.dependencies })
  .filter((name) => !name.startsWith('@relay/'))
  .flatMap((name) => [name, `${name}/*`]);

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  external,
  banner: {
    // some deps are CJS and call require() inside the ESM bundle
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  logLevel: 'info',
});
