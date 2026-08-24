import { NextRequest, NextResponse } from 'next/server'
import { classifyPassword } from '@/lib/access-tier'
import { clientIp, isLockedOut, recordFailure } from '@/lib/rate-limit'
import { DEMO_MODE } from '@/lib/demo-mode'
import { PALWORLD_PROXY_HEADERS } from '@/lib/palworld'
import { runWithInstance } from '@/lib/instances'
import { getCategories, type ModSourceLink } from '@/lib/mod-categories'
import { readNexusAssocIds } from '@/lib/nexus'
import { readSteamMods } from '@/lib/game-mods'
import { listClientMods } from '@/lib/client-mods'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// PATCH (not upstream): genre categories for the Mods-page category grouping. Read-only
// (both tiers may view mods, matching /api/game-mods GET). Resolves Nexus/Steam categories
// (cached in data/mod-categories.json) for every server + client mod association and returns
// a map keyed by SOURCE IDENTITY (`nexus:<modId>` / `steam:<itemId>`); both panels map their
// own mods to it. Manual uploads have no source link and simply aren't present in the map.
function requireAuth(request: NextRequest): NextResponse | null {
  const ip = clientIp(request)
  if (isLockedOut(ip)) return NextResponse.json({ error: 'Too many attempts. Try again later.' }, { status: 429 })
  if (classifyPassword(request.headers.get(PALWORLD_PROXY_HEADERS.adminPassword) ?? '') === 'unknown') {
    recordFailure(ip)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return null
}

export async function GET(request: NextRequest) {
  const denied = requireAuth(request)
  if (denied) return denied
  if (DEMO_MODE) return NextResponse.json({ categories: {} })
  return runWithInstance(request.headers.get(PALWORLD_PROXY_HEADERS.instance), async () => {
    const links: ModSourceLink[] = []
    try {
      const [nexus, steam, client] = await Promise.all([readNexusAssocIds(), readSteamMods(), listClientMods()])
      for (const modId of Object.values(nexus)) links.push({ source: 'nexus', sourceId: String(modId) })
      for (const v of Object.values(steam)) if (v?.itemId) links.push({ source: 'steam', sourceId: v.itemId })
      for (const m of client) {
        if ((m.source === 'nexus' || m.source === 'steam') && m.sourceId) links.push({ source: m.source, sourceId: m.sourceId })
      }
    } catch {
      /* partial link set is fine — resolve whatever we gathered */
    }
    try {
      return NextResponse.json({ categories: await getCategories(links) })
    } catch {
      return NextResponse.json({ categories: {} })
    }
  })
}
