import { NextRequest, NextResponse } from 'next/server'
import AdmZip from 'adm-zip'
import { isFomodArchive, FOMOD_MESSAGE } from '@/lib/archive'
import { classifyPassword, tierForClass } from '@/lib/access-tier'
import { clientIp, isLockedOut, recordFailure } from '@/lib/rate-limit'
import { DEMO_MODE } from '@/lib/demo-mode'
import { PALWORLD_PROXY_HEADERS } from '@/lib/palworld'
import { runWithInstance } from '@/lib/instances'
import { readScan, deleteScan } from '@/lib/mod-scan-store'
import {
  detectModKind,
  archiveHasPalSchemaData,
  installPakArchive,
  installUe4ssModArchive,
} from '@/lib/game-mods'
import { installPalSchemaSubmod } from '@/lib/palschema'
import { addClientModUpload } from '@/lib/client-mods'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// PATCH (not upstream): the unified uploader's commit step. Given a scan token and the
// confirmed target(s), install the stashed archive to the live SERVER and/or stage it into
// the CLIENT loadout — reusing the exact same lib installers the individual panels use, so
// there's no second install code path. See app/api/game-mods/scan/route.ts.
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

type TargetResult = { ok: boolean; detail?: string; error?: string }

export async function POST(request: NextRequest) {
  return runWithInstance(request.headers.get(PALWORLD_PROXY_HEADERS.instance), () => _POST(request))
}

async function _POST(request: NextRequest) {
  const g = gate(request)
  if (g !== 'ok') return g

  let body: { token?: string; server?: boolean; client?: boolean; modName?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Malformed request' }, { status: 400 })
  }
  const token = String(body.token ?? '')
  const wantServer = body.server === true
  const wantClient = body.client === true
  if (!token) return NextResponse.json({ error: 'Missing scan token' }, { status: 400 })
  if (!wantServer && !wantClient) return NextResponse.json({ error: 'Pick at least one target (server and/or client)' }, { status: 400 })

  const scan = await readScan(token)
  if (!scan) return NextResponse.json({ error: 'Scan expired — re-scan the mod and try again' }, { status: 410 })
  const { buffer, meta } = scan
  const name = (body.modName && body.modName.trim()) || meta.analysis.modName || meta.nameHint

  if (DEMO_MODE) {
    await deleteScan(token)
    return NextResponse.json({ dryRun: true, server: wantServer ? { ok: true } : null, client: wantClient ? { ok: true } : null })
  }

  let server: TargetResult | null = null
  let client: TargetResult | null = null

  // ── Server: install into the live game dirs via the shared installers ────────
  if (wantServer) {
    try {
      if (isFomodArchive(buffer)) throw new Error(FOMOD_MESSAGE)
      const kind = detectModKind(buffer)
      if (kind === 'palschema') {
        const r = await installPalSchemaSubmod(buffer, false, name)
        server = { ok: true, detail: `PalSchema: ${r.name ?? name}` }
      } else if (kind === 'pak') {
        const paks = await installPakArchive(buffer)
        server = { ok: true, detail: `Installed pak(s): ${paks.join(', ')}` }
      } else if (kind === 'ue4ss') {
        const r = await installUe4ssModArchive(buffer, name)
        // Combined Lua+PalSchema mod: also install the PalSchema half (best-effort).
        if (archiveHasPalSchemaData(buffer)) await installPalSchemaSubmod(buffer, false, name).catch(() => {})
        server = { ok: true, detail: `Installed: ${r.name}${r.pakFiles.length ? ` (+${r.pakFiles.length} pak)` : ''}` }
      } else {
        throw new Error('Could not detect a UE4SS/pak/PalSchema mod in this archive')
      }
    } catch (e) {
      server = { ok: false, error: e instanceof Error ? e.message : 'Server install failed' }
    }
  }

  // ── Client: stage into the loadout store (never touches server dirs) ─────────
  if (wantClient) {
    try {
      if (meta.isPak && meta.pakName) {
        // Unwrap the bare pak from its one-entry stash zip and stage it as a .pak.
        const entry = new AdmZip(buffer).getEntries().find((e) => !e.isDirectory)
        if (!entry) throw new Error('Stashed pak is unreadable')
        const rec = await addClientModUpload(meta.pakName, entry.getData())
        client = { ok: true, detail: `Staged: ${rec.name}${rec.warn ? ` — ${rec.warn}` : ''}` }
      } else {
        const rec = await addClientModUpload(`${name}.zip`, buffer)
        client = { ok: true, detail: `Staged: ${rec.name}${rec.warn ? ` — ${rec.warn}` : ''}` }
      }
    } catch (e) {
      client = { ok: false, error: e instanceof Error ? e.message : 'Client staging failed' }
    }
  }

  // Keep the stash if a requested target failed, so the UI can retry just that one
  // without re-uploading; drop it once everything requested has succeeded.
  const allOk = (!wantServer || server?.ok) && (!wantClient || client?.ok)
  if (allOk) await deleteScan(token)

  return NextResponse.json({ ok: allOk, server, client })
}
