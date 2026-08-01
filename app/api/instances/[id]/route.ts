import { NextRequest, NextResponse } from 'next/server'
import { writeFile, rename, mkdir } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { classifyPassword, tierForClass } from '@/lib/access-tier'
import { clientIp, isLockedOut, recordFailure } from '@/lib/rate-limit'
import { DEMO_MODE } from '@/lib/demo-mode'
import { PALWORLD_PROXY_HEADERS } from '@/lib/palworld'
import { getInstance, readInstanceMetrics, DEFAULT_INSTANCE_ID } from '@/lib/instances'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const RUN_DIR = process.env.PALWORLD_RUN_DIR ?? '/run/palworld'

type RouteContext = { params: Promise<{ id: string }> }

function presented(request: NextRequest) {
  return request.headers.get(PALWORLD_PROXY_HEADERS.adminPassword) ?? ''
}

function adminGate(request: NextRequest): NextResponse | null {
  const ip = clientIp(request)
  if (isLockedOut(ip)) return NextResponse.json({ error: 'Too many attempts. Try again later.' }, { status: 429 })
  const cls = classifyPassword(presented(request))
  if (cls === 'unknown') {
    recordFailure(ip)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (tierForClass(cls) !== 'admin') {
    return NextResponse.json({ error: 'Forbidden: instance management is admin-only' }, { status: 403 })
  }
  return null
}

// GET: provisioning status + current registry/live view (for the create wizard
// to poll, and the panel to show state). Any valid tier.
export async function GET(request: NextRequest, { params }: RouteContext) {
  if (tierForClass(classifyPassword(presented(request))) === 'invalid') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const { id } = await params
  let provision: unknown = null
  try {
    provision = JSON.parse(readFileSync(`${RUN_DIR}/provision/${id}.status`, 'utf8'))
  } catch {
    /* no status file */
  }
  const inst = getInstance(id)
  const m = inst ? readInstanceMetrics(id) : null
  return NextResponse.json({
    id,
    exists: Boolean(inst),
    displayName: inst?.displayName ?? null,
    running: m ? m.present && m.status === 'running' : null,
    status: m?.status ?? null,
    provision,
  })
}

// DELETE: delete-keeps-saves. Writes a request flag; the daemon runs
// `docker compose down` (never -v), deregisters, and leaves the game dir.
export async function DELETE(request: NextRequest, { params }: RouteContext) {
  const denied = adminGate(request)
  if (denied) return denied
  const { id } = await params
  if (id === DEFAULT_INSTANCE_ID) {
    return NextResponse.json({ error: 'The default (live) server cannot be deleted here.' }, { status: 400 })
  }
  if (!getInstance(id)) {
    return NextResponse.json({ error: `No such instance "${id}".` }, { status: 404 })
  }
  if (DEMO_MODE) {
    return NextResponse.json({ success: true, dryRun: true })
  }
  try {
    await mkdir(RUN_DIR, { recursive: true })
    const reqPath = `${RUN_DIR}/${id}.delete.request`
    const tmp = `${reqPath}.tmp`
    await writeFile(tmp, JSON.stringify({ requestedAt: Date.now() }), { mode: 0o660 })
    await rename(tmp, reqPath)
  } catch (error) {
    return NextResponse.json(
      { error: `Failed to queue delete: ${error instanceof Error ? error.message : 'unknown error'}` },
      { status: 500 }
    )
  }
  return NextResponse.json({ success: true, id })
}
