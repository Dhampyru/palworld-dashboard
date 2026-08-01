import { NextRequest, NextResponse } from 'next/server'
import { classifyPassword, tierForClass } from '@/lib/access-tier'
import { clientIp, isLockedOut, recordFailure } from '@/lib/rate-limit'
import { DEMO_MODE } from '@/lib/demo-mode'
import { PALWORLD_PROXY_HEADERS } from '@/lib/palworld'
import { runWithInstance } from '@/lib/instances'
import { downloadWorkshopItem, getSteamStatus, isFrameworkWorkshopId, parseWorkshopId } from '@/lib/steam'
import { installWorkshopPackageToProxy } from '@/lib/game-mods'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// PATCH (not upstream): install a Steam Workshop mod from a URL/ID (docs/specs/
// steam-workshop-download.md, Inc 2). Admin + a connected Steam account. Downloads
// with the cached session into the Workshop content dir the loader watches; in the
// Workshop regime it also activates the package (ActiveModList).
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
    return NextResponse.json({ error: 'Forbidden: Workshop install is admin-only' }, { status: 403 })
  }
  return null
}

export async function POST(request: NextRequest) {
  return runWithInstance(request.headers.get(PALWORLD_PROXY_HEADERS.instance), () => _POST(request))
}
async function _POST(request: NextRequest) {
  const denied = requireAdmin(request)
  if (denied) return denied
  if (DEMO_MODE) return NextResponse.json({ dryRun: true })

  const status = await getSteamStatus()
  if (!status.configured) {
    return NextResponse.json(
      { error: 'Connect a Steam account first (Panel Settings → Steam).' },
      { status: 400 },
    )
  }

  let body: { url?: string }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return NextResponse.json({ error: 'Malformed request body' }, { status: 400 })
  }
  const itemId = parseWorkshopId(body.url ?? '')
  if (!itemId) {
    return NextResponse.json({ error: 'Paste a valid Steam Workshop URL or item id' }, { status: 400 })
  }
  if (isFrameworkWorkshopId(itemId)) {
    return NextResponse.json(
      {
        error:
          "That's a framework you already have (UE4SS / PalSchema) — it's installed and managed by the UE4SS Loader / PalSchema sections. Installing the Workshop copy would clobber it, so it's blocked. Install actual mods here instead.",
      },
      { status: 400 },
    )
  }

  try {
    // Download to the staging content dir, then place its server parts into the
    // proxy layout the running UE4SS/PalSchema already load from (Option B).
    const { contentDir } = await downloadWorkshopItem(itemId)
    const result = await installWorkshopPackageToProxy(contentDir, itemId)
    const name = result.modName ?? result.packageName
    const where = result.installed.map((i) => i.type).join(' + ')
    const note = `Installed ${name} into your UE4SS setup (${where}) — restart the server to load it.${
      result.skipped.length ? ` Skipped: ${result.skipped.join(', ')}.` : ''
    }`
    return NextResponse.json({ itemId, ...result, note })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Workshop install failed' },
      { status: 500 },
    )
  }
}
