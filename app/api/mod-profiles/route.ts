import { NextRequest, NextResponse } from 'next/server'
import { classifyPassword, tierForClass } from '@/lib/access-tier'
import { clientIp, isLockedOut, recordFailure } from '@/lib/rate-limit'
import { DEMO_MODE } from '@/lib/demo-mode'
import { PALWORLD_PROXY_HEADERS } from '@/lib/palworld'
import { runWithInstance } from '@/lib/instances'
import {
  bulkSetAll,
  computeDrift,
  deleteProfile,
  listProfilesWithStatus,
  matchDrift,
  renameProfile,
  restoreProfile,
  saveProfile,
} from '@/lib/mod-profiles'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// PATCH (not upstream): unified mod profiles (lib/mod-profiles.ts). GET lists saved profiles
// + the current server↔client drift; POST saves/restores/renames/deletes a profile or
// resolves one drift. Admin-only throughout — a profile spans the server mod state AND the
// client loadout selection, and every mutation changes real behavior (next restart / next
// bundle), same bar as the game-mods toggle.

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
    return NextResponse.json({ error: 'Forbidden: mod profiles are admin-only' }, { status: 403 })
  }
  return null
}

export async function GET(request: NextRequest) {
  return runWithInstance(request.headers.get(PALWORLD_PROXY_HEADERS.instance), () => _GET(request))
}
async function _GET(request: NextRequest) {
  const denied = requireAdmin(request)
  if (denied) return denied
  if (DEMO_MODE) return NextResponse.json({ profiles: [], drift: [] })
  try {
    const [profiles, drift] = await Promise.all([listProfilesWithStatus(), computeDrift()])
    return NextResponse.json({ profiles, drift })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed to read profiles' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  return runWithInstance(request.headers.get(PALWORLD_PROXY_HEADERS.instance), () => _POST(request))
}
async function _POST(request: NextRequest) {
  const denied = requireAdmin(request)
  if (denied) return denied

  let body: {
    action?: string
    id?: string
    name?: string
    note?: string
    serverId?: string
    clientId?: string
    authoritative?: string
    enabled?: boolean
  }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return NextResponse.json({ error: 'Malformed request body' }, { status: 400 })
  }

  if (DEMO_MODE) return NextResponse.json({ dryRun: true })

  try {
    switch (body.action) {
      case 'save': {
        const profile = await saveProfile(String(body.name ?? ''), body.note)
        return NextResponse.json({ profile, note: `Saved profile "${profile.name}".` })
      }
      case 'restore': {
        if (typeof body.id !== 'string') return NextResponse.json({ error: 'id required' }, { status: 400 })
        const report = await restoreProfile(body.id)
        return NextResponse.json({ report })
      }
      case 'rename': {
        if (typeof body.id !== 'string') return NextResponse.json({ error: 'id required' }, { status: 400 })
        const profile = await renameProfile(body.id, String(body.name ?? ''))
        return NextResponse.json({ profile })
      }
      case 'delete': {
        if (typeof body.id !== 'string') return NextResponse.json({ error: 'id required' }, { status: 400 })
        await deleteProfile(body.id)
        return NextResponse.json({ deleted: body.id })
      }
      case 'setAll': {
        if (typeof body.enabled !== 'boolean') return NextResponse.json({ error: 'enabled required' }, { status: 400 })
        const result = await bulkSetAll(body.enabled)
        return NextResponse.json({ result })
      }
      case 'matchDrift': {
        if (typeof body.serverId !== 'string' || typeof body.clientId !== 'string') {
          return NextResponse.json({ error: 'serverId and clientId required' }, { status: 400 })
        }
        const authoritative = body.authoritative === 'client' ? 'client' : 'server'
        await matchDrift(body.serverId, body.clientId, authoritative)
        return NextResponse.json({ ok: true, authoritative })
      }
      default:
        return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
    }
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Profile action failed' }, { status: 500 })
  }
}
