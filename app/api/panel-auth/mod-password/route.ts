import { NextRequest, NextResponse } from 'next/server'
import { DEMO_MODE } from '@/lib/demo-mode'
import { PALWORLD_PROXY_HEADERS } from '@/lib/palworld'
import { clientIp, isLockedOut, recordFailure } from '@/lib/rate-limit'
import { verifyAdmin, setModPassword, isModEnabled } from '@/lib/panel-auth-store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MIN_LEN = 6

// Whether the mod tier is currently enabled — admin-gated status read for the UI.
export async function GET(request: NextRequest) {
  const ip = clientIp(request)
  if (isLockedOut(ip)) {
    return NextResponse.json({ error: 'Too many attempts. Try again later.' }, { status: 429 })
  }
  const sessionPassword = request.headers.get(PALWORLD_PROXY_HEADERS.adminPassword) ?? ''
  if (!verifyAdmin(sessionPassword)) {
    recordFailure(ip)
    return NextResponse.json({ error: 'Admin access required.' }, { status: 403 })
  }
  return NextResponse.json({ modEnabled: DEMO_MODE ? false : isModEnabled() })
}

// Set / change / disable the panel MOD login password. Authorized by the
// logged-in admin session (header); pass `modPassword: null` to disable the
// mod tier. Rate-limited on failure.
export async function POST(request: NextRequest) {
  const ip = clientIp(request)
  if (isLockedOut(ip)) {
    return NextResponse.json({ error: 'Too many attempts. Try again later.' }, { status: 429 })
  }

  const sessionPassword = request.headers.get(PALWORLD_PROXY_HEADERS.adminPassword) ?? ''
  if (!verifyAdmin(sessionPassword)) {
    recordFailure(ip)
    return NextResponse.json({ error: 'Admin access required.' }, { status: 403 })
  }

  let modPassword: string | null = null
  let disable = false
  let body: { modPassword?: unknown }
  try {
    body = (await request.json()) as { modPassword?: unknown }
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 })
  }
  if (body.modPassword === null || body.modPassword === undefined) {
    disable = true // explicit null/omitted → disable the mod tier
  } else if (typeof body.modPassword === 'string') {
    modPassword = body.modPassword
  } else {
    // A number/array/object must NOT silently disable the tier — reject it.
    return NextResponse.json({ error: 'modPassword must be a string or null.' }, { status: 400 })
  }

  if (!disable && (modPassword === null || modPassword.length < MIN_LEN)) {
    return NextResponse.json({ error: `Mod password must be at least ${MIN_LEN} characters.` }, { status: 400 })
  }
  if (DEMO_MODE) {
    return NextResponse.json({ success: true, modEnabled: !disable, message: 'Demo mode: mod access change skipped.' })
  }

  try {
    setModPassword(disable ? null : modPassword)
  } catch (error) {
    return NextResponse.json(
      { error: `Failed to update mod access: ${error instanceof Error ? error.message : 'unknown error'}` },
      { status: 500 }
    )
  }
  return NextResponse.json({ success: true, modEnabled: !disable })
}
