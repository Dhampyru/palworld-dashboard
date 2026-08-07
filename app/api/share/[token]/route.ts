import { NextResponse } from 'next/server'
import { getShare } from '@/lib/client-shares'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// PATCH (not upstream): PUBLIC friend-facing share metadata (docs/specs/client-mod-sync.md
// §8). No admin auth — the unguessable 192-bit token IS the capability. Returns only the
// curated share info (server name/connect/version + mod counts), never a file path or
// anything else. Unknown/revoked token → 404.
export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const share = await getShare(token)
  if (!share) return NextResponse.json({ error: 'This link is invalid or has been revoked.' }, { status: 404 })
  return NextResponse.json({ share })
}
