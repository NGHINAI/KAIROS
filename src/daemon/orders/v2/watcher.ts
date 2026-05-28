// src/daemon/orders/v2/watcher.ts
// fs.watch wrapper with debounce coalescing.

import { watch } from 'fs'

export function watchOrdersFile(path: string, onChange: () => void, debounceMs = 200): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  const watcher = watch(path, () => {
    if (stopped) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      if (!stopped) onChange()
    }, debounceMs)
  })
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
    watcher.close()
  }
}
