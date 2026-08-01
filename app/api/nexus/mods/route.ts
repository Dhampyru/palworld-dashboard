import { NextRequest, NextResponse } from 'next/server'
import { classifyPassword, tierForClass } from '@/lib/access-tier'
import { clientIp, isLockedOut, recordFailure } from '@/lib/rate-limit'
import { DEMO_MODE } from '@/lib/demo-mode'
import { PALWORLD_PROXY_HEADERS } from '@/lib/palworld'
import {
  getNexusMods,
  getNexusStatus,
  linkNexusMod,
  markNexusSeen,
  parseNexusModId,
  unlinkNexusMod,
} from '@/lib/nexus'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// PATCH (not upstream): Nexus mod↔install associations + update watching
// (docs/specs/nexus-integration.md, Phase 1 increment 2). Admin-only.
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
  if (DEMO_MODE) return NextResponse.json({ connected: false, mods: {} })
  const status = await getNexusStatus()
  // Only surface associations when the key actually authenticates.
  return NextResponse.json({
    connected: status.configured && status.valid,
    isPremium: status.isPremium,
    mods: status.configured && status.valid ? await getNexusMods() : {},
  })
}

export async function POST(request: NextRequest) {
  const denied = requireAdmin(request)
  if (denied) return denied
  if (DEMO_MODE) return NextResponse.json({ connected: false, mods: {}, dryRun: true })

  let body: { action?: string; modKey?: string; url?: string; haveVersion?: string }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return NextResponse.json({ error: 'Malformed request body' }, { status: 400 })
  }
  const modKey = typeof body.modKey === 'string' ? body.modKey : ''
  if (!modKey) return NextResponse.json({ error: 'modKey required' }, { status: 400 })

  const status = await getNexusStatus()
  if (!(status.configured && status.valid)) {
    return NextResponse.json({ error: 'Connect a valid Nexus API key first (Panel Settings).' }, { status: 400 })
  }

  try {
    if (body.action === 'link') {
      const modId = parseNexusModId(body.url ?? '')
      if (!modId) {
        return NextResponse.json({ error: 'Paste a valid Nexus mod URL (nexusmods.com/palworld/mods/…)' }, { status: 400 })
      }
      await linkNexusMod(modKey, modId, body.haveVersion ?? null)
    } else if (body.action === 'markSeen') {
      await markNexusSeen(modKey)
    } else if (body.action === 'unlink') {
      await unlinkNexusMod(modKey)
    } else {
      return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
    }
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Nexus operation failed' },
      { status: 500 },
    )
  }

  return NextResponse.json({ connected: true, isPremium: status.isPremium, mods: await getNexusMods() })
}
