import { NextRequest, NextResponse } from 'next/server'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { classifyPassword, tierForClass } from '@/lib/access-tier'
import { clientIp, isLockedOut, recordFailure } from '@/lib/rate-limit'
import { DEMO_MODE } from '@/lib/demo-mode'
import { PALWORLD_PROXY_HEADERS } from '@/lib/palworld'
import { extractProcessOutput, getRconConfig, runRcon } from '@/lib/rcon-exec'
import { runWithInstance, currentGameDir, currentInstanceId } from '@/lib/instances'
import { writeConfigFileWithBackup } from '@/lib/config-write'
import {
  PD_FIELD_BY_KEY,
  isValidJson,
  parsePalDefenderConfig,
  writePalDefenderConfig,
  type PdValues,
} from '@/lib/paldefender-config'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// PATCH (not upstream): PalDefender config route (docs/specs/paldefender-tab-
// spec.md). A0 confirmed the STANDALONE layout -- config at
// Pal/Binaries/Win64/PalDefender/, REST config + tokens in RESTAPI/ siblings,
// NOT the spec's assumed ue4ss/Mods path. Admin-tier only.

// Multi-instance (#7): paths resolve to the active instance (runWithInstance).
const pdDir = () => join(currentGameDir(), 'Pal', 'Binaries', 'Win64', 'PalDefender')
const configPath = () => join(pdDir(), 'Config.json')
const restConfigPath = () => join(pdDir(), 'RESTAPI', 'RESTConfig.json')
const tokenPath = () => join(pdDir(), 'RESTAPI', 'Tokens', 'dashboard.json')

function presentedPassword(request: NextRequest) {
  return request.headers.get(PALWORLD_PROXY_HEADERS.adminPassword) ?? ''
}

function requireAdmin(request: NextRequest): NextResponse | null {
  const passwordClass = classifyPassword(presentedPassword(request))
  if (passwordClass === 'unknown') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (tierForClass(passwordClass) !== 'admin')
    return NextResponse.json({ error: 'Forbidden: PalDefender config is admin-only' }, { status: 403 })
  return null
}

async function readConfig(): Promise<{ raw: string; exists: boolean }> {
  try {
    return { raw: await readFile(configPath(), 'utf8'), exists: true }
  } catch {
    return { raw: '', exists: false }
  }
}

// REST info spans two sibling files (A0): RESTConfig.json holds enable/port,
// the per-client token is its own file. Best-effort -- absence is a valid state.
async function readRestInfo(): Promise<{ enabled: boolean | null; port: number | null; token: string | null }> {
  let enabled: boolean | null = null
  let port: number | null = null
  let token: string | null = null
  try {
    const rc = JSON.parse(await readFile(restConfigPath(), 'utf8')) as { Enabled?: unknown; Port?: unknown }
    if (typeof rc.Enabled === 'boolean') enabled = rc.Enabled
    if (typeof rc.Port === 'number') port = rc.Port
  } catch {
    /* not configured */
  }
  try {
    const tk = JSON.parse(await readFile(tokenPath(), 'utf8')) as { Token?: unknown }
    if (typeof tk.Token === 'string') token = tk.Token
  } catch {
    /* no token file */
  }
  return { enabled, port, token }
}

export async function GET(request: NextRequest) {
  return runWithInstance(request.headers.get(PALWORLD_PROXY_HEADERS.instance), () => getPd(request))
}
async function getPd(request: NextRequest) {
  const denied = requireAdmin(request)
  if (denied) return denied

  if (DEMO_MODE) {
    return NextResponse.json({ detected: true, version: '1.8.3', values: {}, motd: [], raw: '', rest: { enabled: true, port: 17993, token: null }, demo: true })
  }

  const { raw, exists } = await readConfig()
  // Detection for the tab: the standalone config file present == installed.
  // Graceful not-detected state when absent (spec A3).
  if (!exists) {
    return NextResponse.json({ detected: false, version: null, values: {}, motd: [], raw: '', rest: { enabled: null, port: null, token: null } })
  }

  const parsed = parsePalDefenderConfig(raw)
  return NextResponse.json({
    detected: true,
    version: parsed.version,
    values: parsed.values,
    motd: parsed.motd,
    raw,
    rest: await readRestInfo(),
    path: configPath(),
  })
}

