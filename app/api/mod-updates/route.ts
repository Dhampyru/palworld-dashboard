import { NextRequest, NextResponse } from 'next/server'
import { classifyPassword, tierForClass } from '@/lib/access-tier'
import { clientIp, isLockedOut, recordFailure } from '@/lib/rate-limit'
import { DEMO_MODE } from '@/lib/demo-mode'
import { PALWORLD_PROXY_HEADERS } from '@/lib/palworld'
import { runWithInstance } from '@/lib/instances'
import { getNexusMods, getNexusStatus } from '@/lib/nexus'
import { readSteamMods } from '@/lib/game-mods'
import { getSteamModUpdates } from '@/lib/steam'
import { checkClientModUpdates } from '@/lib/client-mods'
import { checkFrameworkUpdates } from '@/lib/framework-updates'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// PATCH (not upstream): dashboard-wide MOD-ecosystem update indicator. Aggregates the count of
// items with an update available across the server mods (Nexus assocs + Steam Workshop), the
// client loadout store, AND the frameworks (UE4SS + PalSchema) — so the header pill (rendered on
// every tab) surfaces them without the admin being on the Mods tab. (The GAME server update has
// its own pill via /api/check-update.) All sources are cache-aware (Nexus 30d/sweep, client 30d,
// Steam one keyless batched call, framework cached), so a 30-min poll is cheap after the first
// warm pass. Best-effort: any source that errors (no key, offline) contributes 0 rather than
// failing the whole count.
function presentedPassword(request: NextRequest) {
  return request.headers.get(PALWORLD_PROXY_HEADERS.adminPassword) ?? ''
}

export async function GET(request: NextRequest) {
  return runWithInstance(request.headers.get(PALWORLD_PROXY_HEADERS.instance), () => _GET(request))
}
async function _GET(request: NextRequest) {
  const ip = clientIp(request)
  if (isLockedOut(ip)) return NextResponse.json({ error: 'Too many attempts. Try again later.' }, { status: 429 })
  const passwordClass = classifyPassword(presentedPassword(request))
  if (passwordClass === 'unknown') {
    recordFailure(ip)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  // Updates are an admin concern (only admins can apply them); mod tier just gets zeros so the
  // pill never shows for them.
  if (tierForClass(passwordClass) !== 'admin' || DEMO_MODE) {
    return NextResponse.json({ server: 0, client: 0, total: 0 })
  }

  const clientP: Promise<number> = checkClientModUpdates().catch(() => 0)

  const nexusP: Promise<number> = (async () => {
    try {
      const status = await getNexusStatus()
      if (!(status.configured && status.valid)) return 0
      const mods = await getNexusMods()
      // Dedupe by Nexus modId: a COMBINED mod (e.g. RTR's `ue4ss:` + `palschema:` halves) has two
      // associations pointing at the same modId, and both flip updateAvailable — count it ONCE so
      // the pill matches reality (was over-counting combined mods).
      const seen = new Set<number>()
      for (const m of Object.values(mods)) if (m.updateAvailable) seen.add(m.modId)
      return seen.size
    } catch {
      return 0
    }
  })()

  const steamP: Promise<number> = (async () => {
    try {
      const ids = Object.values(await readSteamMods()).map((l) => l.itemId).filter(Boolean)
      if (!ids.length) return 0
      const upd = await getSteamModUpdates(ids)
      return Object.values(upd).filter((u) => u.updateAvailable).length
    } catch {
      return 0
    }
  })()

  // Framework (UE4SS + PalSchema) — cache-aware; PalSchema is a hard semver check, UE4SS a
  // rolling tag so it only counts when it flips to a definite update (boolean true, not null).
  const frameworkP: Promise<number> = (async () => {
    try {
      const u = await checkFrameworkUpdates(false)
      return (u.palschema.updateAvailable ? 1 : 0) + (u.ue4ss.updateAvailable === true ? 1 : 0)
    } catch {
      return 0
    }
  })()

  const [client, nexusServer, steamServer, framework] = await Promise.all([clientP, nexusP, steamP, frameworkP])
  const server = nexusServer + steamServer
  return NextResponse.json({ server, client, framework, total: server + client + framework })
}
