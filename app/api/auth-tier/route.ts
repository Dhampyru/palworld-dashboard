import { NextRequest, NextResponse } from 'next/server'
import { classifyPassword, tierForClass } from '@/lib/access-tier'
import { clientIp, isLockedOut, recordFailure } from '@/lib/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Login-time tier oracle: takes the entered password and answers ONLY with
// the tier it maps to ('admin' | 'mod' | 'invalid'). It never echoes any
// credential. This endpoint is a UI hint for view selection — the actual
// authorization boundary is enforced per-request in
// app/api/palworld/[...path]/route.ts regardless of what the client stores.
export async function POST(request: NextRequest) {
  let password = ''

  try {
    const body = (await request.json()) as { password?: unknown }
    if (typeof body.password === 'string') {
      password = body.password
    }
  } catch {
    // Malformed or missing JSON body → invalid
  }

  const ip = clientIp(request)
  if (isLockedOut(ip)) {
    return NextResponse.json({ tier: 'invalid', error: 'rate_limited' }, { status: 429 })
  }
  const passwordClass = classifyPassword(password)
  if (passwordClass === 'unknown') {
    recordFailure(ip)
  }
  return NextResponse.json({ tier: tierForClass(passwordClass) })
}
