import { NextRequest, NextResponse } from 'next/server'
import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import { classifyPassword, tierForClass } from '@/lib/access-tier'
import { clientIp, isLockedOut, recordFailure } from '@/lib/rate-limit'
import { DEMO_MODE } from '@/lib/demo-mode'
import { PALWORLD_PROXY_HEADERS } from '@/lib/palworld'
import { runWithInstance } from '@/lib/instances'
import { buildClientLoadout } from '@/lib/client-loadout'
import { LOADOUT_TOKEN_RE, mintLoadoutToken, takeLoadoutToken } from '@/lib/loadout-tokens'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// PATCH (not upstream): generate + download the client loadout (docs/specs/client-mod-
// sync.md §2c/§6). Two-step so a ~1GB bundle never buffers in the browser:
//   POST (admin)  → generate the bundle, mint a one-time token → { token, fileName, summary }
//   GET ?token=…  → stream the file to disk (token IS the capability; no header needed so a
//                   plain <a> navigation works), consumed on first use, temp dir cleaned up.
// A header-authed GET (no token) is kept for programmatic/direct download.
function presentedPassword(request: NextRequest) {
  return request.headers.get(PALWORLD_PROXY_HEADERS.adminPassword) ?? ''
}
function requireAdmin(request: NextRequest): NextResponse | null {
  const ip = clientIp(request)
  if (isLockedOut(ip)) return NextResponse.json({ error: 'Too many attempts. Try again later.' }, { status: 429 })
  const passwordClass = classifyPassword(presentedPassword(request))
  if (passwordClass === 'unknown') {
    recordFailure(ip)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (tierForClass(passwordClass) !== 'admin') {
    return NextResponse.json({ error: 'Forbidden: client loadout is admin-only' }, { status: 403 })
  }
  return null
}

// Stream a file, deleting its temp dir once the response is fully sent (or the client aborts).
function streamZip(zipPath: string, fileName: string, sizeBytes: number, cleanup: () => Promise<void>): Response {
  const nodeStream = createReadStream(zipPath)
  nodeStream.on('close', () => void cleanup())
  nodeStream.on('error', () => void cleanup())
  const body = Readable.toWeb(nodeStream) as unknown as ReadableStream
  return new Response(body, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'Content-Length': String(sizeBytes),
      'Cache-Control': 'no-store',
    },
  })
}

export async function GET(request: NextRequest) {
  // Token path — the browser's streaming download. No admin header (the token is the
  // capability): single-use, 256-bit, short-lived.
  const token = request.nextUrl.searchParams.get('token')
  if (token) {
    if (!LOADOUT_TOKEN_RE.test(token)) return NextResponse.json({ error: 'Invalid token' }, { status: 400 })
    const entry = takeLoadoutToken(token)
    if (!entry) return NextResponse.json({ error: 'Download link expired or already used — regenerate.' }, { status: 410 })
    return streamZip(entry.zipPath, entry.fileName, entry.sizeBytes, entry.cleanup)
  }
  // Header-authed direct generate+stream (programmatic use / fallback).
  return runWithInstance(request.headers.get(PALWORLD_PROXY_HEADERS.instance), () => _GENERATE(request, false))
}

export async function POST(request: NextRequest) {
  return runWithInstance(request.headers.get(PALWORLD_PROXY_HEADERS.instance), () => _GENERATE(request, true))
}

// Shared generate. `mint` true → store the bundle + return a token (browser flow); false →
// stream the bundle directly (programmatic GET).
async function _GENERATE(request: NextRequest, mint: boolean) {
  const denied = requireAdmin(request)
  if (denied) return denied
  if (DEMO_MODE) return NextResponse.json({ error: 'Loadout generation is disabled in demo mode' }, { status: 400 })

  const includeUe4ss = request.nextUrl.searchParams.get('ue4ss') !== '0'
  try {
    const { zipPath, fileName, summary, cleanup } = await buildClientLoadout({ includeUe4ss })
    if (mint) {
      const token = mintLoadoutToken({ zipPath, fileName, sizeBytes: summary.sizeBytes, cleanup })
      return NextResponse.json({ token, fileName, summary })
    }
    return streamZip(zipPath, fileName, summary.sizeBytes, cleanup)
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Loadout generation failed' }, { status: 500 })
  }
}
