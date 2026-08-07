import { NextRequest, NextResponse } from 'next/server'
import { classifyPassword, tierForClass } from '@/lib/access-tier'
import { clientIp, isLockedOut, recordFailure } from '@/lib/rate-limit'
import { DEMO_MODE } from '@/lib/demo-mode'
import { PALWORLD_PROXY_HEADERS } from '@/lib/palworld'
import { runWithInstance } from '@/lib/instances'
import { createShare, deleteShare, listShares } from '@/lib/client-shares'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// PATCH (not upstream): admin management of friend share links (docs/specs/client-mod-
// sync.md §8). GET lists them, POST mints one (generates + persists a bundle), DELETE
// revokes one. Admin-only — the friend-facing GET/download (token = capability) live under
// /api/share/[token].
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
    return NextResponse.json({ error: 'Forbidden: share links are admin-only' }, { status: 403 })
  }
  return null
}

export async function GET(request: NextRequest) {
  return runWithInstance(request.headers.get(PALWORLD_PROXY_HEADERS.instance), () => _GET(request))
}
async function _GET(request: NextRequest) {
  const denied = requireAdmin(request)
  if (denied) return denied
  return NextResponse.json({ shares: await listShares() })
}

export async function POST(request: NextRequest) {
  return runWithInstance(request.headers.get(PALWORLD_PROXY_HEADERS.instance), () => _POST(request))
}
async function _POST(request: NextRequest) {
  const denied = requireAdmin(request)
  if (denied) return denied
  if (DEMO_MODE) return NextResponse.json({ error: 'Share links are disabled in demo mode' }, { status: 400 })
  let body: {
    includeUe4ss?: boolean
    serverName?: string | null
    gameVersion?: string | null
    port?: number
    connectHost?: string | null
    label?: string | null
  }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return NextResponse.json({ error: 'Malformed request body' }, { status: 400 })
  }
  try {
    const share = await createShare({
      includeUe4ss: body.includeUe4ss,
      serverName: body.serverName,
      gameVersion: body.gameVersion,
      port: body.port,
      connectHost: body.connectHost,
      label: body.label,
    })
    return NextResponse.json({ share })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed to create share link' }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest) {
  return runWithInstance(request.headers.get(PALWORLD_PROXY_HEADERS.instance), () => _DELETE(request))
}
async function _DELETE(request: NextRequest) {
  const denied = requireAdmin(request)
  if (denied) return denied
  const token = request.nextUrl.searchParams.get('token') ?? ''
  if (!token) return NextResponse.json({ error: 'token required' }, { status: 400 })
  await deleteShare(token)
  return NextResponse.json({ revoked: token })
}
