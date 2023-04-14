import { defineConfig } from 'tsup';

export default defineConfig([
  {
    name: 'browser',
    entry: ['src/index.ts'],
    sourcemap: true,
    platform: 'browser',
    clean: true,
    minify: true,
    shims: true,
    treeshake: true,
    globalName: 'PolyflowSDK',
    format: ['cjs', 'esm'],
    noExternal: ['cbor'],
    outDir: 'dist/browser',
  },
]);
