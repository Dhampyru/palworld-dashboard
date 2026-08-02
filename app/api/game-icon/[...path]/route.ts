import { NextRequest, NextResponse } from 'next/server'
import { readFile } from 'node:fs/promises'
import { join, normalize, sep } from 'node:path'
import { resolveGameDataPaths } from '@/lib/instances'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Streams game icons at RUNTIME so operator-supplied icons resolve without a
// rebuild. Per active instance, prefer that instance's EXTRACTED icons
// (<srv>/gamedata/<id>/icons), else the baked PALWORLD_ICONS_DIR (default
// ./public/palworld-icons). The instance arrives as ?inst= because <img>
// requests can't carry the instance header. Both candidate dirs are path-guarded.
const BAKED_ICONS_DIR = process.env.PALWORLD_ICONS_DIR ?? join(process.cwd(), 'public', 'palworld-icons')

const CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  webp: 'image/webp',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  avif: 'image/avif',
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params
  const rel = normalize(path.join('/')).replace(/^(\.\.(\/|\\|$))+/, '')
  const instId = (request.nextUrl.searchParams.get('inst') ?? 'default').trim() || 'default'
  const { iconsDir } = resolveGameDataPaths(instId)

  // Try the instance's extracted icons first, then the baked dir.
  for (const base of [iconsDir, BAKED_ICONS_DIR]) {
    const full = join(base, rel)
    if (full !== base && !full.startsWith(base + sep)) continue // stay inside the dir
    try {
      const data = await readFile(full)
      const ext = rel.split('.').pop()?.toLowerCase() ?? ''
      return new NextResponse(new Uint8Array(data), {
        headers: {
          'Content-Type': CONTENT_TYPES[ext] ?? 'application/octet-stream',
          'Cache-Control': 'public, max-age=3600',
        },
      })
    } catch {
      /* try the next candidate */
    }
  }
  return NextResponse.json({ error: 'Not found' }, { status: 404 })
}
