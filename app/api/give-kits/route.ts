import { NextRequest, NextResponse } from 'next/server'
import { classifyPassword, tierForClass } from '@/lib/access-tier'
import { clientIp, isLockedOut, recordFailure } from '@/lib/rate-limit'
import { DEMO_MODE } from '@/lib/demo-mode'
import { PALWORLD_PROXY_HEADERS } from '@/lib/palworld'
import { runWithInstance, currentInstanceId } from '@/lib/instances'
import { deleteKit, giveKit, listKits, saveKit } from '@/lib/give-kits'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// PATCH (not upstream): reusable give-items kits (docs/specs/give-kits.md). GET lists kits;
// POST save/delete edits them and `give` runs the PalDefender `giveitems` for a player.
// Admin-only — `giveitems` is an admin-cheat command, same gate as the RCON console.
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
    return NextResponse.json({ error: 'Forbidden: give-kits are admin-only' }, { status: 403 })
  }
  return null
}

export async function GET(request: NextRequest) {
  return runWithInstance(request.headers.get(PALWORLD_PROXY_HEADERS.instance), async () => {
    const denied = requireAdmin(request)
    if (denied) return denied
    return NextResponse.json({ kits: await listKits() })
  })
}

export async function POST(request: NextRequest) {
  return runWithInstance(request.headers.get(PALWORLD_PROXY_HEADERS.instance), async () => {
    const denied = requireAdmin(request)
    if (denied) return denied
    if (DEMO_MODE) return NextResponse.json({ error: 'Disabled in demo mode' }, { status: 400 })
    let body: { action?: string; kit?: unknown; id?: string; kitId?: string; userId?: string }
    try {
      body = (await request.json()) as typeof body
    } catch {
      return NextResponse.json({ error: 'Malformed request body' }, { status: 400 })
    }
    try {
      switch (body.action) {
        case 'save':
          return NextResponse.json({ kit: await saveKit(body.kit), kits: await listKits() })
        case 'delete':
          if (!body.id) return NextResponse.json({ error: 'id required' }, { status: 400 })
          await deleteKit(body.id)
          return NextResponse.json({ kits: await listKits() })
        case 'give': {
          if (!body.kitId || !body.userId)
            return NextResponse.json({ error: 'kitId and userId required' }, { status: 400 })
          const result = await giveKit(body.kitId, body.userId, currentInstanceId())
          return NextResponse.json(result)
        }
        default:
          return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
      }
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : 'give-kits action failed' }, { status: 500 })
    }
  })
}
