import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  root: 'src/renderer',
  plugins: [react()],
  base: './',
  // Pre-bundle BOTH onnxruntime-web and @ricky0123/vad-web (the Vite default).
  // We deliberately do NOT exclude them:
  //   - vad-web is CommonJS and needs Vite's CJS→ESM interop for `import {MicVAD}`
  //     and for its internal `require("onnxruntime-web/wasm")` to resolve.
  //   - onnxruntime-web is pinned to 1.17.3 (via package.json overrides), which
  //     ships ONLY plain `.wasm` (no `.mjs` loader) — so pre-bundling is safe and
  //     does not reintroduce the dynamic `.mjs` import that broke under 1.26.
  // ORT still loads its wasm from /vad/ via ort.env.wasm.wasmPaths (set in micVad.ts).
  optimizeDeps: {
    include: ['onnxruntime-web', '@ricky0123/vad-web'],
  },
  build: {
    outDir: resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, 'src/renderer/index.html'),
    },
  },
})
