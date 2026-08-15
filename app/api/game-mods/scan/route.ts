import { NextRequest, NextResponse } from 'next/server'
import AdmZip from 'adm-zip'
import { normalizeArchiveToZip } from '@/lib/archive'
import { classifyPassword, tierForClass } from '@/lib/access-tier'
import { clientIp, isLockedOut, recordFailure } from '@/lib/rate-limit'
import { PALWORLD_PROXY_HEADERS } from '@/lib/palworld'
import { runWithInstance } from '@/lib/instances'
import { analyzeModArchive, analyzeDescription, applyDescriptionHint, type ModAnalysis } from '@/lib/mod-targeting'
import { stashScan, deleteScan, purgeAllScans } from '@/lib/mod-scan-store'
import { parseNexusModId, getModInfo, getModFiles, downloadNexusFile, type NexusFile } from '@/lib/nexus'
import { parseWorkshopId, fetchWorkshopDetails, downloadWorkshopItem, readWorkshopInstallTypes, purgeOrphanWorkshopContent } from '@/lib/steam'
import { SAFE_PAK_FILENAME, readSteamMods } from '@/lib/game-mods'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// PATCH (not upstream): the unified mod uploader's "scan first" step. Parses an uploaded
// archive (or a Nexus mod page's description) to decide WHERE the mod belongs — server,
// client loadout, or both — WITHOUT installing anything. The follow-up /commit installs
// from the stash to whichever target(s) the admin confirms. See lib/mod-targeting.ts.
const MAX_UPLOAD_BYTES = 300 * 1024 * 1024

