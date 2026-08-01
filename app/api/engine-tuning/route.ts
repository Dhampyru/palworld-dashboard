import { NextRequest, NextResponse } from 'next/server'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeConfigFileWithBackup } from '@/lib/config-write'
import { classifyPassword, tierForClass } from '@/lib/access-tier'
import { clientIp, isLockedOut, recordFailure } from '@/lib/rate-limit'
import { DEMO_MODE } from '@/lib/demo-mode'
import { PALWORLD_PROXY_HEADERS } from '@/lib/palworld'
import {
  ENGINE_FIELD_BY_KEY,
  type EngineValue,
  type EngineValues,
  detectPreset,
  parseEngineIni,
  writeEngineIni,
} from '@/lib/engine-tuning'
import { deriveLaunchInfo } from '@/lib/engine-launch'
import { runWithInstance, currentGameDir, currentEnvFilePath } from '@/lib/instances'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// PATCH (not upstream): Engine.ini tuning route (docs/specs/engine-tuning-
// spec.md). Reads and writes Pal/Saved/Config/WindowsServer/Engine.ini on the
// game volume this container already mounts. Admin-tier only -- engine tuning
// is powerful, and the raw editor (§6) can write anything.
//
// Multi-instance (#7): paths resolve to the active instance (runWithInstance);
// `default` resolves to today's env values.
const engineIniPath = () => join(currentGameDir(), 'Pal', 'Saved', 'Config', 'WindowsServer', 'Engine.ini')

function presentedPassword(request: NextRequest) {
  return request.headers.get(PALWORLD_PROXY_HEADERS.adminPassword) ?? ''
}

function requireAdmin(request: NextRequest): NextResponse | null {
  const passwordClass = classifyPassword(presentedPassword(request))
  if (passwordClass === 'unknown') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (tierForClass(passwordClass) !== 'admin') {
    return NextResponse.json({ error: 'Forbidden: engine tuning is admin-only' }, { status: 403 })
  }
  return null
}

// Read the file if present. A missing file is a valid state (spec §1), not an
// error: return empty rather than 500 so the panel can offer to create one.
async function readEngineIni(): Promise<{ raw: string; exists: boolean }> {
  try {
    return { raw: await readFile(engineIniPath(), 'utf8'), exists: true }
  } catch {
    return { raw: '', exists: false }
  }
}

// Launch flags come from the game .env (MULTITHREADING / COMMUNITY). If it is
// not mounted, fall back to the entrypoint's own defaults and flag it as
// unconfirmed so the panel can say so.
async function readLaunchInfo() {
  try {
    return deriveLaunchInfo(await readFile(currentEnvFilePath(), 'utf8'), true)
  } catch {
    return deriveLaunchInfo('', false)
  }
}


export async function GET(request: NextRequest) {
  return runWithInstance(request.headers.get(PALWORLD_PROXY_HEADERS.instance), () => getEngine(request))
}
async function getEngine(request: NextRequest) {
  const denied = requireAdmin(request)
  if (denied) return denied

  if (DEMO_MODE) {
    return NextResponse.json({
      exists: true,
      values: {},
      preset: 'default',
      raw: '',
      demo: true,
      launch: deriveLaunchInfo('', false),
    })
  }

  const { raw, exists } = await readEngineIni()
  const values = parseEngineIni(raw)
  return NextResponse.json({
    exists,
    values, // only the managed keys actually present on disk
    preset: detectPreset(values),
    raw, // full file text, for the raw editor (§6)
    path: engineIniPath(),
    launch: await readLaunchInfo(), // display-only launch flags from the game .env
  })
}

// Coerce and validate an incoming values map against the field schema. Rejects
// unknown keys and non-finite numbers rather than writing garbage to disk.
function sanitizeValues(input: unknown): { values: EngineValues } | { error: string } {
  if (!input || typeof input !== 'object') return { error: 'values must be an object' }
  const values: EngineValues = {}
  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    const field = ENGINE_FIELD_BY_KEY[key]
    if (!field) return { error: `Unknown engine key: ${key}` }
    let value: EngineValue
    if (field.kind === 'bool') {
      value = raw === true || raw === 'true' || raw === 'True' || raw === 1
    } else {
      const n = typeof raw === 'number' ? raw : Number(raw)
      if (!Number.isFinite(n)) return { error: `Invalid number for ${key}` }
      value = n
    }
    values[key] = value
  }
  return { values }
}

export async function PUT(request: NextRequest) {
  return runWithInstance(request.headers.get(PALWORLD_PROXY_HEADERS.instance), () => putEngine(request))
}
async function putEngine(request: NextRequest) {
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
    return NextResponse.json({ error: 'Forbidden: engine tuning is admin-only' }, { status: 403 })
  }

  let body: {
    mode?: unknown
    values?: unknown
    content?: unknown
  }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return NextResponse.json({ error: 'Malformed request body' }, { status: 400 })
  }

  const mode = body.mode
  if (mode !== 'reset' && mode !== 'write' && mode !== 'raw') {
    return NextResponse.json({ error: 'mode must be "reset", "write" or "raw"' }, { status: 400 })
  }

  // Validate BEFORE the demo short-circuit, so demo mode still reports bad input.
  let nextContent: string
  if (mode === 'raw') {
    if (typeof body.content !== 'string') {
      return NextResponse.json({ error: 'raw mode requires a string content' }, { status: 400 })
    }
    // Raw editor writes verbatim -- this is the escape hatch (§6), so it is not
    // reformatted or filtered.
    nextContent = body.content
  } else {
    const { raw } = await readEngineIni()
    if (mode === 'reset') {
      nextContent = writeEngineIni(raw, { type: 'reset' })
    } else {
      const sanitized = sanitizeValues(body.values)
      if ('error' in sanitized) {
        return NextResponse.json({ error: sanitized.error }, { status: 400 })
      }
      nextContent = writeEngineIni(raw, { type: 'write', values: sanitized.values })
    }
  }

  if (DEMO_MODE) {
    return NextResponse.json({ success: true, dryRun: true, mode })
  }

  try {
    await writeConfigFileWithBackup(engineIniPath(), nextContent)
  } catch (error) {
    return NextResponse.json(
      { error: `Failed to write Engine.ini: ${error instanceof Error ? error.message : 'unknown error'}` },
      { status: 500 },
    )
  }

  const values = parseEngineIni(nextContent)
  return NextResponse.json({
    success: true,
    mode,
    values,
    preset: detectPreset(values),
    // Engine.ini is read at server start (spec §7).
    note: 'Saved — takes effect on next server restart.',
  })
}
