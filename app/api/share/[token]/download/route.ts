import { NextResponse } from 'next/server'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { resolveShareZip } from '@/lib/client-shares'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// PATCH (not upstream): PUBLIC friend-facing share download (docs/specs/client-mod-sync.md
// §8). No admin auth — the token IS the capability. Streams the persisted bundle (the path
// is server-resolved from the token, never from client input, so no traversal). Multi-use
// (unlike the admin one-time token) — the friend can retry; the admin revokes when done.
export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const resolved = await resolveShareZip(token)
  if (!resolved) return NextResponse.json({ error: 'This link is invalid or has been revoked.' }, { status: 404 })
  let size = resolved.sizeBytes
  try {
    size = (await stat(resolved.path)).size // authoritative; also confirms the file still exists
  } catch {
    return NextResponse.json({ error: 'The bundle for this link is no longer available — ask for a new link.' }, { status: 410 })
  }
  const nodeStream = createReadStream(resolved.path)
  const body = Readable.toWeb(nodeStream) as unknown as ReadableStream
  return new Response(body, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${resolved.fileName}"`,
      'Content-Length': String(size),
      'Cache-Control': 'no-store',
    },
  })
}
