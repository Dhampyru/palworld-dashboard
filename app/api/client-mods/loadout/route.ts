import { NextRequest, NextResponse } from 'next/server'
import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import { classifyPassword, tierForClass } from '@/lib/access-tier'
import { clientIp, isLockedOut, recordFailure } from '@/lib/rate-limit'
import { DEMO_MODE } from '@/lib/demo-mode'
import { PALWORLD_PROXY_HEADERS } from '@/lib/palworld'
import { runWithInstance } from '@/lib/instances'
import { buildClientLoadout } from '@/lib/client-loadout'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// PATCH (not upstream): generate + download the client loadout (docs/specs/client-mod-
// sync.md §2c). GET streams a Classic-UE4SS bundle .zip built from the KEPT client mods.
// Admin-only. `?ue4ss=0` ships mods only (friend supplies UE4SS). Counts go back in
// headers (mod names can be non-ASCII → unsafe in a header); the full list + any skips
// live in the bundle's manifest.json.
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
    return NextResponse.json({ error: 'Forbidden: client loadout is admin-only' }, { status: 403 })
  }
  return null
}

export async function GET(request: NextRequest) {
  return runWithInstance(request.headers.get(PALWORLD_PROXY_HEADERS.instance), () => _GET(request))
}
async function _GET(request: NextRequest) {
  const denied = requireAdmin(request)
  if (denied) return denied
  if (DEMO_MODE) return NextResponse.json({ error: 'Loadout generation is disabled in demo mode' }, { status: 400 })

  const includeUe4ss = request.nextUrl.searchParams.get('ue4ss') !== '0'

  try {
    const { zipPath, fileName, summary, cleanup } = await buildClientLoadout({ includeUe4ss })
    const nodeStream = createReadStream(zipPath)
    // Clean the temp dir once the response has been fully sent (or the client aborts).
    nodeStream.on('close', () => void cleanup())
    nodeStream.on('error', () => void cleanup())
    const body = Readable.toWeb(nodeStream) as unknown as ReadableStream

    return new Response(body, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${fileName}"`,
        'Content-Length': String(summary.sizeBytes),
        'Cache-Control': 'no-store',
        'X-Loadout-Ue4ss': summary.includedUe4ss ? '1' : '0',
        'X-Loadout-Lua': String(summary.luaMods.length),
        'X-Loadout-Pak': String(summary.pakFiles.length),
        'X-Loadout-Logic': String(summary.logicMods.length),
        'X-Loadout-Mods': String(summary.mods.length),
        'X-Loadout-Skipped': String(summary.skipped.length),
        'X-Loadout-Total': String(summary.totalKept),
        'X-Loadout-Config': String(summary.configOverrides),
        'X-Loadout-Size': String(summary.sizeBytes),
      },
    })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Loadout generation failed' }, { status: 500 })
  }
}