// Admin gate — mirrors app/api/game-mods/install/route.ts (installing/inspecting mods is
// admin-only). Returns 'ok' or a ready-to-return error response.
function gate(request: NextRequest): 'ok' | NextResponse {
  const ip = clientIp(request)
  if (isLockedOut(ip)) return NextResponse.json({ error: 'Too many attempts. Try again later.' }, { status: 429 })
  const pc = classifyPassword(request.headers.get(PALWORLD_PROXY_HEADERS.adminPassword) ?? '')
  if (pc === 'unknown') {
    recordFailure(ip)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (tierForClass(pc) !== 'admin') return NextResponse.json({ error: 'Forbidden: mod install is admin-only' }, { status: 403 })
  return 'ok'
}

export async function POST(request: NextRequest) {
  return runWithInstance(request.headers.get(PALWORLD_PROXY_HEADERS.instance), () => _POST(request))
}

async function _POST(request: NextRequest) {
  const g = gate(request)
  if (g !== 'ok') return g

  const contentType = request.headers.get('content-type') ?? ''

  // ── Nexus / Steam URL: analyze the mod PAGE (description keywords), no download ──
  if (contentType.includes('application/json')) {
    let body: { url?: string; fileId?: number }
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Malformed request' }, { status: 400 })
    }
    const url = String(body.url ?? '')

    // Steam Workshop: DEEP scan — download to the SteamCMD cache + read Info.json's
    // InstallRule for the real kind, then fold the page description on top. The cache is
    // shared with installs, so a scanned-but-rejected item is swept by
    // purgeOrphanWorkshopContent (here on each scan; immediately on reject via DELETE).
    // SteamCMD is incremental, so the install's re-fetch is a fast cache-validate.
    if (/steamcommunity\.com/i.test(url)) {
      const itemId = parseWorkshopId(url)
      if (!itemId) return NextResponse.json({ error: 'Paste a valid Steam Workshop URL or id' }, { status: 400 })
      const details = await fetchWorkshopDetails(itemId)
      const hint = analyzeDescription(`${details?.title ?? ''} ${details?.description ?? ''}`)

      let base: ModAnalysis | null = null
      try {
        const { contentDir, modName } = await downloadWorkshopItem(itemId)
        const types = await readWorkshopInstallTypes(contentDir)
        const clientKinds = types.some((t) => t === 'Lua' || t === 'Paks' || t === 'LogicMods')
        const serverSide = types.some((t) => t === 'PalSchema' || t === 'UE4SS')
        base = {
          kind: types.includes('PalSchema') ? 'palschema' : types.includes('Paks') || types.includes('LogicMods') ? 'pak' : types.includes('Lua') ? 'ue4ss' : null,
          target: serverSide && !clientKinds ? 'server' : 'both',
          serverInstallable: true,
          clientInstallable: clientKinds,
          signals: { hasLua: types.includes('Lua'), hasPalSchemaData: types.includes('PalSchema'), hasPak: types.includes('Paks'), hasLogicMods: types.includes('LogicMods'), hasConfigMenu: false, isFomod: false, hasEngineIni: false },
          modName: modName || details?.title || `Workshop item ${itemId}`,
          reason: types.length ? `Steam Workshop item (Info.json: ${types.join(', ')}).` : 'Steam Workshop item — no Info.json install rules found.',
          warn: null,
        }
      } catch {
        base = null // download/session failed → description-only
      }
      if (!base) {
        base = {
          kind: null,
          target: hint.target ?? 'both',
          serverInstallable: true,
          clientInstallable: true,
          signals: { hasLua: false, hasPalSchemaData: false, hasPak: false, hasLogicMods: false, hasConfigMenu: false, isFomod: false, hasEngineIni: false },
          modName: details?.title || `Workshop item ${itemId}`,
          reason: 'Read from the Steam page; deep scan needs a connected Steam account. Defaulting to Both — adjust if needed.',
          warn: null,
        }
      }
      const analysis = applyDescriptionHint(base, hint)
      // Self-clean: sweep orphaned scan-downloads (not installed) older than 1h.
      try {
        const installed = new Set(Object.values(await readSteamMods()).map((l) => l.itemId).filter(Boolean))
        await purgeOrphanWorkshopContent(installed, { olderThanMs: 60 * 60 * 1000 })
      } catch {
        /* best-effort */
      }
      return NextResponse.json({ source: 'steam', url, itemId, modName: analysis.modName, analysis })
    }

    const modId = parseNexusModId(url)
    if (!modId) return NextResponse.json({ error: 'Paste a valid Nexus mod URL or id' }, { status: 400 })
    const [info, files] = await Promise.all([getModInfo(modId), getModFiles(modId).catch(() => [] as NexusFile[])])
    if (!info) return NextResponse.json({ error: 'Could not read this mod from Nexus (is the API key set?)' }, { status: 400 })
    // Resolve the file to install. Default = newest MAIN (else newest of any); if the caller
    // picked a specific version via the dropdown, honor that fileId. Expose the full file
    // list so the UI can offer the version picker (newest first).
    const main = files.filter((f) => (f.category ?? '').toUpperCase() === 'MAIN')
    const pool = main.length ? main : files
    const autoFileId = pool.length ? pool[pool.length - 1].fileId : null
    const requestedFileId = typeof body.fileId === 'number' ? body.fileId : null
    const fileId = requestedFileId && files.some((f) => f.fileId === requestedFileId) ? requestedFileId : autoFileId
    const fileOptions = [...files]
      .sort((a, b) => b.fileId - a.fileId)
      .map((f) => ({ fileId: f.fileId, name: f.displayName || f.name, version: f.version ?? null, category: f.category ?? null }))

    const hint = analyzeDescription(`${info.name ?? ''} ${info.summary ?? ''} ${info.description ?? ''}`)

    // Deep scan: download the main file (Premium) and read its ACTUAL structure/type, then
    // fold the description on top (the author's explicit instructions win). The buffer is
    // transient — analyzed in memory and discarded — so a scanned-but-rejected Nexus mod
    // leaves NOTHING to purge. Free-tier (download throws) falls back to description-only.
    let base: ModAnalysis | null = null
    if (fileId) {
      try {
        const zip = await normalizeArchiveToZip(await downloadNexusFile(modId, fileId))
        base = analyzeModArchive(zip, { nameHint: info.name, description: `${info.summary ?? ''} ${info.description ?? ''}` })
      } catch {
        base = null // not Premium / download failed → description-only
      }
    }
    if (!base) {
      base = {
        kind: null,
        target: hint.target ?? 'both',
        serverInstallable: true,
        clientInstallable: true,
        signals: { hasLua: false, hasPalSchemaData: false, hasPak: false, hasLogicMods: false, hasConfigMenu: false, isFomod: false, hasEngineIni: false },
        modName: info.name,
        reason: hint.target
          ? 'From the Nexus mod page.'
          : 'Read from the Nexus page; contents confirmed on install (Premium enables the deep file scan). Defaulting to Both — adjust if needed.',
        warn: null,
      }
    }
    const analysis = applyDescriptionHint(base, hint)
    return NextResponse.json({ source: 'nexus', url: info.url, modId, fileId, files: fileOptions, modName: analysis.modName || info.name, analysis })
  }

  // ── File upload: full content analysis + stash for commit ───────────────────
  let formData: FormData
  try {
    formData = await request.formData()
  } catch {
    return NextResponse.json({ error: 'Malformed upload' }, { status: 400 })
  }
  const file = formData.get('file')
  if (!(file instanceof File)) return NextResponse.json({ error: 'Expected a "file" (or a Nexus URL as JSON)' }, { status: 400 })
  if (file.size === 0) return NextResponse.json({ error: 'Uploaded file is empty' }, { status: 400 })
  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      { error: `File too large (${Math.round(file.size / 1024 / 1024)}MB — limit is ${MAX_UPLOAD_BYTES / 1024 / 1024}MB)` },
      { status: 413 },
    )
  }

  const raw = Buffer.from(await file.arrayBuffer())
  const isPak = /\.pak$/i.test(file.name)

  // Normalize to a zip so analysis, stash, and commit are uniform. A bare .pak is wrapped
  // in a one-entry zip (safe name) so detectModKind sees a pak and installPakArchive works.
  let zip: Buffer
  let pakName: string | null = null
  if (isPak) {
    pakName = file.name.replace(/[^A-Za-z0-9_.-]/g, '_')
    if (!SAFE_PAK_FILENAME.test(pakName)) return NextResponse.json({ error: 'Invalid .pak filename' }, { status: 400 })
    const z = new AdmZip()
    z.addFile(pakName, raw)
    zip = z.toBuffer()
  } else {
    try {
      zip = await normalizeArchiveToZip(raw)
    } catch {
      return NextResponse.json({ error: "Couldn't open this as a .zip/.rar/.7z archive (or upload a bare .pak)" }, { status: 400 })
    }
  }

  const analysis = analyzeModArchive(zip, { nameHint: file.name })
  const token = await stashScan(zip, { nameHint: file.name, analysis, isPak, pakName })
  return NextResponse.json({ source: 'upload', token, modName: analysis.modName, analysis })
}

