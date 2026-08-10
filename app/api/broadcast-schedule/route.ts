import { NextRequest, NextResponse } from 'next/server'
import { classifyPassword, tierForClass } from '@/lib/access-tier'
import { clientIp, isLockedOut, recordFailure } from '@/lib/rate-limit'
import { PALWORLD_PROXY_HEADERS } from '@/lib/palworld'
import { readSchedule, runBroadcast, saveScheduleSettings, type BroadcastSchedule } from '@/lib/broadcast-schedule'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// PATCH (not upstream): scheduled broadcasts. GET returns settings + last-run status; POST
// saves settings or fires a Test (sends the next message now, ignoring the interval/skip
// gates). Admin-only. Instance-scoped via the x-palworld-instance header.
function requireAdmin(request: NextRequest): NextResponse | null {
  const ip = clientIp(request)
  if (isLockedOut(ip)) return NextResponse.json({ error: 'Too many attempts. Try again later.' }, { status: 429 })
  const cls = classifyPassword(request.headers.get(PALWORLD_PROXY_HEADERS.adminPassword) ?? '')
  if (cls === 'unknown') {
    recordFailure(ip)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (tierForClass(cls) !== 'admin') {
    return NextResponse.json({ error: 'Forbidden: scheduled broadcasts are admin-only' }, { status: 403 })
  }
  return null
}

function instanceOf(request: NextRequest): string {
  return request.headers.get(PALWORLD_PROXY_HEADERS.instance) || 'default'
}

export async function GET(request: NextRequest) {
  const denied = requireAdmin(request)
  if (denied) return denied
  return NextResponse.json({ schedule: readSchedule(instanceOf(request)) })
}

export async function POST(request: NextRequest) {
  const denied = requireAdmin(request)
  if (denied) return denied
  let body: { action?: unknown; settings?: Partial<BroadcastSchedule> }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return NextResponse.json({ error: 'Malformed request body' }, { status: 400 })
  }
  const id = instanceOf(request)
  if (body.action === 'save') {
    return NextResponse.json({ schedule: saveScheduleSettings(id, body.settings ?? {}) })
  }
  if (body.action === 'test') {
    return NextResponse.json({ schedule: await runBroadcast(id, { force: true }) })
  }
  return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
}
