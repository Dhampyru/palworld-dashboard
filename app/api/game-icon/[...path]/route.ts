import { NextRequest, NextResponse } from 'next/server'
import { readFile } from 'node:fs/promises'
import { join, normalize, sep } from 'node:path'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Streams game icons at RUNTIME from PALWORLD_ICONS_DIR (default the baked
// ./public/palworld-icons), so operator-supplied icons (e.g. from the game-data
// extractor) resolve without a rebuild. Path-guarded to stay inside the dir.
const ICONS_DIR = process.env.PALWORLD_ICONS_DIR ?? join(process.cwd(), 'public', 'palworld-icons')

const CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  webp: 'image/webp',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  avif: 'image/avif',
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params
  const rel = normalize(path.join('/')).replace(/^(\.\.(\/|\\|$))+/, '')
  const full = join(ICONS_DIR, rel)
  if (full !== ICONS_DIR && !full.startsWith(ICONS_DIR + sep)) {
    return NextResponse.json({ error: 'Invalid path' }, { status: 400 })
  }
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
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
}
