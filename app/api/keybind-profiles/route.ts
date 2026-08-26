import { NextRequest, NextResponse } from 'next/server'
import { classifyPassword, tierForClass } from '@/lib/access-tier'
import { clientIp, isLockedOut, recordFailure } from '@/lib/rate-limit'
import { DEMO_MODE } from '@/lib/demo-mode'
import { PALWORLD_PROXY_HEADERS } from '@/lib/palworld'
import { runWithInstance } from '@/lib/instances'
import { deleteProfile, listProfiles, renameProfile, restoreProfile, saveProfile } from '@/lib/keybind-profiles'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// PATCH (not upstream): Keybind Manager Phase 3 — named keybind profiles (lib/keybind-profiles.ts).
// GET lists saved profiles; POST saves/restores/renames/deletes. Admin-only — a restore rewrites the
// loadout's keybind overrides, same bar as the remap itself. Instance-scoped like the other routes.
function requireAdmin(request: NextRequest): NextResponse | null {
  const ip = clientIp(request)
  if (isLockedOut(ip)) return NextResponse.json({ error: 'Too many attempts. Try again later.' }, { status: 429 })
  const cls = classifyPassword(request.headers.get(PALWORLD_PROXY_HEADERS.adminPassword) ?? '')
  if (cls === 'unknown') {
    recordFailure(ip)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (tierForClass(cls) !== 'admin') return NextResponse.json({ error: 'Forbidden: keybind profiles are admin-only' }, { status: 403 })
  return null
}

export async function GET(request: NextRequest) {
  const denied = requireAdmin(request)
  if (denied) return denied
  if (DEMO_MODE) return NextResponse.json({ profiles: [] })
  return runWithInstance(request.headers.get(PALWORLD_PROXY_HEADERS.instance), async () => {
    try {
      return NextResponse.json({ profiles: await listProfiles() })
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed to read profiles' }, { status: 500 })
    }
  })
}

export async function POST(request: NextRequest) {
  const denied = requireAdmin(request)
  if (denied) return denied
  let body: { action?: string; id?: string; name?: string; note?: string }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return NextResponse.json({ error: 'Malformed request body' }, { status: 400 })
  }
  if (DEMO_MODE) return NextResponse.json({ dryRun: true })
  return runWithInstance(request.headers.get(PALWORLD_PROXY_HEADERS.instance), async () => {
    try {
      switch (body.action) {
        case 'save': {
          const profile = await saveProfile(String(body.name ?? ''), body.note)
          return NextResponse.json({ profile, note: `Saved keybind profile "${profile.name}".` })
        }
        case 'restore': {
          if (typeof body.id !== 'string') return NextResponse.json({ error: 'id required' }, { status: 400 })
          const report = await restoreProfile(body.id)
          return NextResponse.json({ report })
        }
        case 'rename': {
          if (typeof body.id !== 'string') return NextResponse.json({ error: 'id required' }, { status: 400 })
          return NextResponse.json({ profile: await renameProfile(body.id, String(body.name ?? '')) })
        }
        case 'delete': {
          if (typeof body.id !== 'string') return NextResponse.json({ error: 'id required' }, { status: 400 })
          await deleteProfile(body.id)
          return NextResponse.json({ deleted: body.id })
        }
        default:
          return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
      }
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : 'Profile action failed' }, { status: 500 })
    }
  })
}
