import { NextRequest, NextResponse } from 'next/server'
import { readFile } from 'node:fs/promises'
import { join, normalize, sep } from 'node:path'
import { gameDataReadScopes } from '@/lib/instances'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Streams game icons at RUNTIME so operator-supplied icons resolve without a
// rebuild. Resolution order per active instance: that instance's own icons →
// the fleet-wide shared scope → the baked PALWORLD_ICONS_DIR (default
// ./public/palworld-icons). The instance arrives as ?inst= because <img>
// requests can't carry the instance header. Every candidate dir is path-guarded.
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
  const bases = [...gameDataReadScopes(instId).map((s) => s.iconsDir), BAKED_ICONS_DIR]

  // Try the instance's icons, then the shared scope, then the baked dir.
  for (const base of bases) {
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
