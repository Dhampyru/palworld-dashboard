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
const BAKED_DATASETS_DIR = process.env.PALWORLD_DATASETS_DIR ?? join(process.cwd(), 'data')

async function countJson(dir: string, key: string): Promise<number> {
  try {
    const arr = JSON.parse(await readFile(join(dir, `${key}.json`), 'utf8'))
    return Array.isArray(arr) ? arr.length : 0
  } catch {
    return 0
  }
}

async function countIcons(iconsDir: string): Promise<number> {
  try {
    const files = await readdir(join(iconsDir, 'pal'))
    return files.filter((f) => f.toLowerCase().endsWith('.png')).length
  } catch {
    return 0
  }
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

  // Coverage reflects whichever dir actually serves datasets: the instance's
  // extracted dir if present, else the baked stubs (same choice /api/datasets makes).
  let sourceDir = BAKED_DATASETS_DIR
  let source: 'extracted' | 'baked' = 'baked'
  try {
    await access(join(dataDir, 'pals.json'))
    sourceDir = dataDir
    source = 'extracted'
  } catch {
    /* fall back to baked */
  }
  const [pals, items, eggs, icons] = await Promise.all([
    countJson(sourceDir, 'pals'),
    countJson(sourceDir, 'items'),
    countJson(sourceDir, 'eggs'),
    countIcons(iconsDir),
  ])

  return NextResponse.json({ status, hasUsmap, source, coverage: { pals, items, eggs, icons } })
}
