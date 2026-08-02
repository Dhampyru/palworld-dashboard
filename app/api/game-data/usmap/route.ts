import { NextRequest, NextResponse } from 'next/server'
import { mkdir, writeFile, rename } from 'node:fs/promises'
import { adminGate } from '@/lib/admin-gate'
import { DEMO_MODE } from '@/lib/demo-mode'
import { PALWORLD_PROXY_HEADERS } from '@/lib/palworld'
import { resolveGameDataPaths } from '@/lib/instances'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Upload the operator's own mappings.usmap for the active instance. Stored at
// <srv>/gamedata/<id>/mappings.usmap for the control daemon to feed the extractor
// (usmap upload → datasets/icons, no rebuild). The web tier never runs docker —
// it only writes this file (which it owns) and, via /api/game-data/extract, drops
// a flag file the host daemon acts on.
//
// usmap files are a few MB; cap generously and reject anything that isn't one.
const MAX_USMAP_BYTES = 64 * 1024 * 1024

export async function POST(request: NextRequest) {
  const denied = adminGate(request, 'Forbidden: uploading game data is admin-only')
  if (denied) return denied
  if (DEMO_MODE) return NextResponse.json({ success: true, dryRun: true })

  let bytes: Uint8Array
  let filename = 'mappings.usmap'
  try {
    const contentType = request.headers.get('content-type') ?? ''
    if (contentType.includes('multipart/form-data')) {
      const form = await request.formData()
      const file = form.get('file')
      if (!(file instanceof File)) {
        return NextResponse.json({ error: 'No file provided' }, { status: 400 })
      }
      if (file.size > MAX_USMAP_BYTES) {
        return NextResponse.json({ error: 'File too large (max 64MB)' }, { status: 413 })
      }
      if (file.name) filename = file.name
      bytes = new Uint8Array(await file.arrayBuffer())
    } else {
      bytes = new Uint8Array(await request.arrayBuffer())
    }
  } catch {
    return NextResponse.json({ error: 'Malformed upload' }, { status: 400 })
  }

  if (bytes.byteLength === 0) {
    return NextResponse.json({ error: 'Empty file' }, { status: 400 })
  }
  if (bytes.byteLength > MAX_USMAP_BYTES) {
    return NextResponse.json({ error: 'File too large (max 64MB)' }, { status: 413 })
  }
  // usmap magic is 0x30C4 little-endian → first two bytes C4 30. Reject anything
  // else so we never hand the extractor (or store) an arbitrary upload.
  if (bytes[0] !== 0xc4 || bytes[1] !== 0x30) {
    return NextResponse.json({ error: 'Not a .usmap file (bad magic)' }, { status: 400 })
  }

  try {
    const { dir, usmapPath } = resolveGameDataPaths(
      request.headers.get(PALWORLD_PROXY_HEADERS.instance),
    )
    await mkdir(dir, { recursive: true })
    // temp-then-rename so a concurrent extract never reads a half-written usmap
    const tmp = `${usmapPath}.tmp`
    await writeFile(tmp, bytes, { mode: 0o664 })
    await rename(tmp, usmapPath)
    return NextResponse.json({ success: true, size: bytes.byteLength, filename })
  } catch (error) {
    return NextResponse.json(
      { error: `Failed to store usmap: ${error instanceof Error ? error.message : 'unknown error'}` },
      { status: 500 },
    )
  }
}
