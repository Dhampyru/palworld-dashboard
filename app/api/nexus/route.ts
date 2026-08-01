import { NextRequest, NextResponse } from 'next/server'
import { classifyPassword, tierForClass } from '@/lib/access-tier'
import { clientIp, isLockedOut, recordFailure } from '@/lib/rate-limit'
import { DEMO_MODE } from '@/lib/demo-mode'
import { PALWORLD_PROXY_HEADERS } from '@/lib/palworld'
import { getNexusStatus, saveNexusKey, validateKey } from '@/lib/nexus'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// PATCH (not upstream): Nexus integration config (docs/specs/nexus-integration.md,
// Phase 1). GET returns the current key STATUS (never the key itself). POST saves a
// key (validated first) or clears it. Admin-only — the key is a server-side secret.
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
    return NextResponse.json({ error: 'Forbidden: Nexus config is admin-only' }, { status: 403 })
  }
  return null
}

export async function GET(request: NextRequest) {
  const denied = requireAdmin(request)
  if (denied) return denied
  if (DEMO_MODE) {
    return NextResponse.json({ configured: false, valid: false, name: null, isPremium: false, source: null, error: null })
  }
  return NextResponse.json(await getNexusStatus())
}

export async function POST(request: NextRequest) {
  const denied = requireAdmin(request)
  if (denied) return denied
  if (DEMO_MODE) {
    return NextResponse.json({ configured: false, valid: false, name: null, isPremium: false, source: null, error: null, dryRun: true })
  }

  let body: { apiKey?: unknown; clear?: unknown }
  try {
    body = (await request.json()) as { apiKey?: unknown; clear?: unknown }
  } catch {
    return NextResponse.json({ error: 'Malformed request body' }, { status: 400 })
  }

  if (body.clear === true) {
    await saveNexusKey(null)
    return NextResponse.json(await getNexusStatus())
  }

  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
  if (!apiKey) {
    return NextResponse.json({ error: 'apiKey required' }, { status: 400 })
  }

  // Validate BEFORE saving — don't persist a bad key.
  const v = await validateKey(apiKey)
  if (!v.valid) {
    return NextResponse.json({ error: v.error ?? 'Key did not validate', valid: false }, { status: 400 })
  }
  await saveNexusKey(apiKey)
  return NextResponse.json(await getNexusStatus())
}
