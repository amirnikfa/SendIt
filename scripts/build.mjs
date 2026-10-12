import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
await mkdir('build/assets', { recursive: true });
await copyFile('assets/icon.png', 'build/assets/icon.png');
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
