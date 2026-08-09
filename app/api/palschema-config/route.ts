import { NextRequest, NextResponse } from 'next/server'
import { classifyPassword, tierForClass } from '@/lib/access-tier'
import { clientIp, isLockedOut, recordFailure } from '@/lib/rate-limit'
import { DEMO_MODE } from '@/lib/demo-mode'
import { PALWORLD_PROXY_HEADERS } from '@/lib/palworld'
import { runWithInstance } from '@/lib/instances'
import {
  listPalSchemaSubmods,
  listPalSchemaFiles,
  readPalSchemaFile,
  writePalSchemaFile,
} from '@/lib/palschema-config'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// PATCH (not upstream): edit a PalSchema mod's DATA files (jsonc) with client parity. Admin-
// only (mutating game data). GET lists submods / a submod's files / one file's content; POST
// saves (validated, backed up, atomic, + stores the overlay the loadout ships to clients).
function requireAdmin(request: NextRequest): NextResponse | null {
  const ip = clientIp(request)
  if (isLockedOut(ip)) return NextResponse.json({ error: 'Too many attempts. Try again later.' }, { status: 429 })
  const cls = classifyPassword(request.headers.get(PALWORLD_PROXY_HEADERS.adminPassword) ?? '')
  if (cls === 'unknown') {
    recordFailure(ip)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (tierForClass(cls) !== 'admin') {
    return NextResponse.json({ error: 'Forbidden: PalSchema editing is admin-only' }, { status: 403 })
  }
  return null
}

export async function GET(request: NextRequest) {
  return runWithInstance(request.headers.get(PALWORLD_PROXY_HEADERS.instance), () => _GET(request))
}
async function _GET(request: NextRequest) {
  const denied = requireAdmin(request)
  if (denied) return denied
  const submod = request.nextUrl.searchParams.get('submod')
  const file = request.nextUrl.searchParams.get('file')
  if (submod && file) {
    const f = await readPalSchemaFile(submod, file)
    if (!f) return NextResponse.json({ error: 'File not found' }, { status: 404 })
    return NextResponse.json(f)
  }
  if (submod) return NextResponse.json({ files: await listPalSchemaFiles(submod) })
  return NextResponse.json({ submods: await listPalSchemaSubmods() })
}

export async function POST(request: NextRequest) {
  return runWithInstance(request.headers.get(PALWORLD_PROXY_HEADERS.instance), () => _POST(request))
}
async function _POST(request: NextRequest) {
  const denied = requireAdmin(request)
  if (denied) return denied
  if (DEMO_MODE) return NextResponse.json({ error: 'Editing is disabled in demo mode' }, { status: 400 })
  let body: { submod?: string; file?: string; content?: string }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return NextResponse.json({ error: 'Malformed request body' }, { status: 400 })
  }
  if (typeof body.submod !== 'string' || typeof body.file !== 'string' || typeof body.content !== 'string') {
    return NextResponse.json({ error: 'submod, file, and content are required' }, { status: 400 })
  }
  try {
    await writePalSchemaFile(body.submod, body.file, body.content)
    return NextResponse.json({ ok: true, note: 'Saved — restart the server to apply; clients get it on the next loadout.' })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Save failed' }, { status: 400 })
  }
}
