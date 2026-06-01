// copy-vad-assets.mjs — sync Silero VAD + onnxruntime-web wasm into public/vad.
//
// Runs as predev/prebuild so the bundled VAD assets ALWAYS match the installed
// onnxruntime-web version. This prevents the class of bug where public/vad held
// stale .mjs/.wasm from a different ORT version than the one actually imported.
//
// We deliberately copy ONLY .wasm (not .mjs): onnxruntime-web@1.17.x loads wasm
// via plain fetch of ort-wasm-*.wasm — no dynamic import() of a .mjs loader,
// which Vite refuses to serve from public/. If a future ORT bump reintroduces
// .mjs loaders this script stays .wasm-only and the version pin (overrides) is
// what keeps us on the plain-wasm path.

import { mkdirSync, copyFileSync, existsSync, readdirSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, "..")
const dest = join(root, "src", "renderer", "public", "vad")
const vadDist = join(root, "node_modules", "@ricky0123", "vad-web", "dist")
const ortDist = join(root, "node_modules", "onnxruntime-web", "dist")

mkdirSync(dest, { recursive: true })

// Remove any stale .mjs / .asyncify left from earlier attempts — they break Vite.
for (const f of readdirSync(dest)) {
  if (f.endsWith(".mjs") || f.includes(".asyncify.")) {
    rmSync(join(dest, f))
    console.log(`[vad-assets] removed stale ${f}`)
  }
}

const fromVad = [
  "vad.worklet.bundle.min.js",
  "silero_vad_v5.onnx",
  "silero_vad_legacy.onnx",
]
const fromOrt = [
  "ort-wasm-simd.wasm",            // single-thread (numThreads=1 uses this)
  "ort-wasm-simd-threaded.wasm",
  "ort-wasm-simd.jsep.wasm",
  "ort-wasm-simd-threaded.jsep.wasm",
]

let copied = 0
let missing = 0
for (const f of fromVad) {
  const src = join(vadDist, f)
  if (existsSync(src)) { copyFileSync(src, join(dest, f)); copied++ }
  else { console.warn(`[vad-assets] MISSING ${src}`); missing++ }
}
for (const f of fromOrt) {
  const src = join(ortDist, f)
  if (existsSync(src)) { copyFileSync(src, join(dest, f)); copied++ }
  else { console.warn(`[vad-assets] (optional) not present: ${f}`) }
}

console.log(`[vad-assets] synced ${copied} files → ${dest}`)
if (missing > 0) {
  console.error(`[vad-assets] ${missing} required file(s) missing — VAD will not load`)
  process.exit(1)
}
