import { build } from 'esbuild';
await build({
  entryPoints: ['src/main/index.ts'],
  outfile: 'build/main/index.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  packages: 'external',
  sourcemap: true,
});
await build({
  entryPoints: ['src/preload/index.ts'],
  outfile: 'build/preload/index.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
});
