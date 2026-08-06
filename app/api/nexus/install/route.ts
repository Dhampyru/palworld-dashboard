import { NextRequest, NextResponse } from 'next/server'
import { classifyPassword, tierForClass } from '@/lib/access-tier'
import { clientIp, isLockedOut, recordFailure } from '@/lib/rate-limit'
import { DEMO_MODE } from '@/lib/demo-mode'
import { PALWORLD_PROXY_HEADERS } from '@/lib/palworld'
import { runWithInstance } from '@/lib/instances'
import {
  downloadNexusFile,
  getLinkedModId,
  getModFiles,
  getModInfo,
  getNexusStatus,
  linkNexusMod,
  parseNexusModId,
  unlinkNexusMod,
  type NexusFile,
} from '@/lib/nexus'
import { archiveHasPalSchemaData, detectModKind, installPakArchive, installUe4ssModArchive, setModGroup } from '@/lib/game-mods'
import { installPalSchemaSubmod } from '@/lib/palschema'
import { normalizeArchiveToZip } from '@/lib/archive'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// PATCH (not upstream): install a mod directly from Nexus (docs/specs/nexus-
// integration.md, Phase 2). Admin + Premium (auto-download is Premium-gated).
// GET ?url= resolves the mod + its files for a picker; POST downloads the chosen
// file, auto-detects the kind, installs via the existing pipeline, and links the
// result for update-watching.
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
    return NextResponse.json({ error: 'Forbidden: Nexus install is admin-only' }, { status: 403 })
  }
  return null
}

export async function GET(request: NextRequest) {
  return runWithInstance(request.headers.get(PALWORLD_PROXY_HEADERS.instance), () => _GET(request))
}
async function _GET(request: NextRequest) {
  const denied = requireAdmin(request)
  if (denied) return denied
  const modId = parseNexusModId(request.nextUrl.searchParams.get('url') ?? '')
  if (!modId) return NextResponse.json({ error: 'Paste a valid Nexus mod URL' }, { status: 400 })
  const [info, files] = await Promise.all([getModInfo(modId), getModFiles(modId)])
  if (!info) return NextResponse.json({ error: 'Could not read that mod from Nexus (key valid?)' }, { status: 400 })
  return NextResponse.json({ modId, name: info.name, latestVersion: info.version, author: info.author, files })
}

// Which file to pull when the caller didn't name one (the Update flow). Prefer a
// MAIN file, and among those the one matching the mod's headline version; else the
// newest MAIN, else the newest of any downloadable file. Paks embed no version so
// the version-match is best-effort — but MAIN is the right file to (re)install.
function pickUpdateFile(files: NexusFile[], latestVersion: string | null): NexusFile | null {
  if (!files.length) return null
  const main = files.filter((f) => (f.category ?? '').toUpperCase() === 'MAIN')
  const pool = main.length ? main : files
  if (latestVersion) {
    const match = pool.find((f) => f.version === latestVersion)
    if (match) return match
  }
  return pool[pool.length - 1]
}

// Download + install a specific Nexus file through the existing pipeline, then link
// the result for update-watching (baseline = the installed version). Shared by the
// direct install and the update flows. Returns the install summary + the assoc key.
async function installModFile(
  modId: number,
  fileId: number,
): Promise<{ kind: 'palschema' | 'pak' | 'ue4ss'; name: string; version: string | null; assocKey: string | null }> {
  const download = await downloadNexusFile(modId, fileId)
  // Nexus authors often ship .rar/.7z — normalize those to a zip so the rest of
  // the pipeline (detect + install) is format-agnostic. A corrupt/unreadable
  // archive throws here and surfaces as a plain "couldn't open" to the caller.
  let buffer: Buffer
  try {
    buffer = await normalizeArchiveToZip(download)
  } catch {
    throw new Error(
      "Couldn't open this download as an archive — it may be corrupt, password-protected, or an unsupported format. Try installing it via manual upload.",
    )
  }
  const kind = detectModKind(buffer)
  if (!kind) {
    throw new Error(
      "Couldn't identify this mod's type from its contents — install it via manual upload, choosing the right tab.",
    )
  }

  // Baseline = the version of the file we just installed. Mod name → a folder-name
  // hint so bare "guts at the root" Lua mods (no wrapper folder) can be named.
  const files = await getModFiles(modId)
  const version = files.find((f) => f.fileId === fileId)?.version ?? null
  const nameHint = ((await getModInfo(modId))?.name ?? '').replace(/[^A-Za-z0-9_-]/g, '') || undefined

  let assocKey: string | null = null
  let installedName = ''
  if (kind === 'palschema') {
    const r = await installPalSchemaSubmod(buffer)
    installedName = r.name
    if (r.pakFiles.length) assocKey = `pak:${r.pakFiles[0]}` // the client-facing row
  } else if (kind === 'pak') {
    const paks = await installPakArchive(buffer)
    installedName = paks.join(', ')
    assocKey = `pak:${paks[0]}`
  } else {
    const r = await installUe4ssModArchive(buffer, nameHint)
    installedName = r.name
    assocKey = `ue4ss:${r.name}` // the UE4SS mod row (its pak, if any, split to ~mods)
    // Hybrid: nest the split-out pak(s) under the UE4SS mod in the list.
    if (r.pakFiles.length) await setModGroup(assocKey, r.pakFiles.map((p) => `pak:${p}`))
    // Combined Lua + PalSchema mod: install the PalSchema half too (best-effort;
    // the Lua part is already in). An empty PalSchema placeholder is a no-op.
    if (archiveHasPalSchemaData(buffer)) {
      try {
        await installPalSchemaSubmod(buffer)
      } catch {
        /* Lua part installed; PalSchema half optional */
      }
    }
  }

  // Link it for update-watching (baseline = the installed version).
  if (assocKey) await linkNexusMod(assocKey, modId, version)
  return { kind, name: installedName, version, assocKey }
}