// Reject cleanup: DELETE with {token} drops a file/Nexus stash immediately; {steamItemId}
// purges a just-scanned Steam cache dir IF it isn't installed (never touches an installed
// mod's cache). Belt-and-suspenders on top of the scan-time + commit-time sweeps.
export async function DELETE(request: NextRequest) {
  return runWithInstance(request.headers.get(PALWORLD_PROXY_HEADERS.instance), () => _DELETE(request))
}
async function _DELETE(request: NextRequest) {
  const g = gate(request)
  if (g !== 'ok') return g
  let body: { token?: string; steamItemId?: string; all?: boolean }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Malformed request' }, { status: 400 })
  }
  // Manual "Clear mod download cache": drop every pending stash + all orphaned Steam cache
  // dirs (anything not currently installed). Installed mods' caches are never touched.
  if (body.all) {
    const stashCleared = await purgeAllScans()
    const installed = new Set(Object.values(await readSteamMods()).map((l) => l.itemId).filter(Boolean))
    const workshopRemoved = await purgeOrphanWorkshopContent(installed)
    return NextResponse.json({ ok: true, stashCleared, workshopRemoved: workshopRemoved.length })
  }
  if (body.token) {
    await deleteScan(body.token)
    return NextResponse.json({ ok: true })
  }
  if (body.steamItemId) {
    const installed = new Set(Object.values(await readSteamMods()).map((l) => l.itemId).filter(Boolean))
    const removed = await purgeOrphanWorkshopContent(installed, { only: String(body.steamItemId) })
    return NextResponse.json({ ok: true, removed })
  }
  return NextResponse.json({ error: 'Nothing to purge' }, { status: 400 })
}
