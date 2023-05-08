import { defineConfig } from 'tsup';

export default defineConfig([
  {
    name: 'bundle',
    entry: ['src/bundle.ts'],
    sourcemap: true,
    //platform: 'browser',
    clean: true,
    minify: true,
    shims: true,
    dts: true,
    treeshake: true,
    target: 'es2015',
    globalName: 'PolyflowSDK',
    format: ['cjs', 'esm', 'iife'],
    injectStyle: true,
    // noExternal: ['cbor'],
    outDir: 'dist/bundle',
    esbuildOptions(options) {
        options.banner = {
            js: '"use client"',
        }
    }
  },
]);
