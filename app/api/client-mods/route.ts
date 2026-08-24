import { NextRequest, NextResponse } from 'next/server'
import { classifyPassword, tierForClass } from '@/lib/access-tier'
import { clientIp, isLockedOut, recordFailure } from '@/lib/rate-limit'
import { DEMO_MODE } from '@/lib/demo-mode'
import { PALWORLD_PROXY_HEADERS } from '@/lib/palworld'
import { runWithInstance } from '@/lib/instances'
import { readCatalog } from '@/lib/mod-catalog'
import {
  addClientModFromNexus,
  addClientModFromSteam,
  addClientModsBulk,
  addClientModUpload,
  backfillClientWarnings,
  checkClientModUpdates,
  clientModUpdateAvailable,
  listClientMods,
  removeClientMod,
  setClientModKeep,
  updateClientMod,
  type ClientMod,
} from '@/lib/client-mods'
import { clearClientModConfig, listClientModConfigs, saveClientModConfig } from '@/lib/client-mod-config'
import { removeServerModsBySource } from '@/lib/game-mods'
import { removePalSchemaSubmodByName } from '@/lib/palschema'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// PATCH (not upstream): the client-mod store (docs/specs/client-mod-sync.md §2c, Phase 2
// intake). Admin STAGES the mods a friend's client needs WITHOUT installing them on the
// server. GET lists the staged set + catalog suggestions (client-relevant mods not yet
// staged). POST stages one (Nexus/Steam URL or upload), toggles keep, or removes. The
// loadout generator that turns this into a friend bundle is a separate, later piece.
const MAX_UPLOAD_BYTES = 300 * 1024 * 1024 // 300MB raw upload, matching the mod-install route

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
    return NextResponse.json({ error: 'Forbidden: client mods are admin-only' }, { status: 403 })
  }
  return null
}

// A staged mod matches a catalog entry when it came from the same source + id (Steam's
// catalog source is 'workshop'; a staged Steam mod's source is 'steam').
function isStaged(mods: ClientMod[], source: 'nexus' | 'workshop', id: string): boolean {
  const wantSource = source === 'workshop' ? 'steam' : 'nexus'
  return mods.some((m) => m.source === wantSource && m.sourceId === id)
}

