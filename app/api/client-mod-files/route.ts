import { NextRequest, NextResponse } from 'next/server'
import { classifyPassword, tierForClass } from '@/lib/access-tier'
import { clientIp, isLockedOut, recordFailure } from '@/lib/rate-limit'
import { DEMO_MODE } from '@/lib/demo-mode'
import { PALWORLD_PROXY_HEADERS } from '@/lib/palworld'
import { runWithInstance } from '@/lib/instances'
import {
  addFile,
  addZipBulk,
  clearOverlay,
  listModFolders,
  listOverlay,
  removeFile,
  removeFiles,
  MAX_FILE_BYTES,
} from '@/lib/client-mod-files'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// PATCH (not upstream): "Extra files" for a client mod — upload operator files into a subfolder
// inside a folder-based client mod; they overlay into the client loadout at build time. Admin-
// only, instance-scoped. GET ?modId= returns the mod's destination folders + current overlay.
function requireAdmin(request: NextRequest): NextResponse | null {
  const ip = clientIp(request)
  if (isLockedOut(ip)) return NextResponse.json({ error: 'Too many attempts. Try again later.' }, { status: 429 })
  const cls = classifyPassword(request.headers.get(PALWORLD_PROXY_HEADERS.adminPassword) ?? '')
  if (cls === 'unknown') {
    recordFailure(ip)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (tierForClass(cls) !== 'admin') {
    return NextResponse.json({ error: 'Forbidden: admin-only' }, { status: 403 })
  }
  return null
}

const instanceOf = (request: NextRequest) => request.headers.get(PALWORLD_PROXY_HEADERS.instance)

export async function GET(request: NextRequest) {
  const denied = requireAdmin(request)
  if (denied) return denied
  const modId = new URL(request.url).searchParams.get('modId') ?? ''
  if (!modId) return NextResponse.json({ error: 'modId required' }, { status: 400 })
  return runWithInstance(instanceOf(request), async () => {
    const [folders, overlay] = await Promise.all([listModFolders(modId), listOverlay(modId)])
    return NextResponse.json({ folders, overlay, maxBytes: MAX_FILE_BYTES })
  })
}

export async function POST(request: NextRequest) {
  const denied = requireAdmin(request)
  if (denied) return denied
  if (DEMO_MODE) return NextResponse.json({ error: 'Disabled in demo mode' }, { status: 400 })
  return runWithInstance(instanceOf(request), async () => {
    let form: FormData
    try {
      form = await request.formData()
    } catch {
      return NextResponse.json({ error: 'Expected multipart form data' }, { status: 400 })
    }
    const modId = String(form.get('modId') ?? '')
    const rel = String(form.get('rel') ?? '')
    const mode = String(form.get('mode') ?? '')
    const file = form.get('file')
    if (!modId) return NextResponse.json({ error: 'modId required' }, { status: 400 })
    if (!(file instanceof File)) return NextResponse.json({ error: 'file required' }, { status: 400 })
    try {
      const buffer = Buffer.from(await file.arrayBuffer())
      if (mode === 'zip') {
        // Bulk: extract the zip's structure into the overlay; the zip itself is never stored.
        const result = await addZipBulk(modId, rel, buffer)
        const overlay = await listOverlay(modId)
        return NextResponse.json({ ok: true, bulk: result, overlay })
      }
      const placed = await addFile(modId, rel, file.name, buffer)
      const overlay = await listOverlay(modId)
      return NextResponse.json({ ok: true, placed, overlay })
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : 'Upload failed' }, { status: 400 })
    }
  })
}

export async function DELETE(request: NextRequest) {
  const denied = requireAdmin(request)
  if (denied) return denied
  return runWithInstance(instanceOf(request), async () => {
    let body: { modId?: unknown; rel?: unknown; filename?: unknown; items?: unknown; clearAll?: unknown }
    try {
      body = (await request.json()) as typeof body
    } catch {
      return NextResponse.json({ error: 'Malformed request body' }, { status: 400 })
    }
    const modId = typeof body.modId === 'string' ? body.modId : ''
    if (!modId) return NextResponse.json({ error: 'modId required' }, { status: 400 })
    try {
      if (body.clearAll === true) {
        await clearOverlay(modId)
      } else if (Array.isArray(body.items)) {
        const items = body.items
          .filter((x): x is { rel?: string; filename?: string } => !!x && typeof x === 'object')
          .map((x) => ({ rel: typeof x.rel === 'string' ? x.rel : '', filename: typeof x.filename === 'string' ? x.filename : '' }))
          .filter((x) => x.filename)
        await removeFiles(modId, items)
      } else {
        const filename = typeof body.filename === 'string' ? body.filename : ''
        const rel = typeof body.rel === 'string' ? body.rel : ''
        if (!filename) return NextResponse.json({ error: 'filename (or items/clearAll) required' }, { status: 400 })
        await removeFile(modId, rel, filename)
      }
      return NextResponse.json({ ok: true, overlay: await listOverlay(modId) })
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : 'Delete failed' }, { status: 400 })
    }
  })
}
