import { NextRequest, NextResponse } from 'next/server'
import { classifyPassword, tierForClass } from '@/lib/access-tier'
import { clientIp, isLockedOut, recordFailure } from '@/lib/rate-limit'
import { PALWORLD_PROXY_HEADERS } from '@/lib/palworld'
import { runWithInstance } from '@/lib/instances'
import { scanClientKeybinds } from '@/lib/keybind-scan'
import { applyManualRemap, clearRemap, CONFLICT_REMAP, isRemapApplied, PAYLOAD_EDITS } from '@/lib/keybind-remap'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function requireAdmin(request: NextRequest): NextResponse | null {
  const ip = clientIp(request)
  if (isLockedOut(ip)) return NextResponse.json({ error: 'Too many attempts. Try again later.' }, { status: 429 })
  const cls = classifyPassword(request.headers.get(PALWORLD_PROXY_HEADERS.adminPassword) ?? '')
  if (cls === 'unknown') {
    recordFailure(ip)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (tierForClass(cls) !== 'admin') return NextResponse.json({ error: 'Forbidden: admin-only' }, { status: 403 })
  return null
}

// PATCH (not upstream): keybind conflicts across the kept client mods (see lib/keybind-scan).
// GET returns the conflict scan; POST previews/applies/clears the auto-remap (lib/keybind-remap).
// Admin-only, instance-scoped.
export async function GET(request: NextRequest) {
  const denied = requireAdmin(request)
  if (denied) return denied
  return runWithInstance(request.headers.get(PALWORLD_PROXY_HEADERS.instance), async () => {
    try {
      return NextResponse.json(await scanClientKeybinds())
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : 'Scan failed' }, { status: 500 })
    }
  })
}

export async function POST(request: NextRequest) {
  const denied = requireAdmin(request)
  if (denied) return denied
  let body: { action?: unknown }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return NextResponse.json({ error: 'Malformed request body' }, { status: 400 })
  }
  return runWithInstance(request.headers.get(PALWORLD_PROXY_HEADERS.instance), async () => {
    try {
      if (body.action === 'remapPlan')
        return NextResponse.json({ remap: CONFLICT_REMAP, payloadEdits: PAYLOAD_EDITS, applied: await isRemapApplied() })
      if (body.action === 'remapApply') return NextResponse.json({ ok: true, ...(await applyManualRemap()) })
      if (body.action === 'remapClear') return NextResponse.json({ ok: true, cleared: await clearRemap() })
      return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed' }, { status: 500 })
    }
  })
}
