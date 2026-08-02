import { NextRequest, NextResponse } from 'next/server'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import { adminGate } from '@/lib/admin-gate'
import { DEMO_MODE } from '@/lib/demo-mode'
import { PALWORLD_PROXY_HEADERS } from '@/lib/palworld'
import { resolveGameDataPaths } from '@/lib/instances'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Upload Pal icons as a .zip for the active instance. A dedicated-SERVER pak has
// no texture pixel data (see the spec), so icons can't be extracted here — the
// operator runs the extractor against their CLIENT pak on a gaming PC and uploads
// the resulting pal/*.png set. We flatten every .png in the zip into
// <srv>/gamedata/<id>/icons/pal/<name>.png, which /api/game-icon serves and
// /api/datasets links by pal id. Admin-gated; the web tier only writes files it
// owns (no docker/sudo).
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024 // raw zip
const MAX_UNCOMPRESSED_BYTES = 256 * 1024 * 1024 // total once extracted
const SAFE_ICON_NAME = /^[A-Za-z0-9_.-]+\.png$/i

// Last path segment, treating both / and \ as separators (zip entries use /).
function baseName(entryName: string): string {
  return entryName.split(/[/\\]/).pop() ?? ''
}

// Icons are categorised into pal/ or item/ by a folder segment in the zip path
// (…/pal/X.png, …/item/X.png). Bare PNGs default to pal (back-compat with the
// original pal-only zips). /api/datasets links pal icons to Pal ids and item
// icons to item ids; /api/game-icon serves either by path.
function categoryOf(entryName: string): 'pal' | 'item' {
  return entryName.toLowerCase().split(/[/\\]/).includes('item') ? 'item' : 'pal'
}

export async function POST(request: NextRequest) {
  const denied = adminGate(request, 'Forbidden: uploading game data is admin-only')
  if (denied) return denied

  let file: File
  try {
    const form = await request.formData()
    const f = form.get('file')
    if (!(f instanceof File)) return NextResponse.json({ error: 'No file provided' }, { status: 400 })
    file = f
  } catch {
    return NextResponse.json({ error: 'Malformed upload' }, { status: 400 })
  }
  if (file.size === 0) return NextResponse.json({ error: 'Empty file' }, { status: 400 })
  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ error: 'Zip too large (max 64MB)' }, { status: 413 })
  }

  if (DEMO_MODE) return NextResponse.json({ success: true, dryRun: true, count: 0 })

  const buffer = Buffer.from(await file.arrayBuffer())
  let zip: AdmZip
  try {
    zip = new AdmZip(buffer)
  } catch {
    return NextResponse.json({ error: 'Not a valid zip file' }, { status: 400 })
  }

  // Pass 1: collect .png entries by (category, basename), validate names + total
  // size before writing anything (fail closed).
  const pngs: { cat: 'pal' | 'item'; name: string; data: Buffer }[] = []
  let total = 0
  const seen = new Set<string>()
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue
    const name = baseName(entry.entryName)
    if (!name.toLowerCase().endsWith('.png')) continue
    if (!SAFE_ICON_NAME.test(name)) {
      return NextResponse.json({ error: `Unsafe icon filename: "${name}"` }, { status: 400 })
    }
    total += entry.header.size
    if (total > MAX_UNCOMPRESSED_BYTES) {
      return NextResponse.json({ error: 'Icons too large uncompressed (max 256MB)' }, { status: 413 })
    }
    const cat = categoryOf(entry.entryName)
    const key = `${cat}/${name.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    pngs.push({ cat, name, data: entry.getData() })
  }

  if (pngs.length === 0) {
    return NextResponse.json({ error: 'No .png icons found in the zip' }, { status: 400 })
  }

  // Pass 2: write them into the instance's icons/<pal|item> dirs.
  try {
    const { iconsDir } = resolveGameDataPaths(request.headers.get(PALWORLD_PROXY_HEADERS.instance))
    await mkdir(join(iconsDir, 'pal'), { recursive: true })
    await mkdir(join(iconsDir, 'item'), { recursive: true })
    const counts = { pal: 0, item: 0 }
    for (const png of pngs) {
      await writeFile(join(iconsDir, png.cat, png.name), png.data, { mode: 0o664 })
      counts[png.cat]++
    }
    return NextResponse.json({ success: true, count: pngs.length, counts })
  } catch (error) {
    return NextResponse.json(
      { error: `Failed to store icons: ${error instanceof Error ? error.message : 'unknown error'}` },
      { status: 500 },
    )
  }
}
