import { NextRequest, NextResponse } from 'next/server'
import { writeFile, rename, mkdir } from 'node:fs/promises'
import { classifyPassword, tierForClass } from '@/lib/access-tier'
import { DEMO_MODE } from '@/lib/demo-mode'
import { clientIp, isLockedOut, recordFailure } from '@/lib/rate-limit'
import { PALWORLD_PROXY_HEADERS } from '@/lib/palworld'
import { resolveLifecyclePaths } from '@/lib/instances'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Same host-side pattern as /api/server-restart and /api/server-stop, but
// simpler: when the server is offline there's nothing running to announce to
// or wait on, so this just drops a flag file for palworld-start.path/.service
// to consume, which runs `docker compose up -d` on the host. The admin-gate
// check below only validates the password the caller presents -- it doesn't
// itself talk to the game server -- so this works correctly even while the
// server is fully offline, which is the whole point of this route.
//
// Multi-instance (#7): flag path resolved per instance — `default` keeps the
// flat path (proven systemd unit); non-default writes /run/palworld/<id>/
// start.request for the palworld-control daemon.
function presentedPassword(request: NextRequest) {
  return request.headers.get(PALWORLD_PROXY_HEADERS.adminPassword) ?? ''
}

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
    return NextResponse.json({ error: 'Forbidden: server start is admin-only' }, { status: 403 })
  }
  return null
}

export async function POST(request: NextRequest) {
  const denied = adminGate(request)
  if (denied) return denied

  if (DEMO_MODE) {
    return NextResponse.json({ success: true, dryRun: true })
  }

  try {
    const { start: requestPath, runDir } = resolveLifecyclePaths(request.headers.get(PALWORLD_PROXY_HEADERS.instance))
    await mkdir(runDir, { recursive: true })
    // temp-then-rename so the watcher never observes a half-written request
    const tmp = `${requestPath}.tmp`
    await writeFile(tmp, JSON.stringify({ requestedAt: Date.now() }), { mode: 0o660 })
    await rename(tmp, requestPath)
  } catch (error) {
    return NextResponse.json(
      { error: `Failed to queue start: ${error instanceof Error ? error.message : 'unknown error'}` },
      { status: 500 }
    )
  }
  return NextResponse.json({ success: true })
}