export async function GET(request: NextRequest) {
  return runWithInstance(request.headers.get(PALWORLD_PROXY_HEADERS.instance), () => _GET(request))
}
async function _GET(request: NextRequest) {
  const denied = requireAdmin(request)
  if (denied) return denied
  const [modsRaw, catalog] = await Promise.all([listClientMods(), readCatalog()])
  // Derive updateAvailable per mod from the cached fields (no network here — a refresh is the
  // explicit 'checkUpdates' action). Mirrors the server Nexus/Steam update chips.
  const mods = modsRaw.map((m) => ({ ...m, updateAvailable: clientModUpdateAvailable(m) }))
  // Suggestions: client-relevant catalog mods not already staged. Newest surfaced first
  // isn't meaningful here (no add time), so sort by name.
  const suggestions = catalog
    .filter((e) => e.clientRelevant && !isStaged(mods, e.source, e.id))
    .map((e) => ({
      source: e.source,
      id: e.id,
      name: e.name,
      url: e.url,
      category: e.category,
      installOn: e.installOn,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
  return NextResponse.json({ mods, suggestions, catalogAvailable: catalog.length > 0 })
}

export async function POST(request: NextRequest) {
  return runWithInstance(request.headers.get(PALWORLD_PROXY_HEADERS.instance), () => _POST(request))
}
async function _POST(request: NextRequest) {
  const denied = requireAdmin(request)
  if (denied) return denied

  const contentType = request.headers.get('content-type') ?? ''

  // ── Multipart: manual upload ────────────────────────────────────────────────
  if (contentType.includes('multipart/form-data')) {
    let form: FormData
    try {
      form = await request.formData()
    } catch {
      return NextResponse.json({ error: 'Malformed upload' }, { status: 400 })
    }
    const file = form.get('file')
    if (!(file instanceof File)) return NextResponse.json({ error: 'No file provided' }, { status: 400 })
    if (file.size === 0) return NextResponse.json({ error: 'Uploaded file is empty' }, { status: 400 })
    if (file.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json(
        { error: `File too large (${Math.round(file.size / 1024 / 1024)}MB — limit is ${MAX_UPLOAD_BYTES / 1024 / 1024}MB)` },
        { status: 413 },
      )
    }
    if (DEMO_MODE) return NextResponse.json({ dryRun: true })
    try {
      const buffer = Buffer.from(await file.arrayBuffer())
      const mod = await addClientModUpload(file.name, buffer)
      return NextResponse.json({ mod, note: `Staged ${mod.name} for clients.` })
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : 'Upload failed' }, { status: 400 })
    }
  }

  // ── JSON: add-by-URL, keep toggle, remove ───────────────────────────────────
  let body: {
    action?: string
    url?: string
    urls?: string[]
    source?: string
    id?: string
    keep?: boolean
    cfg?: string
    content?: string
    fileId?: number // Nexus: stage a specific file/version (from the version picker)
    force?: boolean // checkUpdates: re-check even fresh entries
  }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return NextResponse.json({ error: 'Malformed request body' }, { status: 400 })
  }

  if (DEMO_MODE && body.action !== 'list') return NextResponse.json({ dryRun: true })

  try {
    switch (body.action) {
      case 'setKeep': {
        if (typeof body.id !== 'string' || typeof body.keep !== 'boolean') {
          return NextResponse.json({ error: 'id and keep required' }, { status: 400 })
        }
        const mod = await setClientModKeep(body.id, body.keep)
        return NextResponse.json({ mod })
      }
      case 'remove': {
        if (typeof body.id !== 'string') return NextResponse.json({ error: 'id required' }, { status: 400 })
        // Capture the source BEFORE removing so we can cascade to the paired SERVER install
        // (default: delete both sides — a per-side install is chosen at add time).
        const target = (await listClientMods()).find((m) => m.id === body.id)
        await removeClientMod(body.id)
        let cascadedServer: string[] = []
        if (target && (target.source === 'nexus' || target.source === 'steam') && target.sourceId) {
          cascadedServer = await removeServerModsBySource(target.source, target.sourceId)
        }
        // PalSchema submods aren't reachable via removeServerMod (ue4ss/pak only) and are
        // often untracked by source (e.g. CustomTechnologyTree), so the source cascade leaves
        // them behind. Also remove a server PalSchema submod matching this mod's name.
        const cascadedPalSchema = target?.name
          ? await removePalSchemaSubmodByName(target.name).catch(() => null)
          : null
        return NextResponse.json({ removed: body.id, cascadedServer, cascadedPalSchema })
      }
      case 'backfillWarnings': {
        const r = await backfillClientWarnings()
        return NextResponse.json(r)
      }
      // Refresh cached update info (nexus versions + steam timestamps), then return the mods with
      // a derived updateAvailable flag — the client-mod parallel to the server's update chips.
      case 'checkUpdates': {
        const updates = await checkClientModUpdates(body.force === true)
        const mods = (await listClientMods()).map((m) => ({ ...m, updateAvailable: clientModUpdateAvailable(m) }))
        return NextResponse.json({ mods, updates })
      }
      // Update one staged mod in place to the newest upstream build (keep + config-override kept).
      case 'update': {
        if (typeof body.id !== 'string') return NextResponse.json({ error: 'id required' }, { status: 400 })
        const mod = await updateClientMod(body.id)
        return NextResponse.json({ mod, note: `Updated ${mod.name}${mod.version ? ` to ${mod.version}` : ''}.` })
      }
      // ── Per-mod config editing (shipped into the loadout) ──────────────────
      case 'configList': {
        if (typeof body.id !== 'string') return NextResponse.json({ error: 'id required' }, { status: 400 })
        const configs = await listClientModConfigs(body.id)
        return NextResponse.json({ configs })
      }
      case 'configSave': {
        if (typeof body.id !== 'string' || typeof body.cfg !== 'string' || typeof body.content !== 'string') {
          return NextResponse.json({ error: 'id, cfg and content required' }, { status: 400 })
        }
        await saveClientModConfig(body.id, body.cfg, body.content)
        return NextResponse.json({ saved: body.cfg })
      }
      case 'configClear': {
        if (typeof body.id !== 'string' || typeof body.cfg !== 'string') {
          return NextResponse.json({ error: 'id and cfg required' }, { status: 400 })
        }
        await clearClientModConfig(body.id, body.cfg)
        return NextResponse.json({ cleared: body.cfg })
      }
      case 'addNexus': {
        const mod = await addClientModFromNexus(String(body.url ?? ''), typeof body.fileId === 'number' ? body.fileId : undefined)
        return NextResponse.json({ mod, note: `Staged ${mod.name} for clients.` })
      }
      case 'addSteam': {
        const mod = await addClientModFromSteam(String(body.url ?? ''))
        return NextResponse.json({ mod, note: `Staged ${mod.name} for clients.` })
      }
      case 'bulk': {
        const urls = Array.isArray(body.urls) ? body.urls.map((u) => String(u)) : []
        if (!urls.length) return NextResponse.json({ error: 'Paste at least one Nexus or Steam URL' }, { status: 400 })
        if (urls.length > 50) return NextResponse.json({ error: 'Too many at once (limit 50)' }, { status: 400 })
        const results = await addClientModsBulk(urls)
        const staged = results.filter((r) => r.ok).length
        return NextResponse.json({
          results,
          staged,
          note: staged ? `Staged ${staged} client mod(s).` : 'Nothing staged.',
        })
      }
      // Convenience for the catalog suggestion rows — route by the entry's source.
      case 'addCatalog': {
        const source = body.source === 'workshop' ? 'workshop' : 'nexus'
        const id = String(body.id ?? '')
        if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
        const mod =
          source === 'workshop'
            ? await addClientModFromSteam(id)
            : await addClientModFromNexus(`https://www.nexusmods.com/palworld/mods/${id}`)
        return NextResponse.json({ mod, note: `Staged ${mod.name} for clients.` })
      }
      default:
        return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
    }
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Client-mod action failed' }, { status: 500 })
  }
}
