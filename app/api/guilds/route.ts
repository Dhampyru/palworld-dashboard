import { NextRequest, NextResponse } from 'next/server'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { classifyPassword, tierForClass } from '@/lib/access-tier'
import { DEMO_MODE } from '@/lib/demo-mode'
import { demoGuilds } from '@/lib/demo'
import { PALWORLD_PROXY_HEADERS } from '@/lib/palworld'
import { extractProcessOutput, getRconConfig, runRcon } from '@/lib/rcon-exec'
import { parseGuildExport } from '@/lib/guilds'
import { resolveInstance } from '@/lib/instances'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// PATCH (not upstream): guild/base browser data (roadmap item 3, re-scoped --
// see lib/guilds.ts for why this is not save parsing).
//
// Two steps: ask PalDefender to refresh its export via RCON, then read the
// JSON file it writes on the game volume this container already mounts. The
// write is PalDefender's, not ours; we only read the result.

const EXPORT_RELATIVE_PATH = 'Pal/Binaries/Win64/PalDefender/guildexport.json'

function presentedPassword(request: NextRequest) {
  return request.headers.get(PALWORLD_PROXY_HEADERS.adminPassword) ?? ''
}

export async function GET(request: NextRequest) {
  const passwordClass = classifyPassword(presentedPassword(request))
  if (passwordClass === 'unknown') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  // Guild data exposes player names, levels and last-known coordinates for
  // offline players, so it sits behind the same admin tier as the console
  // rather than the mod tier's smaller safe subset.
  if (tierForClass(passwordClass) !== 'admin') {
    return NextResponse.json({ error: 'Forbidden: guild data is admin-only' }, { status: 403 })
  }

  if (DEMO_MODE) {
    return NextResponse.json({ guilds: demoGuilds, demo: true, refreshedAt: new Date().toISOString() })
  }

  const instanceId = request.headers.get(PALWORLD_PROXY_HEADERS.instance)
  const instance = resolveInstance(instanceId)
  if (!instance?.gameDir) {
    return NextResponse.json(
      { error: 'Game directory is not resolvable, so the guild export cannot be read.' },
      { status: 500 },
    )
  }
  const gameDir = instance.gameDir

  const rconConfig = getRconConfig(instanceId)
  if (!rconConfig) {
    return NextResponse.json({ error: 'RCON is not configured on this server' }, { status: 500 })
  }

  // Refresh first so the file reflects current state. If this fails we still
  // try the read: a stale export is far more useful than an error page, and
  // the response says plainly which one the caller got.
  let refreshed = false
  let refreshError: string | null = null
  try {
    const response = await runRcon(rconConfig, 'exportguilds')
    refreshed = response.toLowerCase().includes('exported')
    if (!refreshed) refreshError = response
  } catch (error) {
    refreshError = extractProcessOutput(error)
  }

  try {
    const raw = await readFile(join(gameDir, EXPORT_RELATIVE_PATH), 'utf8')
    const guilds = parseGuildExport(raw)
    return NextResponse.json({
      guilds,
      refreshed,
      // Non-null only when the refresh failed but a previous export was
      // readable -- the UI shows this as a staleness warning.
      refreshError: refreshed ? null : refreshError,
      refreshedAt: new Date().toISOString(),
    })
  } catch {
    return NextResponse.json(
      {
        error: refreshError
          ? `Could not refresh or read the guild export: ${refreshError}`
          : 'No guild export found. PalDefender writes it — check that the mod is installed and the game volume is mounted.',
      },
      { status: 502 },
    )
  }
}
