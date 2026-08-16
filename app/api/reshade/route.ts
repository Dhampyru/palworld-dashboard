import { NextRequest, NextResponse } from 'next/server'
import { classifyPassword, tierForClass } from '@/lib/access-tier'
import { clientIp, isLockedOut, recordFailure } from '@/lib/rate-limit'
import { DEMO_MODE } from '@/lib/demo-mode'
import { PALWORLD_PROXY_HEADERS } from '@/lib/palworld'
import {
  addReshadePresetFromBuffer,
  clearReshadeBase,
  promoteBaseToDefault,
  removeReshadePreset,
  reresolveAllPresets,
  reshadeStatus,
  saveReshadeBase,
  setReshadeEnabled,
} from '@/lib/reshade'
import { addShaderFiles, SHADER_REPOS } from '@/lib/reshade-shaders'
import { downloadNexusFile, getModFiles, getModInfo, parseNexusModId } from '@/lib/nexus'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// PATCH (not upstream): ReShade in the client loadout (docs/specs/reshade-loadout.md). Admin-only.
// GET returns config; POST (JSON) toggles/adds-by-url/removes; POST (multipart) uploads base/preset.
// Global (not instance-scoped) — the client loadout is shared, like client mods.
function requireAdmin(request: NextRequest): NextResponse | null {
  const ip = clientIp(request)
  if (isLockedOut(ip)) return NextResponse.json({ error: 'Too many attempts. Try again later.' }, { status: 429 })
  const cls = classifyPassword(request.headers.get(PALWORLD_PROXY_HEADERS.adminPassword) ?? '')
  if (cls === 'unknown') {
    recordFailure(ip)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (tierForClass(cls) !== 'admin') return NextResponse.json({ error: 'Forbidden: admin-only' }, { status: 403 })
  return null
}

export async function GET(request: NextRequest) {
  const denied = requireAdmin(request)
  if (denied) return denied
  try {
    return NextResponse.json({ ...(await reshadeStatus()), shaderRepos: SHADER_REPOS })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const denied = requireAdmin(request)
  if (denied) return denied
  if (DEMO_MODE) return NextResponse.json({ error: 'Disabled in demo mode' }, { status: 400 })

  const contentType = request.headers.get('content-type') ?? ''
  const ok = async () => NextResponse.json({ ok: true, ...(await reshadeStatus()) })
  try {
    // ── Multipart: base bundle or preset file upload ──────────────────────────
    if (contentType.includes('multipart/form-data')) {
      const form = await request.formData()
      const base = form.get('base')
      const preset = form.get('preset')
      if (base instanceof File) {
        await saveReshadeBase(Buffer.from(await base.arrayBuffer()), base.name)
        return ok()
      }
      if (preset instanceof File) {
        await addReshadePresetFromBuffer(Buffer.from(await preset.arrayBuffer()), preset.name, `upload: ${preset.name}`)
        return ok()
      }
      const shader = form.get('shader')
      if (shader instanceof File) {
        await addShaderFiles(Buffer.from(await shader.arrayBuffer()), shader.name)
        await reresolveAllPresets() // refresh missing/resolved counts now that the gap is filled
        return ok()
      }
      return NextResponse.json({ error: 'No base, preset, or shader file provided' }, { status: 400 })
    }

    // ── JSON actions ──────────────────────────────────────────────────────────
    const body = (await request.json()) as { action?: string; enabled?: boolean; url?: string; file?: string }
    switch (body.action) {
      case 'setEnabled':
        await setReshadeEnabled(Boolean(body.enabled))
        return ok()
      case 'clearBase':
        await clearReshadeBase()
        return ok()
      case 'bakeDefault':
        await promoteBaseToDefault()
        return ok()
      case 'removePreset':
        if (!body.file) return NextResponse.json({ error: 'file required' }, { status: 400 })
        await removeReshadePreset(body.file)
        return ok()
      case 'reresolve':
        await reresolveAllPresets()
        return ok()
      case 'addPresetUrl': {
        const modId = parseNexusModId(body.url ?? '')
        if (!modId) return NextResponse.json({ error: 'Paste a valid Nexus mod URL (presets are on Nexus).' }, { status: 400 })
        const [info, files] = await Promise.all([getModInfo(modId), getModFiles(modId)])
        const main = files.filter((f) => (f.category ?? '').toUpperCase() === 'MAIN')
        const pick = main[0] ?? files[0]
        if (!pick) return NextResponse.json({ error: 'No downloadable file on that mod (Premium key required).' }, { status: 400 })
        const buf = await downloadNexusFile(modId, pick.fileId)
        await addReshadePresetFromBuffer(buf, pick.name ?? `${info?.name ?? 'preset'}.ini`, `nexus: ${info?.name ?? modId}`)
        return ok()
      }
      default:
        return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
    }
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed' }, { status: 500 })
  }
}
