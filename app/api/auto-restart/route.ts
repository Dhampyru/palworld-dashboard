import { NextRequest, NextResponse } from 'next/server'
import { classifyPassword, tierForClass } from '@/lib/access-tier'
import { clientIp, isLockedOut, recordFailure } from '@/lib/rate-limit'
import { DEMO_MODE } from '@/lib/demo-mode'
import { PALWORLD_PROXY_HEADERS } from '@/lib/palworld'
import {
  computeNextScheduled,
  readAutoRestart,
  readMetrics,
  recentTriggers,
  saveAutoRestartSettings,
  testAutoRestart,
} from '@/lib/auto-restart'

// One shape for GET and every POST reply: settings + live metrics + the derived
// bits (next scheduled fire, restarts used this hour) the card + Overview chip
// both read.
function snapshot(id: string) {
  const settings = readAutoRestart(id)
  const metrics = readMetrics(id)
  return {
    settings,
    metrics,
    nextScheduled: computeNextScheduled(settings, metrics),
    usedThisHour: recentTriggers(settings.ledger),
  }
}

function instanceOf(request: NextRequest): string {
  return request.headers.get(PALWORLD_PROXY_HEADERS.instance) || 'default'
}

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// PATCH (not upstream): auto-restart config (roadmap #6). GET returns settings +
// the host publisher's latest metrics (so the UI can show live memory and help
// pick a threshold). POST saves settings or fires a dry-run Test restart. The
// monitor itself runs in-process from instrumentation.ts. Admin-only.

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
    return NextResponse.json({ error: 'Forbidden: server management is admin-only' }, { status: 403 })
  }
  return null
}

export async function GET(request: NextRequest) {
  const denied = requireAdmin(request)
  if (denied) return denied
  return NextResponse.json(snapshot(instanceOf(request)))
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

  const id = instanceOf(request)

  if (DEMO_MODE) {
    return NextResponse.json({ ...snapshot(id), dryRun: true })
  }

  try {
    if (body.action === 'save') {
      const s = (body.settings ?? {}) as Record<string, unknown>
      const num = (v: unknown) => (typeof v === 'number' ? v : undefined)
      const bool = (v: unknown) => (typeof v === 'boolean' ? v : undefined)
      saveAutoRestartSettings(id, {
        scheduledEnabled: bool(s.scheduledEnabled),
        scheduleMode: s.scheduleMode === 'interval' || s.scheduleMode === 'daily' ? s.scheduleMode : undefined,
        everyMinutes: num(s.everyMinutes),
        dailyTimes: Array.isArray(s.dailyTimes) ? (s.dailyTimes as string[]) : undefined,
        memoryEnabled: bool(s.memoryEnabled),
        memoryMb: num(s.memoryMb),
        memorySustainedChecks: num(s.memorySustainedChecks),
        crashEnabled: bool(s.crashEnabled),
        maxPerHour: num(s.maxPerHour),
        restartWaittime: num(s.restartWaittime),
      })
      return NextResponse.json({ ...snapshot(id), note: 'Restart automation settings saved.' })
    }

    // test: dry-run restart request — exercises the full path (monitor →
    // restart.request → host handler → RCON broadcast) without recreating.
    testAutoRestart(id, true)
    return NextResponse.json({
      ...snapshot(id),
      note: 'Test restart queued (dry run — countdown broadcast only, no recreate).',
    })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Operation failed' },
      { status: 500 },
    )
  }
}
