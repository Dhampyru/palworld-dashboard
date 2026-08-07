import { NextRequest, NextResponse } from 'next/server'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { checkShare, prepareDownload } from '@/lib/client-shares'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// PATCH (not upstream): PUBLIC friend-facing share download (docs/specs/client-mod-sync.md
// §8/§8a). No admin auth — the token IS the capability. prepareDownload enforces the admin's
// bounds (expiry → 404 after sweep, max-uses → 410 exhausted, passphrase via ?pass → 403)
// and counts the use. The zip path is server-resolved from the token (no traversal).
function fail(reason: 'notfound' | 'exhausted' | 'badpass'): NextResponse {
  if (reason === 'badpass') return NextResponse.json({ error: 'Wrong passphrase.' }, { status: 403 })
  if (reason === 'exhausted')
    return NextResponse.json({ error: 'This link has been used the maximum number of times.' }, { status: 410 })
  return NextResponse.json({ error: 'This link is invalid, expired, or has been revoked.' }, { status: 404 })
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const pass = request.nextUrl.searchParams.get('pass')

  // Pre-download check (no use counted) — the page calls this before triggering the download.
  if (request.nextUrl.searchParams.get('check') === '1') {
    const r = await checkShare(token, pass)
    return r.ok ? NextResponse.json({ ok: true }) : fail(r.reason!)
  }

  const prep = await prepareDownload(token, pass)
  if (!prep.ok) return fail(prep.reason)
  let size = prep.sizeBytes
  try {
    size = (await stat(prep.path)).size
  } catch {
    return NextResponse.json({ error: 'The bundle for this link is no longer available — ask for a new link.' }, { status: 410 })
  }
  const nodeStream = createReadStream(prep.path)
  const body = Readable.toWeb(nodeStream) as unknown as ReadableStream
  return new Response(body, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${prep.fileName}"`,
      'Content-Length': String(size),
      'Cache-Control': 'no-store',
    },
  })
}
