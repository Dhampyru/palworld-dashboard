import { NextRequest, NextResponse } from 'next/server'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { classifyPassword } from '@/lib/access-tier'
import { clientIp, isLockedOut, recordFailure } from '@/lib/rate-limit'
import { DEMO_MODE } from '@/lib/demo-mode'
import { PALWORLD_PROXY_HEADERS } from '@/lib/palworld'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// PATCH (not upstream): "is an update available" as a genuinely read-only
// check, safe to run anytime -- even with players online -- since it never
// touches the running server or SteamCMD at all. Two independent reads:
//  1. The LATEST public buildid, from steamcmd.net's free, open, read-only
//     API (a community-run mirror of steamcmd's own app_info data).
//  2. The INSTALLED buildid, read directly from the local appmanifest file
//     SteamCMD itself already maintains -- no steamcmd invocation needed.
// Actually applying an update is a separate, disruptive action -- that's just
// the existing Restart button (ALWAYS_UPDATE_ON_START=true means a restart
// already triggers SteamCMD's own update-check-and-apply on boot).
const APP_ID = '2394010'
const GAME_DIR = process.env.PALWORLD_GAME_DIR ?? '/palworld-game'
const MANIFEST_PATH = join(GAME_DIR, 'steamapps', `appmanifest_${APP_ID}.acf`)

function presentedPassword(request: NextRequest) {
  return request.headers.get(PALWORLD_PROXY_HEADERS.adminPassword) ?? ''
}

function extractField(vdf: string, field: string): string | null {
  // appmanifest .acf files are Valve's simple VDF format -- "key"  "value"
  // pairs, one per line. A targeted regex is plenty for pulling one field;
  // a full VDF parser would be overkill for this narrow need.
  const match = vdf.match(new RegExp(`"${field}"\\s+"([^"]*)"`))
  return match ? match[1] : null
}

export async function GET(request: NextRequest) {
  const ip = clientIp(request)
  if (isLockedOut(ip)) {
    return NextResponse.json({ error: 'Too many attempts. Try again later.' }, { status: 429 })
  }
  const passwordClass = classifyPassword(presentedPassword(request))
  if (passwordClass === 'unknown') {
    recordFailure(ip)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  // Read-only, informational -- both tiers may check for updates.

  if (DEMO_MODE) {
    return NextResponse.json({ installedBuildId: '24088465', latestBuildId: '24088465', updateAvailable: false })
  }

  let installedBuildId: string | null = null
  try {
    const manifest = await readFile(MANIFEST_PATH, 'utf8')
    installedBuildId = extractField(manifest, 'buildid')
  } catch (error) {
    return NextResponse.json(
      { error: `Couldn't read local appmanifest: ${error instanceof Error ? error.message : 'unknown error'}` },
      { status: 500 }
    )
  }

  let latestBuildId: string | null = null
  try {
    const res = await fetch(`https://api.steamcmd.net/v1/info/${APP_ID}`, { cache: 'no-store' })
    if (!res.ok) throw new Error(`steamcmd.net returned ${res.status}`)
    const data = await res.json()
    latestBuildId = data?.data?.[APP_ID]?.depots?.branches?.public?.buildid ?? null
  } catch (error) {
    return NextResponse.json(
      { error: `Couldn't reach steamcmd.net: ${error instanceof Error ? error.message : 'unknown error'}`, installedBuildId },
      { status: 502 }
    )
  }

  if (!installedBuildId || !latestBuildId) {
    return NextResponse.json({ error: 'Could not determine build IDs', installedBuildId, latestBuildId }, { status: 500 })
  }

  return NextResponse.json({
    installedBuildId,
    latestBuildId,
    updateAvailable: installedBuildId !== latestBuildId,
  })
}
