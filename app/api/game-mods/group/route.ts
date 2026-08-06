import { NextRequest, NextResponse } from 'next/server'
import { classifyPassword, tierForClass } from '@/lib/access-tier'
import { clientIp, isLockedOut, recordFailure } from '@/lib/rate-limit'
import { DEMO_MODE } from '@/lib/demo-mode'
import { PALWORLD_PROXY_HEADERS } from '@/lib/palworld'
import { runWithInstance } from '@/lib/instances'
import { nestModUnder } from '@/lib/game-mods'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// PATCH (not upstream): manually nest a mod under a parent (or un-nest). For mods whose
// paks arrived as a separate download from the Lua (so auto-grouping couldn't associate
// them) — see docs/specs/steam-workshop-download.md / nexus. Admin-only. Purely a display
// grouping (data/mod-groups.json); doesn't move files or change what's loaded.
export async function POST(request: NextRequest) {
  return runWithInstance(request.headers.get(PALWORLD_PROXY_HEADERS.instance), () => _POST(request))
}
async function _POST(request: NextRequest) {
  const ip = clientIp(request)
  if (isLockedOut(ip)) return NextResponse.json({ error: 'Too many attempts. Try again later.' }, { status: 429 })
  const passwordClass = classifyPassword(request.headers.get(PALWORLD_PROXY_HEADERS.adminPassword) ?? '')
  if (passwordClass === 'unknown') {
    recordFailure(ip)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (tierForClass(passwordClass) !== 'admin') {
    return NextResponse.json({ error: 'Forbidden: grouping mods is admin-only' }, { status: 403 })
  }
  if (DEMO_MODE) return NextResponse.json({ success: true, dryRun: true })

  let body: { child?: unknown; parent?: unknown }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return NextResponse.json({ error: 'Malformed request body' }, { status: 400 })
  }
  const child = typeof body.child === 'string' ? body.child : ''
  const parent = typeof body.parent === 'string' && body.parent ? body.parent : null
  if (!child) return NextResponse.json({ error: 'child required' }, { status: 400 })

  try {
    await nestModUnder(child, parent)
    return NextResponse.json({ success: true, child, parent })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed' }, { status: 500 })
  }
}
