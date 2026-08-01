import { NextResponse } from 'next/server'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// PATCH (not upstream): the DASHBOARD's own build identity, so an already-open tab
// can tell when a NEW build has been deployed and prompt a refresh (an open SPA
// keeps running its old bundle until reloaded). Distinct from /api/check-update,
// which is about the GAME server's Steam buildid.
//
// Unauthenticated on purpose: a build id is not sensitive, and the watcher must
// work on the login screen too. The value only needs to CHANGE per build — Next's
// .next/BUILD_ID does exactly that; a process-start fallback covers dev/edge cases
// (a dashboard restart then reads as a new version, which is close enough).
const FALLBACK_VERSION = String(Date.now())

export async function GET() {
  let version = FALLBACK_VERSION
  try {
    version = (await readFile(join(process.cwd(), '.next', 'BUILD_ID'), 'utf8')).trim() || FALLBACK_VERSION
  } catch {
    /* dev / no BUILD_ID — use the process-start fallback */
  }
  return NextResponse.json(
    { version },
    { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } },
  )
}