// Coerce/validate a managed scalar map against the schema-present keys.
function sanitizeValues(input: unknown): { values: PdValues } | { error: string } {
  if (!input || typeof input !== 'object') return { error: 'values must be an object' }
  const values: PdValues = {}
  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    const field = PD_FIELD_BY_KEY[key]
    if (!field) return { error: `Unknown PalDefender key: ${key}` }
    if (field.kind === 'bool') {
      values[key] = raw === true || raw === 'true'
    } else {
      const n = typeof raw === 'number' ? raw : Number(raw)
      if (!Number.isFinite(n)) return { error: `Invalid number for ${key}` }
      values[key] = n
    }
  }
  return { values }
}

export async function PUT(request: NextRequest) {
  return runWithInstance(request.headers.get(PALWORLD_PROXY_HEADERS.instance), () => putPd(request))
}
async function putPd(request: NextRequest) {
  const ip = clientIp(request)
  if (isLockedOut(ip)) return NextResponse.json({ error: 'Too many attempts. Try again later.' }, { status: 429 })
  const passwordClass = classifyPassword(presentedPassword(request))
  if (passwordClass === 'unknown') {
    recordFailure(ip)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (tierForClass(passwordClass) !== 'admin')
    return NextResponse.json({ error: 'Forbidden: PalDefender config is admin-only' }, { status: 403 })

  let body: { mode?: unknown; values?: unknown; motd?: unknown; content?: unknown }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return NextResponse.json({ error: 'Malformed request body' }, { status: 400 })
  }

  const mode = body.mode
  if (mode !== 'write' && mode !== 'raw' && mode !== 'reload') {
    return NextResponse.json({ error: 'mode must be "write", "raw" or "reload"' }, { status: 400 })
  }

  // "Apply now" -- reload PalDefender's config without a restart (spec A2).
  if (mode === 'reload') {
    if (DEMO_MODE) return NextResponse.json({ success: true, reloaded: true, demo: true })
    const rconConfig = getRconConfig(currentInstanceId())
    if (!rconConfig) return NextResponse.json({ error: 'RCON is not configured' }, { status: 500 })
    try {
      const response = await runRcon(rconConfig, 'reloadcfg')
      return NextResponse.json({ success: true, reloaded: true, response })
    } catch (error) {
      return NextResponse.json({ error: `reloadcfg failed: ${extractProcessOutput(error)}` }, { status: 502 })
    }
  }

  // Build the next file content (validated) before the demo short-circuit.
  let nextContent: string
  if (mode === 'raw') {
    if (typeof body.content !== 'string') return NextResponse.json({ error: 'raw mode requires string content' }, { status: 400 })
    // A JSON syntax error would kill the mod's config load -- refuse it.
    if (!isValidJson(body.content)) return NextResponse.json({ error: 'Refusing to save: not valid JSON' }, { status: 400 })
    nextContent = body.content
  } else {
    const { raw, exists } = await readConfig()
    if (!exists) return NextResponse.json({ error: 'PalDefender Config.json not found' }, { status: 404 })
    const changes: { values?: PdValues; motd?: string[] } = {}
    if (body.values !== undefined) {
      const sanitized = sanitizeValues(body.values)
      if ('error' in sanitized) return NextResponse.json({ error: sanitized.error }, { status: 400 })
      changes.values = sanitized.values
    }
    if (body.motd !== undefined) {
      if (!Array.isArray(body.motd) || !body.motd.every((l) => typeof l === 'string'))
        return NextResponse.json({ error: 'motd must be an array of strings' }, { status: 400 })
      changes.motd = body.motd as string[]
    }
    try {
      nextContent = writePalDefenderConfig(raw, changes)
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : 'write failed' }, { status: 400 })
    }
  }

  if (DEMO_MODE) return NextResponse.json({ success: true, dryRun: true, mode })

  try {
    await writeConfigFileWithBackup(configPath(), nextContent)
  } catch (error) {
    return NextResponse.json({ error: `Failed to write Config.json: ${error instanceof Error ? error.message : 'unknown'}` }, { status: 500 })
  }

  const parsed = parsePalDefenderConfig(nextContent)
  return NextResponse.json({
    success: true,
    mode,
    values: parsed.values,
    motd: parsed.motd,
    // Config + MOTD take effect on reloadcfg; no restart needed (spec A2).
    note: 'Saved. Use “Apply now” to reload PalDefender without a restart.',
  })
}
