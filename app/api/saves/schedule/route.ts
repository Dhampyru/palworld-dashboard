import { NextRequest, NextResponse } from 'next/server'
import { classifyPassword, tierForClass } from '@/lib/access-tier'
import { clientIp, isLockedOut, recordFailure } from '@/lib/rate-limit'
import { DEMO_MODE } from '@/lib/demo-mode'
import { PALWORLD_PROXY_HEADERS } from '@/lib/palworld'
import { readSchedule, runAutoBackup, saveScheduleSettings } from '@/lib/backup-schedule'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// PATCH (not upstream): auto-backup schedule (roadmap #5 extension). GET returns
// the current settings + last-run status; POST saves settings or runs a Test
// backup now. Admin-only. The scheduler itself runs in-process from
// instrumentation.ts; this route only reads/writes its settings file.

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
    return NextResponse.json({ error: 'Forbidden: saves are admin-only' }, { status: 403 })
  }
  return null
}

function instanceOf(request: NextRequest): string {
  return request.headers.get(PALWORLD_PROXY_HEADERS.instance) || 'default'
}

export async function GET(request: NextRequest) {
  const denied = requireAdmin(request)
  if (denied) return denied
  return NextResponse.json({ schedule: readSchedule(instanceOf(request)) })
}

export async function POST(request: NextRequest) {
  const denied = requireAdmin(request)
  if (denied) return denied

  let body: { action?: unknown; settings?: unknown }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return NextResponse.json({ error: 'Malformed request body' }, { status: 400 })
  }

  if (body.action !== 'save' && body.action !== 'test') {
    return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
  }

  const instanceId = instanceOf(request)

  if (DEMO_MODE) {
    return NextResponse.json({ schedule: readSchedule(instanceId), dryRun: true })
  }

  try {
    if (body.action === 'save') {
      const s = (body.settings ?? {}) as Record<string, unknown>
      const schedule = saveScheduleSettings(instanceId, {
        enabled: typeof s.enabled === 'boolean' ? s.enabled : undefined,
        intervalMinutes: typeof s.intervalMinutes === 'number' ? s.intervalMinutes : undefined,
        keep: typeof s.keep === 'number' ? s.keep : undefined,
        keepPre: typeof s.keepPre === 'number' ? s.keepPre : undefined,
        keepManual: typeof s.keepManual === 'number' ? s.keepManual : undefined,
        skipWhenEmpty: typeof s.skipWhenEmpty === 'boolean' ? s.skipWhenEmpty : undefined,
      })
      return NextResponse.json({ schedule, note: 'Auto-backup settings saved.' })
    }

    // test: force a backup now, ignoring the enabled/interval/empty gates.
    const schedule = await runAutoBackup(instanceId, { force: true })
    const note =
      schedule.lastStatus === 'ok'
        ? 'Test backup created.'
        : schedule.lastMessage ?? 'Test run finished.'
    return NextResponse.json({ schedule, note })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Operation failed' },
      { status: 500 },
    )
  }
}
