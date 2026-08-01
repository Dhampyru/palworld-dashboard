import { NextRequest, NextResponse } from 'next/server'
import { readFile } from 'node:fs/promises'
import { classifyPassword, tierForClass } from '@/lib/access-tier'
import { PALWORLD_PROXY_HEADERS } from '@/lib/palworld'
import { runWithInstance } from '@/lib/instances'
import { resolveBackupPath } from '@/lib/saves'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// PATCH (not upstream): stream a backup tarball for download (item 5). Admin
// only, same basename validation as the mutating route -- `file` is resolved
// strictly inside the backups dir. The client fetches this with the admin-
// password header and saves the blob (a plain <a download> can't set headers).
export async function GET(request: NextRequest) {
  return runWithInstance(request.headers.get(PALWORLD_PROXY_HEADERS.instance), () => _GET(request))
}
async function _GET(request: NextRequest) {
  const password = request.headers.get(PALWORLD_PROXY_HEADERS.adminPassword) ?? ''
  if (tierForClass(classifyPassword(password)) !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const file = request.nextUrl.searchParams.get('file')
  const full = resolveBackupPath(file)
  if (!full) return NextResponse.json({ error: 'Invalid backup file' }, { status: 400 })

  try {
    const data = await readFile(full)
    return new NextResponse(new Uint8Array(data), {
      headers: {
        'Content-Type': 'application/gzip',
        'Content-Disposition': `attachment; filename="${file}"`,
        'Content-Length': String(data.length),
      },
    })
  } catch {
    return NextResponse.json({ error: 'Backup not found' }, { status: 404 })
  }
}
