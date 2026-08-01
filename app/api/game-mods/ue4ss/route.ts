import { NextRequest, NextResponse } from 'next/server'
import { classifyPassword, tierForClass } from '@/lib/access-tier'
import { clientIp, isLockedOut, recordFailure } from '@/lib/rate-limit'
import { DEMO_MODE } from '@/lib/demo-mode'
import { PALWORLD_PROXY_HEADERS } from '@/lib/palworld'
import { runWithInstance } from '@/lib/instances'
import { readUe4ssStatus, setUe4ssEnabled } from '@/lib/game-mods'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// PATCH (not upstream): UE4SS loader status + enable/disable (spec docs/specs/
// ue4ss-loader.md). GET reports the loaded build (from the log banner) + whether
// the dwmapi proxy is active. POST toggles it by renaming the proxy (admin-only;
// effective on next restart). Version install/swap is a separate, guarded route.

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
  if (DEMO_MODE) {
    return NextResponse.json({
      status: {
        installed: true,
        enabled: true,
        loaded: true,
        version: 'v3.0.1 Beta #0',
        sha: 'c2ac246',
        buildConfig: 'Game__Shipping__Win64 (MSVC)',
        source: 'official',
      },
    })
  }
  return NextResponse.json({ status: await readUe4ssStatus() })
}

export async function POST(request: NextRequest) {
  return runWithInstance(request.headers.get(PALWORLD_PROXY_HEADERS.instance), () => _POST(request))
}
async function _POST(request: NextRequest) {
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
    return NextResponse.json({ error: 'Forbidden: UE4SS control is admin-only' }, { status: 403 })
  }

  let enabled = true
  try {
    const body = (await request.json()) as { enabled?: unknown }
    if (typeof body.enabled === 'boolean') enabled = body.enabled
  } catch {
    return NextResponse.json({ error: 'Malformed request body' }, { status: 400 })
  }

  if (DEMO_MODE) {
    return NextResponse.json({ status: await readUe4ssStatus(), dryRun: true })
  }

  try {
    await setUe4ssEnabled(enabled)
    return NextResponse.json({
      status: await readUe4ssStatus(),
      note: enabled
        ? 'UE4SS enabled — restart the server to load it.'
        : 'UE4SS disabled — restart the server to unload it.',
    })
  } catch (error) {
    return NextResponse.json(
      { error: `Failed to toggle UE4SS: ${error instanceof Error ? error.message : 'unknown error'}` },
      { status: 500 },
    )
  }
}
