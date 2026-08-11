import { NextRequest, NextResponse } from 'next/server'
import { classifyPassword, tierForClass } from '@/lib/access-tier'
import { clientIp, isLockedOut, recordFailure } from '@/lib/rate-limit'
import { PALWORLD_PROXY_HEADERS } from '@/lib/palworld'
import {
  DEFAULT_TEMPLATES,
  readDeathSchedule,
  readPalMessagesRaw,
  saveDeathSettings,
  writePalMessages,
  type DeathSchedule,
} from '@/lib/death-announce'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// PATCH (not upstream): witty player-death announcements. GET returns settings + the built-in
// default templates (so the UI can offer "restore defaults"); POST saves settings. Admin-only,
// instance-scoped via the x-palworld-instance header. There is no Test action — deaths come
// from PalDefender's live log, so nothing to synthesize safely.
function requireAdmin(request: NextRequest): NextResponse | null {
  const ip = clientIp(request)
  if (isLockedOut(ip)) return NextResponse.json({ error: 'Too many attempts. Try again later.' }, { status: 429 })
  const cls = classifyPassword(request.headers.get(PALWORLD_PROXY_HEADERS.adminPassword) ?? '')
  if (cls === 'unknown') {
    recordFailure(ip)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (tierForClass(cls) !== 'admin') {
    return NextResponse.json({ error: 'Forbidden: death announcements are admin-only' }, { status: 403 })
  }
  return null
}

function instanceOf(request: NextRequest): string {
  return request.headers.get(PALWORLD_PROXY_HEADERS.instance) || 'default'
}

export async function GET(request: NextRequest) {
  const denied = requireAdmin(request)
  if (denied) return denied
  return NextResponse.json({ schedule: readDeathSchedule(instanceOf(request)), defaults: DEFAULT_TEMPLATES })
}

export async function POST(request: NextRequest) {
  const denied = requireAdmin(request)
  if (denied) return denied
  let body: { action?: unknown; settings?: Partial<DeathSchedule>; raw?: unknown }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return NextResponse.json({ error: 'Malformed request body' }, { status: 400 })
  }
  if (body.action === 'save') {
    return NextResponse.json({ schedule: saveDeathSettings(instanceOf(request), body.settings ?? {}) })
  }
  // Per-Pal message file (shared across instances): load raw for the editor, or validate+save.
  if (body.action === 'loadPalMessages') {
    return NextResponse.json({ raw: await readPalMessagesRaw() })
  }
  if (body.action === 'savePalMessages') {
    if (typeof body.raw !== 'string') return NextResponse.json({ error: 'Missing JSON body' }, { status: 400 })
    try {
      const summary = writePalMessages(body.raw)
      return NextResponse.json({ ok: true, ...summary, raw: await readPalMessagesRaw() })
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : 'Invalid content' }, { status: 400 })
    }
  }
  return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
}
