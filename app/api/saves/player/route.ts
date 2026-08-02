import { NextRequest, NextResponse } from 'next/server'
import { classifyPassword, tierForClass } from '@/lib/access-tier'
import { clientIp, isLockedOut, recordFailure } from '@/lib/rate-limit'
import { DEMO_MODE } from '@/lib/demo-mode'
import { demoInventory } from '@/lib/demo'
import { PALWORLD_PROXY_HEADERS } from '@/lib/palworld'
import { runWithInstance } from '@/lib/instances'
import { inspectPlayerInventory, readActiveWorldId } from '@/lib/saves'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// PATCH (not upstream): per-player inventory (roadmap item 5, Stage 2b).
// Read-only: loads one player's five item containers from the active world's
// save via the vendored psp-player helper. Admin-only. Lazy -- the panel calls
// it only when a player is inspected, so the heavier per-player parse isn't paid
// on every world load.

function presentedPassword(request: NextRequest) {
  return request.headers.get(PALWORLD_PROXY_HEADERS.adminPassword) ?? ''
}

export async function GET(request: NextRequest) {
  return runWithInstance(request.headers.get(PALWORLD_PROXY_HEADERS.instance), () => _GET(request))
}
async function _GET(request: NextRequest) {
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
    return NextResponse.json({ error: 'Forbidden: saves are admin-only' }, { status: 403 })
  }

  const uid = request.nextUrl.searchParams.get('uid') ?? ''
  if (!/^[0-9a-fA-F]{32}$/.test(uid)) {
    return NextResponse.json({ error: 'Invalid player id' }, { status: 400 })
  }

  if (DEMO_MODE) {
    return NextResponse.json({ ...demoInventory, uid, demo: true })
  }

  const worldId = await readActiveWorldId()
  if (!worldId) return NextResponse.json({ error: 'No active world' }, { status: 400 })

  try {
    const data = await inspectPlayerInventory(worldId, uid)
    return NextResponse.json({ worldId, ...data })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to read inventory' },
      { status: 500 },
    )
  }
}
