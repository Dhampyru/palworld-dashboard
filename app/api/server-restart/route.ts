import { NextRequest, NextResponse } from 'next/server'
import { writeFile, rename, mkdir } from 'node:fs/promises'
import { classifyPassword, tierForClass } from '@/lib/access-tier'
import { DEMO_MODE } from '@/lib/demo-mode'
import { clientIp, isLockedOut, recordFailure } from '@/lib/rate-limit'
import { PALWORLD_PROXY_HEADERS } from '@/lib/palworld'
import { resolveLifecyclePaths } from '@/lib/instances'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// The dashboard cannot restart the game process itself (PalServer has no
// self-restart, and REST /shutdown only stops it). Instead this route drops a
// request flag file that a root-owned systemd path-unit + oneshot service
// consume on the host. The web tier holds NO sudo and no docker socket — it
// only writes a file it already owns (/run/palworld is created by
// /etc/tmpfiles.d/palworld.conf owned by uid 2001, this container's user).
//
// On THIS deployment the host side is installed and verified working:
// palworld-restart.{path,service} → /usr/local/bin/palworld-restart-handler.sh.
// The handler broadcasts an RCON countdown, honours the cancel file written by
// DELETE below, and then runs `docker compose up -d` — NOT `docker compose
// restart`, which would reuse the container's baked-in environment and keep
// silently re-applying stale .env values saved via World Settings.
//
// On a fresh deployment without those units the request file is simply never
// consumed: the POST succeeds and nothing restarts. Operators must install
// their own equivalent.
//
// Multi-instance (#7): the flag path is resolved PER INSTANCE. The `default`
// (live) server keeps the flat /run/palworld/restart.request handled by the
// proven systemd unit above; non-default instances write to
// /run/palworld/<id>/restart.request, watched by the palworld-control daemon.
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
    return NextResponse.json({ error: 'Forbidden: server restart is admin-only' }, { status: 403 })
  }
  return null
}

export async function POST(request: NextRequest) {
  const denied = adminGate(request)
  if (denied) return denied

  let waittime = 30
  let message = 'Server restarting'
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
    // empty/malformed body → defaults (a 30s restart)
  }

  if (DEMO_MODE) {
    return NextResponse.json({ success: true, waittime, dryRun: true })
  }

  try {
    const { restart: requestPath, runDir } = resolveLifecyclePaths(request.headers.get(PALWORLD_PROXY_HEADERS.instance))
    await mkdir(runDir, { recursive: true })
    // temp-then-rename so the watcher never observes a half-written request
    const tmp = `${requestPath}.tmp`
    await writeFile(tmp, JSON.stringify({ waittime, message, dryRun, requestedAt: Date.now() }), { mode: 0o660 })
    await rename(tmp, requestPath)
  } catch (error) {
    return NextResponse.json(
      { error: `Failed to queue restart: ${error instanceof Error ? error.message : 'unknown error'}` },
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
    const { restartCancel, runDir } = resolveLifecyclePaths(request.headers.get(PALWORLD_PROXY_HEADERS.instance))
    await mkdir(runDir, { recursive: true })
    await writeFile(restartCancel, JSON.stringify({ cancelledAt: Date.now() }), { mode: 0o660 })
  } catch (error) {
    return NextResponse.json(
      { error: `Failed to cancel restart: ${error instanceof Error ? error.message : 'unknown error'}` },
      { status: 500 }
    )
  }
  return NextResponse.json({ success: true })
}
