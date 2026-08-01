import { NextRequest, NextResponse } from 'next/server'
import { readdir, stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { classifyPassword, tierForClass } from '@/lib/access-tier'
import { clientIp, isLockedOut, recordFailure } from '@/lib/rate-limit'
import { DEMO_MODE } from '@/lib/demo-mode'
import { PALWORLD_PROXY_HEADERS } from '@/lib/palworld'
import { runWithInstance, resolveInstance, currentInstanceId, currentRestConfig } from '@/lib/instances'
import { pakModsDir, readUe4ssStatus } from '@/lib/game-mods'
import { readPalSchemaStatus } from '@/lib/palschema'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// PATCH (not upstream): client mod-sync manifest (docs/specs/client-mod-sync.md,
// Phase 1). A snapshot of what a joining CLIENT needs to match: game version +
// server name (info), UE4SS/PalSchema build (diagnostic only — server-side), and
// the client-required pak set with sizes + SHA-256 so a client can detect
// mismatches, not just absence. Admin-only for Phase 1 (the admin generates a
// shareable invite from it); a curated non-admin path is a Phase 2 concern.
// Multi-instance (#7): connect port + server info resolve to the ACTIVE instance
// (runWithInstance), so the invite shows each server's own port/name.
function gamePortFor(): number {
  return resolveInstance(currentInstanceId())?.ports.game ?? Number(process.env.PALWORLD_GAME_PORT ?? 8211)
}

function presentedPassword(request: NextRequest) {
  return request.headers.get(PALWORLD_PROXY_HEADERS.adminPassword) ?? ''
}

function sha256(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

// Server name + game version from the game REST (best-effort — degrades to null if
// the server is down). Uses the container's own game admin password, like the
// snapshot route, rather than threading the caller's.
async function fetchInfo(): Promise<{ serverName: string | null; gameVersion: string | null }> {
  try {
    const { restUrl, adminPassword: pw } = currentRestConfig()
    const base = new URL(restUrl)
    const res = await fetch(new URL('/v1/api/info', base), {
      headers: { Accept: 'application/json', Authorization: `Basic ${Buffer.from(`admin:${pw}`).toString('base64')}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return { serverName: null, gameVersion: null }
    const j = (await res.json()) as { servername?: string; version?: string }
    return { serverName: j.servername ?? null, gameVersion: j.version ?? null }
  } catch {
    return { serverName: null, gameVersion: null }
  }
}

// The client-required pak set = enabled paks in ~mods (skip .pak.disabled).
async function listClientPaks(): Promise<{ file: string; sizeBytes: number; sha256: string }[]> {
  let dirents
  try {
    dirents = await readdir(pakModsDir(), { withFileTypes: true })
  } catch {
    return []
  }
  const out: { file: string; sizeBytes: number; sha256: string }[] = []
  for (const d of dirents) {
    if (!d.isFile() || !d.name.toLowerCase().endsWith('.pak')) continue
    const full = join(pakModsDir(), d.name)
    try {
      const s = await stat(full)
      out.push({ file: d.name, sizeBytes: s.size, sha256: await sha256(full) })
    } catch {
      /* skip unreadable */
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file))
}

export async function GET(request: NextRequest) {
  return runWithInstance(request.headers.get(PALWORLD_PROXY_HEADERS.instance), () => _GET(request))
}
async function _GET(request: NextRequest) {
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
    return NextResponse.json({ error: 'Forbidden: the manifest is admin-only' }, { status: 403 })
  }

  if (DEMO_MODE) {
    return NextResponse.json({
      serverName: 'Demo Server',
      gameVersion: 'v1.0.0.0',
      port: gamePortFor(),
      ue4ss: { source: 'experimental-palworld', sha: 'demo', version: 'v3.0.1 Beta #0' },
      palschema: { installed: true, version: '0.6.1' },
      clientMods: [{ file: 'Example_P.pak', sizeBytes: 1048576, sha256: 'demo' }],
      generatedAt: new Date().toISOString(),
    })
  }

  try {
    const [info, ue4ss, palschema, clientMods] = await Promise.all([
      fetchInfo(),
      readUe4ssStatus(),
      readPalSchemaStatus(),
      listClientPaks(),
    ])
    return NextResponse.json({
      serverName: info.serverName,
      gameVersion: info.gameVersion,
      port: gamePortFor(),
      ue4ss: { source: ue4ss.source, sha: ue4ss.sha, version: ue4ss.version },
      palschema: { installed: palschema.installed, version: palschema.version },
      clientMods,
      generatedAt: new Date().toISOString(),
    })
  } catch (error) {
    return NextResponse.json(
      { error: `Failed to build manifest: ${error instanceof Error ? error.message : 'unknown error'}` },
      { status: 500 },
    )
  }
}
