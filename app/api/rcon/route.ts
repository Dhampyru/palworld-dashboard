import { NextRequest, NextResponse } from 'next/server'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { extractProcessOutput, getRconConfig, runRcon } from '@/lib/rcon-exec'
import { classifyPassword, tierForClass } from '@/lib/access-tier'
import { clientIp, isLockedOut, recordFailure } from '@/lib/rate-limit'
import { DEMO_MODE } from '@/lib/demo-mode'
import { PALWORLD_PROXY_HEADERS } from '@/lib/palworld'
import { resolveInstance } from '@/lib/instances'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// PATCH (not upstream): a genuine RCON console -- unlike the REST proxy (which
// only ever calls a small set of known Palworld REST endpoints), this sends
// truly freeform text commands, which is exactly what RCON gives full server
// control over (Shutdown, DoExit, BanPlayer, and anything a mod like
// PalDefender adds later). Given that power, this is admin-tier only -- no
// mod-tier allowlist attempt, unlike the REST proxy's small safe subset.
//
// Shells out to the gorcon/rcon-cli binary (installed in the image, see
// Dockerfile) rather than a JS RCON library. Confirmed directly against this
// server: Palworld's RCON has a documented quirk in how it assigns response
// packet IDs that isn't strictly Source-RCON-spec compliant -- the
// `rcon-client` npm package (like some other generic client libraries) times
// out waiting for a response that never gets matched to its request; gorcon's
// CLI is specifically documented to handle this correctly for Palworld.
//
// SECURITY: same SSRF-prevention pattern as the REST proxy -- the RCON
// host/port and the real AdminPassword are pinned server-side from env, never
// from the client. The client only presents its own dashboard-tier password
// (to prove it's an admin session), which never reaches the game server.
function presentedPassword(request: NextRequest) {
  return request.headers.get(PALWORLD_PROXY_HEADERS.adminPassword) ?? ''
}

// PATCH (not upstream): capability probe for the RCON console upgrade
// (docs/specs/rcon-console.md §8).
//
// `getrconcmds` is PalDefender-only AND returns its live registry as
// `name:minArgs;` pairs, so one call both detects the mod and enumerates
// exactly what the operator's build supports. That beats probing `version`:
// the console can flag version drift instead of trusting a hardcoded list to
// match whatever PalDefender the operator is running.
//
// Also reads allowAdminCheats from PalDefender's Config.json, which is visible
// on the game volume already mounted for the chat log. Reading the flag lets
// gated commands be marked up-front (§7 / criterion 7) rather than only
// explaining themselves after failing.
async function readAllowAdminCheats(instanceId: string | null): Promise<boolean | null> {
  const gameDir = resolveInstance(instanceId)?.gameDir
  if (!gameDir) return null
  try {
    const raw = await readFile(join(gameDir, 'Pal/Binaries/Win64/PalDefender/Config.json'), 'utf8')
    const parsed = JSON.parse(raw) as { allowAdminCheats?: unknown }
    return typeof parsed.allowAdminCheats === 'boolean' ? parsed.allowAdminCheats : null
  } catch {
    // Not installed, not mounted, or unreadable -- unknown, not false. The UI
    // treats null as "assume enabled", so a bad read cannot make every
    // cheat command look broken.
    return null
  }
}

export async function GET(request: NextRequest) {
  const passwordClass = classifyPassword(presentedPassword(request))
  if (passwordClass === 'unknown') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (tierForClass(passwordClass) !== 'admin') {
    return NextResponse.json({ error: 'Forbidden: the RCON console is admin-only' }, { status: 403 })
  }

  if (DEMO_MODE) {
    return NextResponse.json({ palDefender: true, registry: '', allowAdminCheats: true, demo: true })
  }

  const instanceId = request.headers.get(PALWORLD_PROXY_HEADERS.instance)
  const rconConfig = getRconConfig(instanceId)
  if (!rconConfig) {
    return NextResponse.json({ error: 'RCON is not configured on this server' }, { status: 500 })
  }

  let registry = ''
  let palDefender = false
  try {
    registry = await runRcon(rconConfig, 'getrconcmds')
    // A build without PalDefender answers `Unknown command`, which parses to an
    // empty registry -- treat only a non-empty parse as detection.
    palDefender = registry.includes(':') && registry.includes(';')
  } catch {
    palDefender = false
  }

  // Technology IDs come from the operator's own running server, which makes
  // them both correct for their exact build and free of any question about
  // redistributing game data -- see data/README.md. Best-effort: a failure
  // just leaves that picker as free text.
  let techIds = ''
  if (palDefender) {
    try {
      techIds = await runRcon(rconConfig, 'gettechids')
    } catch {
      techIds = ''
    }
  }

  return NextResponse.json({
    palDefender,
    registry: palDefender ? registry : '',
    allowAdminCheats: palDefender ? await readAllowAdminCheats(instanceId) : null,
    techIds,
  })
}

export async function POST(request: NextRequest) {
  const ip = clientIp(request)
  if (isLockedOut(ip)) {
    return NextResponse.json({ error: 'Too many attempts. Try again later.' }, { status: 429 })
  }
  const passwordClass = classifyPassword(presentedPassword(request))
  if (passwordClass === 'unknown') {
    recordFailure(ip)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (tierForClass(passwordClass) !== 'admin') {
    return NextResponse.json({ error: 'Forbidden: the RCON console is admin-only' }, { status: 403 })
  }

  let command = ''
  try {
    const body = (await request.json()) as { command?: unknown }
    if (typeof body.command === 'string') command = body.command.trim()
  } catch {
    return NextResponse.json({ error: 'Malformed request body' }, { status: 400 })
  }

  if (!command) {
    return NextResponse.json({ error: 'No command provided' }, { status: 400 })
  }
  // RCON's own convention: commands are sent WITHOUT a leading slash (unlike
  // in-game chat). Strip one if present so pasted in-game commands still work.
  if (command.startsWith('/')) command = command.slice(1)

  if (DEMO_MODE) {
    return NextResponse.json({ success: true, response: `[demo mode] would run: ${command}` })
  }

  const instanceId = request.headers.get(PALWORLD_PROXY_HEADERS.instance)
  const rconConfig = getRconConfig(instanceId)
  if (!rconConfig) {
    return NextResponse.json({ error: 'RCON is not configured on this server (missing admin password)' }, { status: 500 })
  }

  try {
    // Passed as a single argv element (execFile, no shell) -- multi-word
    // commands like "Broadcast Hello there" arrive at the binary intact,
    // exactly as gorcon/rcon-cli expects for a one-shot command.
    return NextResponse.json({ success: true, response: await runRcon(rconConfig, command) })
  } catch (error) {
    // A command like Shutdown/DoExit can legitimately close the connection
    // before a response arrives -- that's not necessarily a failure to
    // surface as one; report it plainly either way and let the admin judge.
    const message = extractProcessOutput(error)
    return NextResponse.json(
      { error: `RCON error: ${message}`, note: 'If this command stops or restarts the server, this can happen even when the command succeeded.' },
      { status: 502 }
    )
  }
}
