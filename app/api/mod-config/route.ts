import { NextRequest, NextResponse } from 'next/server'
import { classifyPassword, tierForClass } from '@/lib/access-tier'
import { clientIp, isLockedOut, recordFailure } from '@/lib/rate-limit'
import { DEMO_MODE } from '@/lib/demo-mode'
import { PALWORLD_PROXY_HEADERS } from '@/lib/palworld'
import { runWithInstance } from '@/lib/instances'
import { basename } from 'node:path'
import {
  createModConfigFromTemplate,
  listModConfigs,
  readModConfig,
  writeModConfig,
} from '@/lib/mod-config'
import { getDeclaration, setConfigOverride } from '@/lib/mod-catalog'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Mod Config Editor (docs/specs/mod-config-editor.md). Admin-only, instance-scoped.
// GET ?mod=<name>            → the mod's discovered config files (no content)
// GET ?mod=<name>&file=<id>  → { file, content } for one file
// POST { mod, file, content }         → save (validated for the file's format)
// POST { mod, file, action:'create' } → create a missing live config from its template
function presentedPassword(request: NextRequest) {
  return request.headers.get(PALWORLD_PROXY_HEADERS.adminPassword) ?? ''
}
function requireAdmin(request: NextRequest): NextResponse | null {
  const ip = clientIp(request)
  if (isLockedOut(ip)) return NextResponse.json({ error: 'Too many attempts. Try again later.' }, { status: 429 })
  const passwordClass = classifyPassword(presentedPassword(request))
  if (passwordClass === 'unknown') {
    recordFailure(ip)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (tierForClass(passwordClass) !== 'admin') {
    return NextResponse.json({ error: 'Forbidden: editing mod config is admin-only' }, { status: 403 })
  }
  return null
}

export async function GET(request: NextRequest) {
  return runWithInstance(request.headers.get(PALWORLD_PROXY_HEADERS.instance), () => _GET(request))
}
async function _GET(request: NextRequest) {
  const denied = requireAdmin(request)
  if (denied) return denied
  const mod = request.nextUrl.searchParams.get('mod') ?? ''
  if (!mod) return NextResponse.json({ error: 'mod required' }, { status: 400 })
  const fileId = request.nextUrl.searchParams.get('file')

  try {
    if (fileId) {
      const { file, content } = await readModConfig(mod, fileId)
      // Never leak the absolute server path to the client.
      const { absPath: _abs, seedFrom: _seed, ...meta } = file
      return NextResponse.json({ file: meta, content })
    }
    const files = (await listModConfigs(mod)).map(({ absPath: _a, seedFrom: _s, ...meta }) => meta)
    // `overridden` tells the UI the declaration is a manual override (so it can offer a
    // "clear" back to heuristic/description); `declarable` when there's nothing declared
    // yet and >1 candidate, so the UI can offer "set as config" per file.
    const decl = await getDeclaration(mod)
    return NextResponse.json({ mod, files, overridden: decl.source === 'override', declared: decl.source !== null })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed to read config' }, { status: 400 })
  }
}

export async function POST(request: NextRequest) {
  return runWithInstance(request.headers.get(PALWORLD_PROXY_HEADERS.instance), () => _POST(request))
}
async function _POST(request: NextRequest) {
  const denied = requireAdmin(request)
  if (denied) return denied
  if (DEMO_MODE) return NextResponse.json({ success: true, dryRun: true })

  let body: { mod?: string; file?: string; content?: string; action?: string }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return NextResponse.json({ error: 'Malformed request body' }, { status: 400 })
  }
  const mod = typeof body.mod === 'string' ? body.mod : ''
  const file = typeof body.file === 'string' ? body.file : ''
  if (!mod) return NextResponse.json({ error: 'mod required' }, { status: 400 })

  try {
    // Override map: mark a file as THE config for a mod (or clear back to heuristic).
    if (body.action === 'setOverride') {
      if (!file) return NextResponse.json({ error: 'file required' }, { status: 400 })
      await setConfigOverride(mod, [basename(file)])
      return NextResponse.json({ success: true, overridden: true })
    }
    if (body.action === 'clearOverride') {
      await setConfigOverride(mod, null)
      return NextResponse.json({ success: true, overridden: false })
    }
    if (!file) return NextResponse.json({ error: 'file required' }, { status: 400 })
    if (body.action === 'create') {
      await createModConfigFromTemplate(mod, file)
      return NextResponse.json({ success: true, created: true })
    }
    if (typeof body.content !== 'string') return NextResponse.json({ error: 'content required' }, { status: 400 })
    await writeModConfig(mod, file, body.content)
    return NextResponse.json({ success: true, note: 'Saved — restart the server to apply.' })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Save failed' }, { status: 400 })
  }
}
