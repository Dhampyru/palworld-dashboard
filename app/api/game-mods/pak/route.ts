import { NextRequest, NextResponse } from 'next/server'
import { readFile, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { classifyPassword, tierForClass } from '@/lib/access-tier'
import { clientIp, isLockedOut, recordFailure } from '@/lib/rate-limit'
import { PALWORLD_PROXY_HEADERS } from '@/lib/palworld'
import { runWithInstance } from '@/lib/instances'
import { pakModsDir, SAFE_PAK_FILENAME } from '@/lib/game-mods'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// PATCH (not upstream): download a pak-mod file so an admin can hand it out to
// players — hybrid PalSchema mods (and plain pak mods) need the .pak on every
// CLIENT too, and the file otherwise only lives on the server. Admin-only (same
// bar as install/remove); reads ONLY from the ~mods dir, name-validated + path
// guarded so it can't be used to exfiltrate arbitrary files.
function presentedPassword(request: NextRequest) {
  return request.headers.get(PALWORLD_PROXY_HEADERS.adminPassword) ?? ''
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
    return NextResponse.json({ error: 'Forbidden: downloading mod files is admin-only' }, { status: 403 })
  }

  const name = request.nextUrl.searchParams.get('name') ?? ''
  if (!SAFE_PAK_FILENAME.test(name)) {
    return NextResponse.json({ error: 'Invalid pak filename' }, { status: 400 })
  }

  // The list strips a `.disabled` suffix for display, so accept either on disk.
  const base = join(pakModsDir(), name)
  let filePath: string | null = null
  for (const candidate of [base, `${base}.disabled`]) {
    const resolved = resolve(candidate)
    if (resolved !== base && !resolved.startsWith(resolve(pakModsDir()) + sep)) continue // path guard
    try {
      await stat(resolved)
      filePath = resolved
      break
    } catch {
      /* try next */
    }
  }
  if (!filePath) {
    return NextResponse.json({ error: `${name} not found` }, { status: 404 })
  }

  try {
    const data = await readFile(filePath)
    return new NextResponse(new Uint8Array(data), {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${name}"`,
        'Content-Length': String(data.length),
        'Cache-Control': 'no-store',
      },
    })
  } catch (error) {
    return NextResponse.json(
      { error: `Failed to read file: ${error instanceof Error ? error.message : 'unknown error'}` },
      { status: 500 },
    )
  }
}
