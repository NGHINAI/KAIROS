// scripts/discover-trigger-slugs.ts
// Usage: bun run scripts/discover-trigger-slugs.ts [toolkit]

import { Composio } from '@composio/core'

const apiKey = process.env.COMPOSIO_API_KEY
if (!apiKey) { console.error('COMPOSIO_API_KEY missing'); process.exit(1) }

const toolkitFilter = process.argv[2]?.toLowerCase()

async function main() {
  const composio = new Composio({ apiKey })
  // Paginate to get the full list. listTypes returns 50/page with `nextCursor`.
  const allItems: any[] = []
  let cursor: string | undefined = undefined
  let pages = 0
  do {
    const result: any = await (composio.triggers as any).listTypes(cursor ? { cursor } : {})
    const items = result?.items ?? []
    allItems.push(...items)
    cursor = result?.nextCursor
    pages++
    if (pages > 20) break   // safety
  } while (cursor)
  const items = allItems
  const filtered = toolkitFilter
    ? items.filter((t: any) => {
        const tk = (t.toolkit?.slug ?? t.toolkit_slug ?? t.toolkit ?? '').toString().toLowerCase()
        return tk === toolkitFilter
      })
    : items
  console.log(`Found ${filtered.length} trigger types${toolkitFilter ? ` for "${toolkitFilter}"` : ''}:`)
  console.log()
  for (const t of filtered) {
    const slug = t.slug ?? t.name
    const tk = (t.toolkit?.slug ?? t.toolkit_slug ?? t.toolkit ?? '').toString()
    const desc = (t.description ?? '').slice(0, 80)
    console.log(`  ${tk.padEnd(20)} ${slug.padEnd(50)} ${desc}`)
  }
}
main().catch(err => { console.error('Error:', err); process.exit(1) })
