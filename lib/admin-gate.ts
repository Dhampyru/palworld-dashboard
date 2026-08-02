import { NextRequest, NextResponse } from 'next/server'
import { classifyPassword, tierForClass } from '@/lib/access-tier'
import { clientIp, isLockedOut, recordFailure } from '@/lib/rate-limit'
import { PALWORLD_PROXY_HEADERS } from '@/lib/palworld'

// Shared admin-tier gate. The lifecycle routes (server-{start,stop,restart},
// instances) each inline this same logic; new routes should import it instead of
// copying it a sixth time. Returns a NextResponse to short-circuit on failure,
// or null when the caller is authenticated at admin tier.

export function presentedAdminPassword(request: NextRequest): string {
  return request.headers.get(PALWORLD_PROXY_HEADERS.adminPassword) ?? ''
}

export function adminGate(
  request: NextRequest,
  forbiddenMessage = 'Forbidden: admin-only',
): NextResponse | null {
  const ip = clientIp(request)
  if (isLockedOut(ip)) {
    return NextResponse.json({ error: 'Too many attempts. Try again later.' }, { status: 429 })
  }
  const passwordClass = classifyPassword(presentedAdminPassword(request))
  if (passwordClass === 'unknown') {
    recordFailure(ip)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (tierForClass(passwordClass) !== 'admin') {
    return NextResponse.json({ error: forbiddenMessage }, { status: 403 })
  }
  return null
}
