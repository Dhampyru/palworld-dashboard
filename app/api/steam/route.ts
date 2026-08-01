import { NextRequest, NextResponse } from 'next/server'
import { classifyPassword, tierForClass } from '@/lib/access-tier'
import { clientIp, isLockedOut, recordFailure } from '@/lib/rate-limit'
import { DEMO_MODE } from '@/lib/demo-mode'
import { PALWORLD_PROXY_HEADERS } from '@/lib/palworld'
import { clearSteamAccount, getSteamStatus, validateSteamSession } from '@/lib/steam'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// PATCH (not upstream): Steam account for Workshop downloads (docs/specs/steam-
// workshop-download.md). Session-token-only — the password is used for the connect
// login and never stored. Admin-only; SteamCMD runs server-side as the non-root
// nextjs user. GET status; POST connect / test / disconnect.
function presentedPassword(request: NextRequest) {
  return request.headers.get(PALWORLD_PROXY_HEADERS.adminPassword) ?? ''
}
function requireAdmin(request: NextRequest): NextResponse | null {
  const ip = clientIp(request)
  if (isLockedOut(ip)) {
    return NextResponse.json({ error: 'Too many attempts. Try again later.' }, { status: 429 })
  }
  const passwordClass = classifyPassword(presentedPassword(request))
  if (passwordClass === 'unknown') {
    recordFailure(ip)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (tierForClass(passwordClass) !== 'admin') {
    return NextResponse.json({ error: 'Forbidden: Steam config is admin-only' }, { status: 403 })
  }
  return null
}

export async function GET(request: NextRequest) {
  const denied = requireAdmin(request)
  if (denied) return denied
  if (DEMO_MODE) {
    return NextResponse.json({ status: { configured: false, connected: false, username: null, error: null } })
  }
  return NextResponse.json({ status: await getSteamStatus() })
}

export async function POST(request: NextRequest) {
  const denied = requireAdmin(request)
  if (denied) return denied
  if (DEMO_MODE) return NextResponse.json({ status: await getSteamStatus(), dryRun: true })

  let body: { action?: string }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return NextResponse.json({ error: 'Malformed request body' }, { status: 400 })
  }

  // Connecting is a one-time interactive shell login (see the Settings UI) — there is
  // no in-dashboard password/Guard flow. Status is read from the cached session.
  if (body.action === 'disconnect') {
    await clearSteamAccount()
    return NextResponse.json({ status: await getSteamStatus() })
  }

  if (body.action === 'test') {
    const ok = await validateSteamSession()
    return NextResponse.json({ connected: ok, status: await getSteamStatus() })
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
}
