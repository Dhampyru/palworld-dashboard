import { NextRequest, NextResponse } from 'next/server'
import { writeFile, rename, mkdir } from 'node:fs/promises'
import { classifyPassword, tierForClass } from '@/lib/access-tier'
import { clientIp, isLockedOut, recordFailure } from '@/lib/rate-limit'
import { DEMO_MODE } from '@/lib/demo-mode'
import { demoInstances } from '@/lib/demo'
import { PALWORLD_PROXY_HEADERS } from '@/lib/palworld'
import { getInstance, listInstances, readInstanceMetrics, runWithInstance, DEFAULT_INSTANCE_ID } from '@/lib/instances'
import { readActiveWorldId } from '@/lib/saves'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const RUN_DIR = process.env.PALWORLD_RUN_DIR ?? '/run/palworld'

function presented(request: NextRequest) {
  return request.headers.get(PALWORLD_PROXY_HEADERS.adminPassword) ?? ''
}

// Provisioning/delete are admin-only (create/tear down whole servers).
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

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)
}

// ─── GET: list instances (any valid tier), enriched with live status ────────
export async function GET(request: NextRequest) {
  if (tierForClass(classifyPassword(presented(request))) === 'invalid') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (DEMO_MODE) {
    return NextResponse.json({ instances: demoInstances })
  }
  const instances = await Promise.all(
    listInstances().map(async (i) => {
      const m = readInstanceMetrics(i.id)
      // Active world = DedicatedServerName in this instance's GameUserSettings.ini
      // (a small file read, per instance). Best-effort — null if unreadable.
      let activeWorld: string | null = null
      try {
        activeWorld = await runWithInstance(i.id, () => readActiveWorldId())
      } catch {
        /* leave null */
      }
      return {
        id: i.id,
        displayName: i.displayName,
        isDefault: i.isDefault,
        enabled: i.enabled,
        ports: i.ports,
        running: m ? m.present && m.status === 'running' : null,
        status: m?.status ?? null,
        memBytes: m?.memBytes ?? null,
        startedAt: m?.startedAt ?? null,
        activeWorld,
      }
    }),
  )
  return NextResponse.json({ instances })
}

// ─── POST: provision a new instance (admin) ─────────────────────────────────
// Writes a non-secret request flag for the palworld-control daemon, which
// allocates ports, creates the dir/.env/compose, brings it up, and registers it.
// Passwords are generated host-side by the daemon — never sent from the client.
export async function POST(request: NextRequest) {
  const denied = adminGate(request)
  if (denied) return denied

  let displayName = ''
  let maxPlayers = 32
  let rawId = ''
  let serverPassword = ''
  try {
    const body = (await request.json()) as { displayName?: unknown; maxPlayers?: unknown; id?: unknown; serverPassword?: unknown }
    if (typeof body.displayName === 'string') displayName = body.displayName.trim().slice(0, 60)
    if (typeof body.id === 'string') rawId = body.id.trim()
    if (typeof body.maxPlayers === 'number' && Number.isFinite(body.maxPlayers)) {
      maxPlayers = Math.max(1, Math.min(128, Math.floor(body.maxPlayers)))
    }
    if (typeof body.serverPassword === 'string') serverPassword = body.serverPassword.trim()
  } catch {
    /* defaults */
  }

  // The join password lands in a PalWorldSettings tuple + the instance .env, so
  // keep it to a safe charset (blank = public). Letters/numbers only avoids INI
  // quoting/comma pitfalls.
  if (serverPassword && !/^[A-Za-z0-9]{1,64}$/.test(serverPassword)) {
    return NextResponse.json(
      { error: 'Server password must be letters and numbers only (max 64), or blank for a public server.' },
      { status: 400 }
    )
  }

  const id = slugify(rawId || displayName)
  if (!id) {
    return NextResponse.json({ error: 'A name is required (letters/numbers).' }, { status: 400 })
  }
  if (id === DEFAULT_INSTANCE_ID) {
    return NextResponse.json({ error: `"${DEFAULT_INSTANCE_ID}" is reserved.` }, { status: 400 })
  }
  if (getInstance(id)) {
    return NextResponse.json({ error: `An instance named "${id}" already exists.` }, { status: 409 })
  }
  if (!displayName) displayName = id

  if (DEMO_MODE) {
    return NextResponse.json({ success: true, id, dryRun: true })
  }

  try {
    const dir = `${RUN_DIR}/provision`
    await mkdir(dir, { recursive: true })
    const reqPath = `${dir}/${id}.request`
    const tmp = `${reqPath}.tmp`
    await writeFile(tmp, JSON.stringify({ id, displayName, maxPlayers, serverPassword, requestedAt: Date.now() }), { mode: 0o660 })
    await rename(tmp, reqPath)
  } catch (error) {
    return NextResponse.json(
      { error: `Failed to queue provisioning: ${error instanceof Error ? error.message : 'unknown error'}` },
      { status: 500 }
    )
  }
  return NextResponse.json({ success: true, id })
}
