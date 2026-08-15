import { NextRequest, NextResponse } from 'next/server'
import { classifyPassword, tierForClass } from '@/lib/access-tier'
import { clientIp, isLockedOut, recordFailure } from '@/lib/rate-limit'
import { PALWORLD_PROXY_HEADERS } from '@/lib/palworld'
import { runWithInstance } from '@/lib/instances'
import { scanClientKeybinds } from '@/lib/keybind-scan'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// PATCH (not upstream): report keybind conflicts across the kept client mods (see
// lib/keybind-scan). Admin-only, instance-scoped, cached by the mod-set signature.
export async function GET(request: NextRequest) {
  const ip = clientIp(request)
  if (isLockedOut(ip)) return NextResponse.json({ error: 'Too many attempts. Try again later.' }, { status: 429 })
  const cls = classifyPassword(request.headers.get(PALWORLD_PROXY_HEADERS.adminPassword) ?? '')
  if (cls === 'unknown') {
    recordFailure(ip)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (tierForClass(cls) !== 'admin') {
    return NextResponse.json({ error: 'Forbidden: admin-only' }, { status: 403 })
  }
  return runWithInstance(request.headers.get(PALWORLD_PROXY_HEADERS.instance), async () => {
    try {
      return NextResponse.json(await scanClientKeybinds())
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : 'Scan failed' }, { status: 500 })
    }
  })
}
