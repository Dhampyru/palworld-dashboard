import { NextRequest, NextResponse } from 'next/server'
import { readFile, access, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { PALWORLD_PROXY_HEADERS } from '@/lib/palworld'
import { resolveGameDataPaths } from '@/lib/instances'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Serves the RCON picker datasets (items/pals/eggs) at RUNTIME so they can be
// populated without a rebuild. Per active instance, prefer that instance's
// EXTRACTED datasets (<srv>/gamedata/<id>/data, written by the usmap upload →
// extract flow); fall back to the baked PALWORLD_DATASETS_DIR (default ./data,
// which holds the empty stubs unless an operator/extractor filled it). Icon paths
// are rewritten from the static /palworld-icons/ prefix to the runtime
// /api/game-icon/ route, carrying ?inst= so <img> requests (which can't send the
// instance header) resolve the right instance's icons.
const BAKED_DATASETS_DIR = process.env.PALWORLD_DATASETS_DIR ?? join(process.cwd(), 'data')
const ICON_PREFIX = '/palworld-icons/'
const ICON_ROUTE = '/api/game-icon/'

type Entry = { id: string; name?: string; image?: string }

async function load(dir: string, key: 'items' | 'pals' | 'eggs', instId: string): Promise<Entry[]> {
  try {
    const raw = await readFile(join(dir, `${key}.json`), 'utf8')
    const arr = JSON.parse(raw) as Entry[]
    if (!Array.isArray(arr)) return []
    const q = `?inst=${encodeURIComponent(instId)}`
    return arr.map((e) =>
      e.image && e.image.startsWith(ICON_PREFIX)
        ? { ...e, image: ICON_ROUTE + e.image.slice(ICON_PREFIX.length) + q }
        : e,
    )
  } catch {
    return []
  }
}

// Set each entry's `image` from an uploaded icon of the same id, when it has none.
// Server extraction can't produce icons (the server pak strips texture data), so
// entries arrive without an `image`; an <id>.png in the instance's icons/<cat> dir
// (uploaded via /api/game-data/icons) becomes the image here. Entries that already
// carry an image (e.g. a full client bundle) are left as load() set them.
async function linkIcons(dir: string, cat: 'pal' | 'item', entries: Entry[], q: string): Promise<void> {
  try {
    const files = await readdir(dir)
    const ids = new Set(
      files.filter((f) => f.toLowerCase().endsWith('.png')).map((f) => f.slice(0, -4)),
    )
    if (ids.size === 0) return
    for (const e of entries) {
      if (!e.image && ids.has(e.id)) e.image = `${ICON_ROUTE}${cat}/${e.id}.png${q}`
    }
  } catch {
    /* no uploaded icons for this category */
  }
}

export async function GET(request: NextRequest) {
  const instId = (request.headers.get(PALWORLD_PROXY_HEADERS.instance) ?? 'default').trim() || 'default'
  const { dataDir, iconsDir } = resolveGameDataPaths(instId)
  // Prefer the instance's extracted datasets when present; else the baked dir.
  let dir = BAKED_DATASETS_DIR
  try {
    await access(join(dataDir, 'pals.json'))
    dir = dataDir
  } catch {
    /* fall back to baked */
  }
  const [items, pals, eggs] = await Promise.all([
    load(dir, 'items', instId),
    load(dir, 'pals', instId),
    load(dir, 'eggs', instId),
  ])

  // Link uploaded Pal icons by id. Server extraction can't produce icons (the
  // server pak strips texture data), so those pals arrive with no `image`; if the
  // operator has uploaded an icon set (/api/game-data/icons), an <id>.png in the
  // instance's icons/pal dir becomes the pal's image here. Entries that already
  // carry an image (e.g. a full client bundle) are left as the load() rewrite set them.
  const q = `?inst=${encodeURIComponent(instId)}`
  await linkIcons(join(iconsDir, 'pal'), 'pal', pals, q)
  await linkIcons(join(iconsDir, 'item'), 'item', items, q)

  return NextResponse.json({ items, pals, eggs })
}
