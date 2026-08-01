import { NextRequest, NextResponse } from 'next/server'
import { clientIp, isLockedOut, recordFailure } from '@/lib/rate-limit'
import { DEMO_MODE } from '@/lib/demo-mode'
import { verifyAdmin, setAdminPassword } from '@/lib/panel-auth-store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MIN_LEN = 6

// Change the panel ADMIN login password. Re-authorized by the current admin
// password (entered again in the form), rate-limited on failure.
export async function POST(request: NextRequest) {
  const ip = clientIp(request)
  if (isLockedOut(ip)) {
    return NextResponse.json({ error: 'Too many attempts. Try again later.' }, { status: 429 })
  }

  let currentPassword = ''
  let newPassword = ''
  try {
    const body = (await request.json()) as { currentPassword?: unknown; newPassword?: unknown }
    if (typeof body.currentPassword === 'string') currentPassword = body.currentPassword
    if (typeof body.newPassword === 'string') newPassword = body.newPassword
  } catch {
    // fall through to validation
  }

  if (!verifyAdmin(currentPassword)) {
    recordFailure(ip)
    return NextResponse.json({ error: 'Current password is incorrect.' }, { status: 403 })
  }
  if (newPassword.length < MIN_LEN) {
    return NextResponse.json({ error: `New password must be at least ${MIN_LEN} characters.` }, { status: 400 })
  }
  if (DEMO_MODE) {
    return NextResponse.json({ success: true, message: 'Demo mode: password change skipped.' })
  }

  try {
    setAdminPassword(newPassword)
  } catch (error) {
    return NextResponse.json(
      { error: `Failed to update password: ${error instanceof Error ? error.message : 'unknown error'}` },
      { status: 500 }
    )
  }
  return NextResponse.json({ success: true })
}
