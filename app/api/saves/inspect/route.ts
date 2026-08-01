import { NextRequest, NextResponse } from 'next/server'
import { classifyPassword, tierForClass } from '@/lib/access-tier'
import { clientIp, isLockedOut, recordFailure } from '@/lib/rate-limit'
import { DEMO_MODE } from '@/lib/demo-mode'
import { PALWORLD_PROXY_HEADERS } from '@/lib/palworld'
import { runWithInstance } from '@/lib/instances'
import { decodeSaveToJson, readActiveWorldId, resolvePlayerSavePath } from '@/lib/saves'
import { stat } from 'node:fs/promises'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// PATCH (not upstream): read-only Save Inspector (roadmap item 3, revived — see
// CLAUDE.md §3 gotcha 7). Decodes a player's PlM1/Oodle .sav via the vendored
// psp-decode helper and returns a structural summary. Stage 1 is deliberately a
// proof of concept: it confirms the decode pipeline end to end and enumerates
// what the save contains. Deep per-Pal/inventory views (which need Level.sav +
// psp-core's session API) are Stage 2. Admin-only; nothing is written.

function presentedPassword(request: NextRequest) {
  return request.headers.get(PALWORLD_PROXY_HEADERS.adminPassword) ?? ''
}

// Pull a robust structural summary out of uesave's GVAS JSON. Only touches keys
// that are reliably present as strings, so it can't crash on schema drift.
function summarize(json: string) {
  let data: unknown
  try {
    data = JSON.parse(json)
  } catch {
    return null
  }
  const root = (data as { root?: { properties?: Record<string, unknown> } }).root
  const topLevel = Object.keys(root?.properties ?? {}).map((k) => k.replace(/_\d+$/, ''))
  // uesave nests the schema map under schemas.schemas.
  const schemas =
    ((data as { schemas?: { schemas?: Record<string, unknown> } }).schemas?.schemas ?? {}) as Record<
      string,
      unknown
    >
  const schemaKeys = Object.keys(schemas)
  const rootStructKey = schemaKeys.find((k) => !k.includes('.')) ?? null
  const structType =
    (schemas[rootStructKey ?? '']?.valueOf() as { data?: { Struct?: { struct_type?: { Struct?: string } } } })
      ?.data?.Struct?.struct_type?.Struct ?? rootStructKey
  // Field paths under the root struct = what the save actually stores.
  const prefix = rootStructKey ? `${rootStructKey}.` : ''
  const fields = prefix
    ? schemaKeys.filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length))
    : []
  return { structType, topLevel, fieldCount: fields.length, fields: fields.slice(0, 80) }
}

export async function POST(request: NextRequest) {
  return runWithInstance(request.headers.get(PALWORLD_PROXY_HEADERS.instance), () => _POST(request))
}
async function _POST(request: NextRequest) {
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
    return NextResponse.json({ error: 'Forbidden: saves are admin-only' }, { status: 403 })
  }

  let body: { worldId?: unknown; playerUid?: unknown }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return NextResponse.json({ error: 'Malformed request body' }, { status: 400 })
  }

  if (DEMO_MODE) {
    return NextResponse.json({ ok: true, demo: true, summary: null })
  }

  const worldId = typeof body.worldId === 'string' ? body.worldId : await readActiveWorldId()
  const full = resolvePlayerSavePath(worldId, body.playerUid)
  if (!full) return NextResponse.json({ error: 'Invalid world or player id' }, { status: 400 })

  try {
    const [{ size }, json] = await Promise.all([stat(full), decodeSaveToJson(full)])
    return NextResponse.json({
      ok: true,
      sizeBytes: size,
      decodedBytes: json.length,
      summary: summarize(json),
    })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to decode save' },
      { status: 500 },
    )
  }
}
