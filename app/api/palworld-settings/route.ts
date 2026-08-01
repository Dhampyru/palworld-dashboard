import { NextRequest, NextResponse } from 'next/server'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeConfigFileWithBackup } from '@/lib/config-write'
import { classifyPassword, tierForClass } from '@/lib/access-tier'
import { clientIp, isLockedOut, recordFailure } from '@/lib/rate-limit'
import { DEMO_MODE } from '@/lib/demo-mode'
import { PALWORLD_PROXY_HEADERS } from '@/lib/palworld'
import {
  SETTING_FIELDS,
  parseOptionSettings,
  serializeOptionSettings,
  formatValue,
  inferKind,
  unquote,
} from '@/lib/palworld-settings'
import { runWithInstance, currentEnvFilePath, currentGameDir } from '@/lib/instances'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Per-instance PalWorldSettings.ini path (server-only; the shared parser lib
// stays client-safe). Resolves to the active instance via runWithInstance.
const settingsIniPath = () =>
  join(currentGameDir(), 'Pal', 'Saved', 'Config', 'WindowsServer', 'PalWorldSettings.ini')

const ENV_SYNC_MAP: Record<string, string> = {
  ServerName: 'SERVER_NAME',
  AdminPassword: 'ADMIN_PASSWORD',
  ServerPassword: 'SERVER_PASSWORD',
  ServerPlayerMaxNum: 'MAX_PLAYERS',
  RESTAPIEnabled: 'REST_API_ENABLED',
}

// PATCH (not upstream): entrypoint.sh's update_settings() re-applies these
// specific .env values into the ini on every single boot -- if we only wrote
// the ini here, the very next restart would silently revert these 4 fields
// back to whatever .env still says, even though the ini save itself
// succeeded. Writes in-place (no temp-file-then-rename): this file is
// bind-mounted as a single file, and a rename would swap the inode, detaching
// it from the mount -- the same class of bug already hit once tonight with
// console.log rotation.
async function syncEnvFile(updatedValues: Record<string, string | number | boolean>) {
  const envUpdates: Record<string, string> = {}
  for (const [iniKey, envVar] of Object.entries(ENV_SYNC_MAP)) {
    if (iniKey in updatedValues) {
      envUpdates[envVar] = String(updatedValues[iniKey])
    }
  }
  if (Object.keys(envUpdates).length === 0) return

  const envPath = currentEnvFilePath()
  let envContent: string
  try {
    envContent = await readFile(envPath, 'utf8')
  } catch {
    return // .env not mounted/accessible -- ini save still succeeded, just skip sync
  }

  const lines = envContent.split('\n')
  const seen = new Set<string>()
  const newLines = lines.map((line) => {
    const match = /^([A-Z_][A-Z0-9_]*)=/.exec(line)
    if (match && match[1] in envUpdates) {
      seen.add(match[1])
      return `${match[1]}=${envUpdates[match[1]]}`
    }
    return line
  })
  for (const [envVar, value] of Object.entries(envUpdates)) {
    if (!seen.has(envVar)) newLines.push(`${envVar}=${value}`)
  }
  await writeFile(envPath, newLines.join('\n'), 'utf8')
}

// PATCH (not upstream): direct filesystem read/write of PalWorldSettings.ini --
// bypasses the Palworld REST API entirely, because that API only ever reads
// settings, never writes them (confirmed: there is no vanilla mechanism to
// apply a setting live). Every change here requires a server restart to take
// effect, same as manually editing the file by hand would.

function presentedPassword(request: NextRequest) {
  return request.headers.get(PALWORLD_PROXY_HEADERS.adminPassword) ?? ''
}

function decodeValue(raw: string): string | number | boolean {
  const kind = inferKind(raw)
  switch (kind) {
    case 'string':
      return unquote(raw)
    case 'boolean':
      return raw === 'True'
    case 'float':
    case 'integer':
      return Number(raw)
    case 'enum':
    default:
      return raw
  }
}

export async function GET(request: NextRequest) {
  return runWithInstance(request.headers.get(PALWORLD_PROXY_HEADERS.instance), () => getSettings(request))
}
async function getSettings(request: NextRequest) {
  const ip = clientIp(request)
  if (isLockedOut(ip)) {
    return NextResponse.json({ error: 'Too many attempts. Try again later.' }, { status: 429 })
  }
  const passwordClass = classifyPassword(presentedPassword(request))
  if (passwordClass === 'unknown') {
    recordFailure(ip)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  // Read-only, informational -- both tiers may view current settings.

  if (DEMO_MODE) {
    return NextResponse.json({
      fields: SETTING_FIELDS.map((f) => ({ ...f, value: f.kind === 'boolean' ? false : f.kind === 'string' ? 'Demo' : 1 })),
      advanced: {},
    })
  }

  try {
    const iniContent = await readFile(settingsIniPath(), 'utf8')
    const values = parseOptionSettings(iniContent)
    const knownKeys = new Set(SETTING_FIELDS.map((f) => f.key))

    const fields = SETTING_FIELDS.map((f) => {
      const raw = values.get(f.key)
      return { ...f, value: raw !== undefined ? decodeValue(raw) : null }
    })

    const advanced: Record<string, string | number | boolean> = {}
    for (const [key, raw] of values.entries()) {
      if (!knownKeys.has(key)) advanced[key] = decodeValue(raw)
    }

    return NextResponse.json({ fields, advanced })
  } catch (error) {
    return NextResponse.json(
      { error: `Failed to read settings: ${error instanceof Error ? error.message : 'unknown error'}` },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest) {
  return runWithInstance(request.headers.get(PALWORLD_PROXY_HEADERS.instance), () => postSettings(request))
}
async function postSettings(request: NextRequest) {
  const ip = clientIp(request)
  if (isLockedOut(ip)) {
    return NextResponse.json({ error: 'Too many attempts. Try again later.' }, { status: 429 })
  }
  const passwordClass = classifyPassword(presentedPassword(request))
  if (passwordClass === 'unknown') {
    recordFailure(ip)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  // Changes take effect on next restart but still alter real server behavior
  // -- admin-only, matching every other mutating route in this app.
  if (tierForClass(passwordClass) !== 'admin') {
    return NextResponse.json({ error: 'Forbidden: changing settings is admin-only' }, { status: 403 })
  }

  let updates: Record<string, unknown> = {}
  try {
    const body = (await request.json()) as { updates?: unknown }
    if (body.updates && typeof body.updates === 'object') {
      updates = body.updates as Record<string, unknown>
    }
  } catch {
    return NextResponse.json({ error: 'Malformed request body' }, { status: 400 })
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'No updates provided' }, { status: 400 })
  }

  if (DEMO_MODE) {
    return NextResponse.json({ success: true, dryRun: true, updated: Object.keys(updates) })
  }

  try {
    const iniContent = await readFile(settingsIniPath(), 'utf8')
    const values = parseOptionSettings(iniContent)

    const updatedKeys: string[] = []
    for (const [key, newValue] of Object.entries(updates)) {
      // Never silently create new keys -- only ever touch fields that
      // genuinely already exist in this server's own ini file.
      const originalRaw = values.get(key)
      if (originalRaw === undefined) {
        return NextResponse.json({ error: `Unknown setting: ${key}` }, { status: 400 })
      }
      if (typeof newValue !== 'string' && typeof newValue !== 'number' && typeof newValue !== 'boolean') {
        return NextResponse.json({ error: `Invalid value for ${key}` }, { status: 400 })
      }
      values.set(key, formatValue(newValue, originalRaw))
      updatedKeys.push(key)
    }

    const rebuilt = serializeOptionSettings(iniContent, values)
    // Snapshots PalWorldSettings.ini to a timestamped .bak (last 10) then writes
    // atomically. The .env sync stays separate below: it writes in place (single
    // bind-mounted file) and must never be backed up -- it holds the password.
    await writeConfigFileWithBackup(settingsIniPath(), rebuilt)
    await syncEnvFile(updates as Record<string, string | number | boolean>)

    return NextResponse.json({ success: true, updated: updatedKeys })
  } catch (error) {
    return NextResponse.json(
      { error: `Failed to write settings: ${error instanceof Error ? error.message : 'unknown error'}` },
      { status: 500 }
    )
  }
}
