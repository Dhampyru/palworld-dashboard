import { NextRequest, NextResponse } from 'next/server'
import { classifyPassword, tierForClass } from '@/lib/access-tier'
import { clientIp, isLockedOut, recordFailure } from '@/lib/rate-limit'
import { DEMO_MODE } from '@/lib/demo-mode'
import { PALWORLD_PROXY_HEADERS } from '@/lib/palworld'
import { runWithInstance } from '@/lib/instances'
import { checkFrameworkUpdates, markUe4ssUpdateInstalled } from '@/lib/framework-updates'
import { listUe4ssBackups } from '@/lib/game-mods'
import {
  listPalSchemaLoaderBackups,
  rollbackPalSchemaLoader,
  updatePalSchemaLoader,
} from '@/lib/palschema'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// PATCH (not upstream): UE4SS/PalSchema update checks + PalSchema update-with-rollback
// (docs/specs/framework-updates.md). Admin-only — these swap framework files. UE4SS
// update/rollback reuse the existing /api/game-mods/ue4ss/install route.
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
    return NextResponse.json({ error: 'Forbidden: framework updates are admin-only' }, { status: 403 })
  }
  return null
}

export async function GET(request: NextRequest) {
  return runWithInstance(request.headers.get(PALWORLD_PROXY_HEADERS.instance), async () => {
    const denied = requireAdmin(request)
    if (denied) return denied
    const force = request.nextUrl.searchParams.get('refresh') === '1'
    const [updates, palschemaBackups, ue4ssBackups] = await Promise.all([
      checkFrameworkUpdates(force),
      listPalSchemaLoaderBackups(),
      listUe4ssBackups(),
    ])
    return NextResponse.json({ updates, palschemaBackups, ue4ssBackups })
  })
}

export async function POST(request: NextRequest) {
  return runWithInstance(request.headers.get(PALWORLD_PROXY_HEADERS.instance), async () => {
    const denied = requireAdmin(request)
    if (denied) return denied
    if (DEMO_MODE) return NextResponse.json({ error: 'Disabled in demo mode' }, { status: 400 })
    let body: { action?: string; tag?: string; file?: string }
    try {
      body = (await request.json()) as typeof body
    } catch {
      return NextResponse.json({ error: 'Malformed request body' }, { status: 400 })
    }
    try {
      switch (body.action) {
        case 'palschemaUpdate': {
          if (!body.tag) return NextResponse.json({ error: 'tag required' }, { status: 400 })
          const r = await updatePalSchemaLoader(body.tag)
          return NextResponse.json({ ...r, note: `PalSchema updated to ${r.version ?? body.tag} — restart the server to load it.` })
        }
        case 'palschemaRollback': {
          if (!body.file) return NextResponse.json({ error: 'file required' }, { status: 400 })
          const r = await rollbackPalSchemaLoader(body.file)
          return NextResponse.json({ ...r, note: `Rolled PalSchema back to ${r.version ?? 'the backup'} — restart the server.` })
        }
        // Re-baseline the UE4SS Workshop-update check to "now" — clears the update flag after
        // the operator has updated the UE4SS build (or to dismiss a flagged update).
        case 'markUe4ssInstalled': {
          const r = await markUe4ssUpdateInstalled()
          return NextResponse.json({ ...r, note: 'Marked the current UE4SS build as up to date.' })
        }
        default:
          return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
      }
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : 'Framework action failed' }, { status: 500 })
    }
  })
}
