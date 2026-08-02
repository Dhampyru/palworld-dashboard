import { NextRequest, NextResponse } from 'next/server'
import { mkdir, writeFile, rename, access } from 'node:fs/promises'
import { adminGate } from '@/lib/admin-gate'
import { DEMO_MODE } from '@/lib/demo-mode'
import { PALWORLD_PROXY_HEADERS } from '@/lib/palworld'
import { resolveGameDataPaths } from '@/lib/instances'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Queue a game-data extraction for the active instance: drop the flag file the
// control daemon watches (<runDir>/gamedata.request). The daemon runs the
// extractor image against the instance's pak + the uploaded usmap and writes the
// datasets/icons the runtime /api/datasets + /api/game-icon serve. Same
// flag-file → host pattern as lifecycle; the web tier never runs docker/sudo.
export async function POST(request: NextRequest) {
  const denied = adminGate(request, 'Forbidden: extracting game data is admin-only')
  if (denied) return denied
  if (DEMO_MODE) return NextResponse.json({ success: true, dryRun: true })

  try {
    const { usmapPath, request: requestPath, status: statusPath, runDir } =
      resolveGameDataPaths(request.headers.get(PALWORLD_PROXY_HEADERS.instance))

    // Require an uploaded usmap first — extraction can't run without one.
    try {
      await access(usmapPath)
    } catch {
      return NextResponse.json({ error: 'Upload a mappings.usmap first' }, { status: 400 })
    }

    await mkdir(runDir, { recursive: true })
    // Seed a queued status so the UI shows progress immediately, before the
    // daemon's next tick claims the request.
    const now = new Date().toISOString()
    const stTmp = `${statusPath}.tmp`
    await writeFile(
      stTmp,
      JSON.stringify({ phase: 'queued', pct: 0, message: 'Queued for extraction', updatedAt: now }),
      { mode: 0o664 },
    )
    await rename(stTmp, statusPath)

    // temp-then-rename so the daemon never observes a half-written request
    const tmp = `${requestPath}.tmp`
    await writeFile(tmp, JSON.stringify({ requestedAt: Date.now() }), { mode: 0o660 })
    await rename(tmp, requestPath)

    return NextResponse.json({ success: true })
  } catch (error) {
    return NextResponse.json(
      { error: `Failed to queue extraction: ${error instanceof Error ? error.message : 'unknown error'}` },
      { status: 500 },
    )
  }
}
