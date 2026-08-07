import { NextRequest, NextResponse } from 'next/server'
import { shareFiles } from '@/lib/client-shares'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// PATCH (not upstream): PUBLIC FSA manifest (docs/specs/client-mod-sync.md §5.2). Returns the
// list of files (relative to the game folder) for the browser File-System-Access sync. Token
// = capability; ?pass gates it; counts ONE use (a sync = one download). No admin auth.
export async function GET(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const pass = request.nextUrl.searchParams.get('pass')
  const r = await shareFiles(token, pass)
  if (!r.ok) {
    if (r.reason === 'badpass') return NextResponse.json({ error: 'Wrong passphrase.' }, { status: 403 })
    if (r.reason === 'exhausted')
      return NextResponse.json({ error: 'This link has been used the maximum number of times.' }, { status: 410 })
    return NextResponse.json({ error: 'This link is invalid, expired, or has been revoked.' }, { status: 404 })
  }
  return NextResponse.json({ files: r.files })
}
