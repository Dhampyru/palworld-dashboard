import { NextResponse } from 'next/server'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Serves the RCON picker datasets (items/pals/eggs) at RUNTIME so they can be
// populated without a rebuild — read from PALWORLD_DATASETS_DIR (default ./data,
// which holds the empty stubs unless an operator/extractor filled them). Icon
// paths are rewritten from the static /palworld-icons/ prefix to the runtime
// /api/game-icon/ route so icons resolve whether baked or operator-supplied.
const DATASETS_DIR = process.env.PALWORLD_DATASETS_DIR ?? join(process.cwd(), 'data')
const ICON_PREFIX = '/palworld-icons/'
const ICON_ROUTE = '/api/game-icon/'

type Entry = { id: string; name?: string; image?: string }

async function load(key: 'items' | 'pals' | 'eggs'): Promise<Entry[]> {
  try {
    const raw = await readFile(join(DATASETS_DIR, `${key}.json`), 'utf8')
    const arr = JSON.parse(raw) as Entry[]
    if (!Array.isArray(arr)) return []
    return arr.map((e) =>
      e.image && e.image.startsWith(ICON_PREFIX)
        ? { ...e, image: ICON_ROUTE + e.image.slice(ICON_PREFIX.length) }
        : e,
    )
  } catch {
    return []
  }
}

export async function GET() {
  const [items, pals, eggs] = await Promise.all([load('items'), load('pals'), load('eggs')])
  return NextResponse.json({ items, pals, eggs })
}
