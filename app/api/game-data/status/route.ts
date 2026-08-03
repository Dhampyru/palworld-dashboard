import { NextRequest, NextResponse } from 'next/server'
import { readFile, access, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { PALWORLD_PROXY_HEADERS } from '@/lib/palworld'
import { resolveGameDataPaths } from '@/lib/instances'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Reports extraction progress + current picker coverage for the active instance.
// Not admin-gated on purpose: it's read-only status the whole panel can poll (the
// coverage counts are already visible via /api/datasets). Mutations (upload,
// extract) are the admin-gated routes.
//
// Coverage reflects what the pickers ACTUALLY serve, mirroring /api/datasets: the
// served dataset dir (extracted if present, else baked) for names, and an entry is
// counted "iconed" if it carries a baked `image` OR an uploaded <id>.png exists —
// so the numbers match reality on baked data, not just runtime uploads.
const BAKED_DATASETS_DIR = process.env.PALWORLD_DATASETS_DIR ?? join(process.cwd(), 'data')

type Entry = { id: string; name?: string; image?: string }

async function loadArr(dir: string, key: string): Promise<Entry[]> {
  try {
    const arr = JSON.parse(await readFile(join(dir, `${key}.json`), 'utf8'))
    return Array.isArray(arr) ? (arr as Entry[]) : []
  } catch {
    return []
  }
}

async function iconIdSet(dir: string): Promise<Set<string>> {
  try {
    const files = await readdir(dir)
    return new Set(files.filter((f) => f.toLowerCase().endsWith('.png')).map((f) => f.slice(0, -4)))
  } catch {
    return new Set()
  }
}

// {total, named, iconed} where iconed = has a baked image OR an uploaded icon.
function tally(entries: Entry[], uploaded: Set<string>) {
  let named = 0
  let iconed = 0
  for (const e of entries) {
    if (e.name) named++
    if (e.image || uploaded.has(e.id)) iconed++
  }
  return { total: entries.length, named, iconed }
}

export async function GET(request: NextRequest) {
  const { dataDir, iconsDir, usmapPath, status: statusPath } = resolveGameDataPaths(
    request.headers.get(PALWORLD_PROXY_HEADERS.instance),
  )

  let status: unknown = null
  try {
    status = JSON.parse(await readFile(statusPath, 'utf8'))
  } catch {
    /* no run yet */
  }

  let hasUsmap = false
  try {
    await access(usmapPath)
    hasUsmap = true
  } catch {
    /* not uploaded */
  }

  // Which dir serves datasets: the instance's extracted dir if present, else baked.
  let sourceDir = BAKED_DATASETS_DIR
  let source: 'extracted' | 'baked' = 'baked'
  try {
    await access(join(dataDir, 'pals.json'))
    sourceDir = dataDir
    source = 'extracted'
  } catch {
    /* fall back to baked */
  }

  const [pals, items, eggs, palIcons, itemIcons] = await Promise.all([
    loadArr(sourceDir, 'pals'),
    loadArr(sourceDir, 'items'),
    loadArr(sourceDir, 'eggs'),
    iconIdSet(join(iconsDir, 'pal')),
    iconIdSet(join(iconsDir, 'item')),
  ])

  return NextResponse.json({
    status,
    hasUsmap,
    source,
    coverage: {
      pals: tally(pals, palIcons),
      items: tally(items, itemIcons),
      eggs: tally(eggs, new Set()),
    },
  })
}