export async function POST(request: NextRequest) {
  return runWithInstance(request.headers.get(PALWORLD_PROXY_HEADERS.instance), () => _POST(request))
}
async function _POST(request: NextRequest) {
  const denied = requireAdmin(request)
  if (denied) return denied
  if (DEMO_MODE) return NextResponse.json({ dryRun: true })

  const status = await getNexusStatus()
  if (!(status.configured && status.valid)) {
    return NextResponse.json({ error: 'Connect a valid Nexus API key first.' }, { status: 400 })
  }
  if (!status.isPremium) {
    return NextResponse.json(
      { error: 'Auto-download needs a Nexus Premium account. Download the file yourself and use the upload.' },
      { status: 400 },
    )
  }

  let body: { url?: string; modId?: number; fileId?: number; action?: string; modKey?: string; urls?: string[] }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return NextResponse.json({ error: 'Malformed request body' }, { status: 400 })
  }

  try {
    // Bulk flow: install many mods from pasted URLs. Auto-picks the single MAIN
    // file per mod; anything ambiguous (multiple/zero MAIN files) is flagged for
    // the single-URL box rather than guessed. Sequential — each is a CDN download
    // + disk extract mutating shared files (mods.txt, ~mods); serial avoids races
    // and stays gentle on the rate limit. One bad URL never aborts the rest.
    if (body.action === 'bulk') {
      const inputs = Array.isArray(body.urls) ? body.urls.map((u) => String(u).trim()).filter(Boolean) : []
      if (!inputs.length) return NextResponse.json({ error: 'Paste at least one Nexus URL' }, { status: 400 })
      if (inputs.length > 50) return NextResponse.json({ error: 'Too many at once (limit 50)' }, { status: 400 })

      const results: {
        input: string
        ok: boolean
        name?: string
        version?: string | null
        kind?: string
        needsChoice?: boolean
        error?: string
      }[] = []
      for (const input of inputs) {
        const modId = parseNexusModId(input)
        if (!modId) {
          results.push({ input, ok: false, error: 'Not a valid Nexus mod URL or id' })
          continue
        }
        try {
          const [info, files] = await Promise.all([getModInfo(modId), getModFiles(modId)])
          if (!info) {
            results.push({ input, ok: false, error: 'Could not read that mod from Nexus' })
            continue
          }
          const mains = files.filter((f) => (f.category ?? '').toUpperCase() === 'MAIN')
          if (mains.length !== 1) {
            results.push({
              input,
              ok: false,
              name: info.name,
              needsChoice: true,
              error:
                mains.length === 0
                  ? files.length
                    ? 'No MAIN file — pick one in the single-URL box'
                    : 'No downloadable files'
                  : 'Multiple MAIN files — pick one in the single-URL box',
            })
            continue
          }
          const r = await installModFile(modId, mains[0].fileId)
          results.push({ input, ok: true, name: r.name, version: r.version, kind: r.kind })
        } catch (e) {
          results.push({ input, ok: false, error: e instanceof Error ? e.message : 'Install failed' })
        }
      }
      const installed = results.filter((r) => r.ok).length
      return NextResponse.json({
        results,
        installed,
        note: installed ? `Installed ${installed} mod(s) — restart the server to apply.` : 'Nothing installed.',
      })
    }

    // Update flow: reinstall a linked mod's latest file, keyed off the row's modKey.
    if (body.action === 'update') {
      const modKey = typeof body.modKey === 'string' ? body.modKey : ''
      if (!modKey) return NextResponse.json({ error: 'modKey required' }, { status: 400 })
      const linked = await getLinkedModId(modKey)
      if (!linked) return NextResponse.json({ error: "This mod isn't linked to Nexus." }, { status: 400 })
      const [info, files] = await Promise.all([getModInfo(linked.modId), getModFiles(linked.modId)])
      const file = pickUpdateFile(files, info?.version ?? null)
      if (!file) return NextResponse.json({ error: 'No downloadable file found on Nexus.' }, { status: 400 })

      const r = await installModFile(linked.modId, file.fileId)
      // A reinstall usually resolves to the same key; if a rename changed it, drop
      // the stale association so the row doesn't show a phantom link.
      if (r.assocKey && r.assocKey !== modKey) await unlinkNexusMod(modKey)
      return NextResponse.json({
        kind: r.kind,
        name: r.name,
        version: r.version,
        associated: r.assocKey,
        updated: true,
        note: `Updated ${r.name} to v${r.version ?? '?'} — restart the server to apply.`,
      })
    }

    // Direct install flow: caller named the file.
    const modId = typeof body.modId === 'number' ? body.modId : parseNexusModId(body.url ?? '')
    const fileId = typeof body.fileId === 'number' ? body.fileId : null
    if (!modId || !fileId) return NextResponse.json({ error: 'modId and fileId required' }, { status: 400 })

    const r = await installModFile(modId, fileId)
    return NextResponse.json({
      kind: r.kind,
      name: r.name,
      version: r.version,
      associated: r.assocKey,
      note: `Installed ${r.name} (${r.kind}) from Nexus — restart the server to apply.`,
    })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Nexus install failed' },
      { status: 500 },
    )
  }
}
