import { NextRequest, NextResponse } from 'next/server'
import { classifyPassword, tierForClass } from '@/lib/access-tier'
import { clientIp, isLockedOut, recordFailure } from '@/lib/rate-limit'
import { DEMO_MODE } from '@/lib/demo-mode'
import { PALWORLD_PROXY_HEADERS } from '@/lib/palworld'
import { runWithInstance } from '@/lib/instances'
import {
  downloadPalSchemaRelease,
  installPalSchemaLoader,
  installPalSchemaSubmod,
  listPalSchemaSubmods,
  PALSCHEMA_PINNED_TAG,
  readPalSchemaStatus,
  removePalSchemaSubmod,
} from '@/lib/palschema'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// PATCH (not upstream): PalSchema management (docs/specs/palschema-support.md).
// GET is read-only (both tiers, like /api/game-mods). Every mutation — installing
// the loader, installing/removing a sub-mod — is admin-only. Unlike the UE4SS
// swap route this does NOT require the server stopped: PalSchema and its mods are
// plain mod folders scanned at UE4SS startup, not the injection layer, so a live
// write is harmless and just takes effect on next restart.
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024 // 100MB — PalSchema builds + mods are small

function presentedPassword(request: NextRequest) {
  return request.headers.get(PALWORLD_PROXY_HEADERS.adminPassword) ?? ''
}

function requireAdmin(request: NextRequest): NextResponse | null {
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
    return NextResponse.json({ error: 'Forbidden: PalSchema management is admin-only' }, { status: 403 })
  }
  return null
}

export async function GET(request: NextRequest) {
  return runWithInstance(request.headers.get(PALWORLD_PROXY_HEADERS.instance), () => _GET(request))
}
async function _GET(request: NextRequest) {
  const ip = clientIp(request)
  if (isLockedOut(ip)) {
    return NextResponse.json({ error: 'Too many attempts. Try again later.' }, { status: 429 })
  }
  const passwordClass = classifyPassword(presentedPassword(request))
  if (passwordClass === 'unknown') {
    recordFailure(ip)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (DEMO_MODE) {
    return NextResponse.json({
      status: { installed: false, version: null, submodCount: 0 },
      submods: [],
      pinnedTag: PALSCHEMA_PINNED_TAG,
    })
  }
  try {
    const [status, submods] = await Promise.all([readPalSchemaStatus(), listPalSchemaSubmods()])
    return NextResponse.json({ status, submods, pinnedTag: PALSCHEMA_PINNED_TAG })
  } catch (error) {
    return NextResponse.json(
      { error: `Failed to read PalSchema state: ${error instanceof Error ? error.message : 'unknown error'}` },
      { status: 500 },
    )
  }
}

export async function POST(request: NextRequest) {
  return runWithInstance(request.headers.get(PALWORLD_PROXY_HEADERS.instance), () => _POST(request))
}
async function _POST(request: NextRequest) {
  const denied = requireAdmin(request)
  if (denied) return denied
  if (DEMO_MODE) {
    return NextResponse.json({ status: await readPalSchemaStatus(), submods: [], dryRun: true })
  }

  const contentType = request.headers.get('content-type') ?? ''

  try {
    // JSON: pinned download, or sub-mod removal.
    if (!contentType.includes('multipart/form-data')) {
      const body = (await request.json().catch(() => ({}))) as { action?: string; name?: string }

      if (body.action === 'downloadLoader') {
        const buffer = await downloadPalSchemaRelease()
        const { version } = await installPalSchemaLoader(buffer, PALSCHEMA_PINNED_TAG)
        return NextResponse.json({
          status: await readPalSchemaStatus(),
          submods: await listPalSchemaSubmods(),
          note: `Installed PalSchema ${version ?? PALSCHEMA_PINNED_TAG} — restart the server to load it.`,
        })
      }

      if (body.action === 'remove') {
        if (!body.name) return NextResponse.json({ error: 'name required' }, { status: 400 })
        const { backup } = await removePalSchemaSubmod(body.name)
        return NextResponse.json({
          status: await readPalSchemaStatus(),
          submods: await listPalSchemaSubmods(),
          note: `Removed ${body.name} (backed up to ${backup}) — restart the server to apply.`,
        })
      }

      return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
    }

    // Multipart: sub-mod install. Installing PalSchema *itself* from an arbitrary
    // zip was deliberately removed — PalSchema is version-locked to its UE4SS
    // build, so an ad-hoc upload is a footgun; the pinned download is the only
    // loader-install path (bump PALSCHEMA_PINNED_TAG + the UE4SS build together
    // to change versions).
    const form = await request.formData()
    const target = form.get('target')
    const file = form.get('file')
    if (!(file instanceof File)) return NextResponse.json({ error: 'No zip uploaded' }, { status: 400 })
    if (file.size === 0) return NextResponse.json({ error: 'Uploaded file is empty' }, { status: 400 })
    if (file.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json(
        { error: `File too large (limit ${MAX_UPLOAD_BYTES / 1024 / 1024}MB)` },
        { status: 413 },
      )
    }
    const buffer = Buffer.from(await file.arrayBuffer())

    if (target === 'submod') {
      const result = await installPalSchemaSubmod(buffer, false, file.name.replace(/\.[^./]+$/, ''))
      const note = result.hybrid
        ? `Installed ${result.name}. Hybrid mod — pak files placed for the server, but connecting players must install the client files themselves.`
        : `Installed ${result.name} — restart the server to apply.`
      return NextResponse.json({
        status: await readPalSchemaStatus(),
        submods: await listPalSchemaSubmods(),
        result,
        note,
      })
    }

    return NextResponse.json({ error: 'target must be "submod"' }, { status: 400 })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'PalSchema operation failed' },
      { status: 500 },
    )
  }
}
