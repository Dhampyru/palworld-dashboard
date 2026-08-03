import { NextRequest, NextResponse } from 'next/server'
import { readFile, access, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { PALWORLD_PROXY_HEADERS } from '@/lib/palworld'
import { gameDataReadScopes } from '@/lib/instances'
import { iconCandidates } from '@/lib/gamedata-icon-base'

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
// entries arrive without an `image`; an <id>.png uploaded via /api/game-data/icons
// (into the instance's own scope OR the fleet-wide shared scope) becomes the image
// here. The URL keeps ?inst=<active>; /api/game-icon resolves the file across the
// same scopes. Entries that already carry an image (e.g. a full client bundle) are
// left as load() set them.
async function linkIcons(dirs: string[], cat: 'pal' | 'item', entries: Entry[], q: string): Promise<void> {
  const ids = new Set<string>()
  for (const dir of dirs) {
    try {
      for (const f of await readdir(dir)) {
        if (f.toLowerCase().endsWith('.png')) ids.add(f.slice(0, -4))
      }
    } catch {
      /* scope has no icons */
    }
  }
  if (ids.size === 0) return
  for (const e of entries) {
    if (e.image) continue
    // Try the exact id, then base-name candidates (a BOSS_/tier variant reuses
    // the base icon). The URL points at whichever file actually exists.
    const hit = iconCandidates(cat, e.id).find((c) => ids.has(c))
    if (hit) e.image = `${ICON_ROUTE}${cat}/${hit}.png${q}`
  }
}

export async function GET(request: NextRequest) {
  const instId = (request.headers.get(PALWORLD_PROXY_HEADERS.instance) ?? 'default').trim() || 'default'
  const scopes = gameDataReadScopes(instId)
  // Data: first scope (instance override → shared) that has datasets, else baked.
  let dir = BAKED_DATASETS_DIR
  for (const s of scopes) {
    try {
      await access(join(s.dataDir, 'pals.json'))
      dir = s.dataDir
      break
    } catch {
      /* try the next scope */
    }
  }
  const [items, pals, eggs] = await Promise.all([
    load(dir, 'items', instId),
    load(dir, 'pals', instId),
    load(dir, 'eggs', instId),
  ])

  const q = `?inst=${encodeURIComponent(instId)}`
  await linkIcons(scopes.map((s) => join(s.iconsDir, 'pal')), 'pal', pals, q)
  await linkIcons(scopes.map((s) => join(s.iconsDir, 'item')), 'item', items, q)

  return NextResponse.json({ items, pals, eggs })
}
