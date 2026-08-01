import { NextRequest, NextResponse } from 'next/server'
import { writeFile, rename, mkdir } from 'node:fs/promises'
import { classifyPassword, tierForClass } from '@/lib/access-tier'
import { DEMO_MODE } from '@/lib/demo-mode'
import { clientIp, isLockedOut, recordFailure } from '@/lib/rate-limit'
import { PALWORLD_PROXY_HEADERS } from '@/lib/palworld'
import { resolveLifecyclePaths } from '@/lib/instances'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Companion to /api/server-restart, same host-side pattern: the dashboard has
// no sudo and cannot itself run `docker compose stop`. This route only writes
// a request flag file it already owns; a root-owned systemd path-unit +
// worker (palworld-shutdown.path/.service) consumes it, broadcasts the
// message, waits (checking for cancellation), then runs `docker compose stop`
// -- a genuine stop, unlike calling the game's own REST /shutdown endpoint
// directly, which Docker's restart policy just brings straight back up.
// Multi-instance (#7): flag path resolved per instance — `default` keeps the
// flat path (proven systemd unit); non-default writes /run/palworld/<id>/
// shutdown.request for the palworld-control daemon.
const MAX_WAIT = 1800

function presentedPassword(request: NextRequest) {
  return request.headers.get(PALWORLD_PROXY_HEADERS.adminPassword) ?? ''
}

// Admin-tier gate shared by POST (request) and DELETE (cancel). Server control
// is admin-only: mod tier is rejected here, before any file is written. Returns
// a rejection response, or null when the caller is authorized as admin.
function adminGate(request: NextRequest): NextResponse | null {
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
    return NextResponse.json({ error: 'Forbidden: server stop is admin-only' }, { status: 403 })
  }
  return null
}

export async function POST(request: NextRequest) {
  const denied = adminGate(request)
  if (denied) return denied

  let waittime = 10
  let message = 'Server shutting down'
  let dryRun = false
  try {
    const body = (await request.json()) as { waittime?: unknown; message?: unknown; dryRun?: unknown }
    if (typeof body.waittime === 'number' && Number.isFinite(body.waittime)) {
      waittime = Math.max(0, Math.min(MAX_WAIT, Math.floor(body.waittime)))
    }
    if (typeof body.message === 'string') {
      message = body.message.slice(0, 180)
    }
    dryRun = body.dryRun === true
  } catch {
    // empty/malformed body → defaults (a 10s warning, then genuine stop)
  }

  if (DEMO_MODE) {
    return NextResponse.json({ success: true, waittime, dryRun: true })
  }

  try {
    const { shutdown: requestPath, runDir } = resolveLifecyclePaths(request.headers.get(PALWORLD_PROXY_HEADERS.instance))
    await mkdir(runDir, { recursive: true })
    // temp-then-rename so the watcher never observes a half-written request
    const tmp = `${requestPath}.tmp`
    await writeFile(tmp, JSON.stringify({ waittime, message, dryRun, requestedAt: Date.now() }), { mode: 0o660 })
    await rename(tmp, requestPath)
  } catch (error) {
    return NextResponse.json(
      { error: `Failed to queue stop: ${error instanceof Error ? error.message : 'unknown error'}` },
      { status: 500 }
    )
  }
  return NextResponse.json({ success: true, waittime, dryRun })
}

export async function DELETE(request: NextRequest) {
  const denied = adminGate(request)
  if (denied) return denied
  if (DEMO_MODE) {
    return NextResponse.json({ success: true })
  }
  try {
    const { shutdownCancel, runDir } = resolveLifecyclePaths(request.headers.get(PALWORLD_PROXY_HEADERS.instance))
    await mkdir(runDir, { recursive: true })
    await writeFile(shutdownCancel, JSON.stringify({ cancelledAt: Date.now() }), { mode: 0o660 })
  } catch (error) {
    return NextResponse.json(
      { error: `Failed to cancel stop: ${error instanceof Error ? error.message : 'unknown error'}` },
      { status: 500 }
    )
  }
  return NextResponse.json({ success: true })
}
