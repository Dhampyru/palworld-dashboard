import { NextRequest, NextResponse } from 'next/server'
import { classifyPassword, tierForClass } from '@/lib/access-tier'
import { clientIp, isLockedOut, recordFailure } from '@/lib/rate-limit'
import { DEMO_MODE } from '@/lib/demo-mode'
import { PALWORLD_PROXY_HEADERS } from '@/lib/palworld'
import { runWithInstance } from '@/lib/instances'
import { getLoadoutConnect, setLoadoutConnect } from '@/lib/loadout-connect'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// PATCH (not upstream): the durable connect address friends use to join, persisted
// server-side (docs/specs/client-mod-sync.md §8). GET returns it (admin — it seeds the
// invite panel field); POST saves it. createShare + the bundle INSTALL.txt read it so
// every link carries the join IP/port automatically.
function presentedPassword(request: NextRequest) {
  return request.headers.get(PALWORLD_PROXY_HEADERS.adminPassword) ?? ''
}
function requireAdmin(request: NextRequest): NextResponse | null {
  const ip = clientIp(request)
  if (isLockedOut(ip)) return NextResponse.json({ error: 'Too many attempts. Try again later.' }, { status: 429 })
  const passwordClass = classifyPassword(presentedPassword(request))
  if (passwordClass === 'unknown') {
    recordFailure(ip)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (tierForClass(passwordClass) !== 'admin') {
    return NextResponse.json({ error: 'Forbidden: connect address is admin-only' }, { status: 403 })
  }
  return null
}

export async function GET(request: NextRequest) {
  return runWithInstance(request.headers.get(PALWORLD_PROXY_HEADERS.instance), async () => {
    const denied = requireAdmin(request)
    if (denied) return denied
    return NextResponse.json(await getLoadoutConnect())
  })
}

export async function POST(request: NextRequest) {
  return runWithInstance(request.headers.get(PALWORLD_PROXY_HEADERS.instance), async () => {
    const denied = requireAdmin(request)
    if (denied) return denied
    if (DEMO_MODE) return NextResponse.json({ error: 'Disabled in demo mode' }, { status: 400 })
    let body: { host?: string | null; port?: number | null }
    try {
      body = (await request.json()) as typeof body
    } catch {
      return NextResponse.json({ error: 'Malformed request body' }, { status: 400 })
    }
    const port = body.port == null || body.port === ('' as unknown) ? null : Number(body.port)
    if (port != null && (!Number.isFinite(port) || port <= 0 || port > 65535)) {
      return NextResponse.json({ error: 'port must be 1–65535' }, { status: 400 })
    }
    const saved = await setLoadoutConnect({ host: body.host ?? null, port })
    return NextResponse.json(saved)
  })
}
