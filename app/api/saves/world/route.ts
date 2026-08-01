import { NextRequest, NextResponse } from 'next/server'
import { classifyPassword, tierForClass } from '@/lib/access-tier'
import { clientIp, isLockedOut, recordFailure } from '@/lib/rate-limit'
import { DEMO_MODE } from '@/lib/demo-mode'
import { PALWORLD_PROXY_HEADERS } from '@/lib/palworld'
import { runWithInstance } from '@/lib/instances'
import { inspectWorld, readActiveWorldId } from '@/lib/saves'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// PATCH (not upstream): World inspector (roadmap item 3, Stage 2). Loads the
// active world's Level.sav + Players/ via the vendored psp-inspect helper and
// returns per-player summaries (nickname/level/pal_count/guild) + every Pal
// (species/level/owner). Admin-only, read-only. Can be a heavier call than the
// rest of /api/saves (it parses the whole world), so it's its own route.

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

  if (DEMO_MODE) {
    return NextResponse.json({ worldId: null, players: [], guilds: [], pals: [], demo: true })
  }

  const worldId = await readActiveWorldId()
  if (!worldId) return NextResponse.json({ error: 'No active world' }, { status: 400 })

  try {
    const data = (await inspectWorld(worldId)) as Record<string, unknown>
    return NextResponse.json({ worldId, ...data })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to inspect world' },
      { status: 500 },
    )
  }
}
