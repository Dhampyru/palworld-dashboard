import { NextRequest, NextResponse } from 'next/server'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { shareFilePath } from '@/lib/client-shares'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// PATCH (not upstream): PUBLIC FSA per-file stream (docs/specs/client-mod-sync.md §5.2).
// Streams ONE file from the share's game/ tree so the browser can write it straight to the
// friend's picked folder (memory-safe for big paks). `path` is client-supplied but resolved
// path-safe under the tree (shareFilePath). Token = capability; ?pass gates; NO use counted
// (the manifest fetch already counted the sync).
export async function GET(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const pass = request.nextUrl.searchParams.get('pass')
  const rel = request.nextUrl.searchParams.get('path') ?? ''
  const r = await shareFilePath(token, rel, pass)
  if (!r.ok) {
    if (r.reason === 'badpass') return NextResponse.json({ error: 'Wrong passphrase.' }, { status: 403 })
    if (r.reason === 'exhausted') return NextResponse.json({ error: 'Link exhausted.' }, { status: 410 })
    return NextResponse.json({ error: 'Not found.' }, { status: 404 })
  }
  const size = (await stat(r.absPath)).size
  const body = Readable.toWeb(createReadStream(r.absPath)) as unknown as ReadableStream
  return new Response(body, {
    headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(size), 'Cache-Control': 'no-store' },
  })
}
