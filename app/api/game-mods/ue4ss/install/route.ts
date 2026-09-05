import { NextRequest, NextResponse } from 'next/server'
import { classifyPassword, tierForClass } from '@/lib/access-tier'
import { clientIp, isLockedOut, recordFailure } from '@/lib/rate-limit'
import { DEMO_MODE } from '@/lib/demo-mode'
import { PALWORLD_PROXY_HEADERS } from '@/lib/palworld'
import { runWithInstance } from '@/lib/instances'
import {
  clearStagedUe4ss,
  downloadUe4ssRelease,
  installUe4ssZip,
  listUe4ssBackups,
  readUe4ssStatus,
  recordStagedUe4ss,
  rollbackUe4ss,
  swapToProxy,
  swapToWorkshop,
  type Ue4ssSource,
} from '@/lib/game-mods'
import { isGameServerUp } from '@/lib/saves'
import { markUe4ssRolledBack, markUe4ssUpdateInstalled } from '@/lib/framework-updates'
import { readPalSchemaStatus } from '@/lib/palschema'

// Map a download source to the normalized Ue4ssSource + a friendly staged label,
// so the loader can show which build was just installed BEFORE the next boot.
const STAGED: Record<'official' | 'beta' | 'palschema', { source: Ue4ssSource; version: string }> = {
  official: { source: 'official', version: 'v3.0.1 (stable)' },
  beta: { source: 'beta', version: 'experimental-latest' },
  palschema: { source: 'experimental-palworld', version: 'PalSchema build' },
}

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// PATCH (not upstream): UE4SS install / swap / rollback (spec §2). This rewrites
// the injection layer, so it's admin-only AND refused while the game is running
// (a live swap corrupts the Wine session). Every install backs the current UE4SS
// up first; GET lists those backups for the rollback affordance.

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
    return NextResponse.json({ error: 'Forbidden: UE4SS control is admin-only' }, { status: 403 })
  }
  return null
}

export async function GET(request: NextRequest) {
  return runWithInstance(request.headers.get(PALWORLD_PROXY_HEADERS.instance), () => _GET(request))
}
async function _GET(request: NextRequest) {
  const denied = requireAdmin(request)
  if (denied) return denied
  return NextResponse.json({ backups: DEMO_MODE ? [] : await listUe4ssBackups() })
}

export async function POST(request: NextRequest) {
  return runWithInstance(request.headers.get(PALWORLD_PROXY_HEADERS.instance), () => _POST(request))
}
async function _POST(request: NextRequest) {
  const denied = requireAdmin(request)
  if (denied) return denied
  if (DEMO_MODE) {
    return NextResponse.json({ status: await readUe4ssStatus(), dryRun: true })
  }

  const contentType = request.headers.get('content-type') ?? ''
  try {
    // Rollback and download are JSON; upload is multipart.
    if (!contentType.includes('multipart/form-data')) {
      const body = (await request.json().catch(() => ({}))) as { action?: string; source?: string; backupFile?: string }

      if (body.action === 'rollback') {
        if (await isGameServerUp()) {
          return NextResponse.json({ error: 'Stop the server before rolling back UE4SS.' }, { status: 409 })
        }
        if (!body.backupFile) return NextResponse.json({ error: 'backupFile required' }, { status: 400 })
        // Capture the build we're leaving so the note can say what changed. The
        // SHA is the real identifier — the UE4SS version string is constant across
        // builds, so "rolled back to v3.0.1 Beta" alone tells the operator nothing.
        const preSha = (await readUe4ssStatus()).sha
        await rollbackUe4ss(body.backupFile)
        // The restored build isn't classified, so forget the staged marker and
        // let status fall back to the live banner after the next boot.
        await clearStagedUe4ss()
        // Rolling back means we're now on an OLDER build than the latest — re-flag the update check
        // so the card reflects that (instead of a stale "up to date" from a prior update).
        await markUe4ssRolledBack().catch(() => {})
        const rbStatus = await readUe4ssStatus()
        const restored = rbStatus.sha
          ? `UE4SS #${rbStatus.sha}${rbStatus.version ? ` (${rbStatus.version})` : ''}`
          : 'the backed-up UE4SS build'
        const fromClause = preSha && preSha !== rbStatus.sha ? ` — was on #${preSha}` : ''
        return NextResponse.json({
          status: rbStatus,
          note: `Rolled back to ${restored}${fromClause}. Restart the server to load it.`,
        })
      }

      if (body.action === 'download') {
        if (body.source !== 'official' && body.source !== 'beta' && body.source !== 'palschema') {
          return NextResponse.json({ error: 'source must be official, beta, or palschema' }, { status: 400 })
        }
        if (await isGameServerUp()) {
          return NextResponse.json({ error: 'Stop the server before swapping UE4SS.' }, { status: 409 })
        }
        // Capture what's installed BEFORE the swap: updating the same line (already on
        // experimental-palworld) must read as an update, not a first-time "step 1 of 2" switch.
        const preStatus = await readUe4ssStatus()
        // PalSchema is an ABI-locked C++ mod — the swap sets it aside (it isn't carried across), so
        // warn if it was installed: it must be reinstalled MATCHING the new UE4SS or the server
        // crash-loops (restoring the OLD PalSchema onto a new build is exactly what breaks).
        const palPre = await readPalSchemaStatus()
        // Coming from the Workshop layout: restore the proxy install first so the
        // community-build swap has a proxy baseline to back up + wipe.
        if (preStatus.regime === 'workshop') await swapToProxy()
        const buffer = await downloadUe4ssRelease(body.source)
        const result = await installUe4ssZip(buffer)
        const staged = STAGED[body.source]
        await recordStagedUe4ss(staged.source, staged.version)
        // Just installed the latest for this line → re-baseline the update check so the
        // "update available" badge clears instead of lingering after the update.
        await markUe4ssUpdateInstalled().catch(() => {})
        const preserved = result.preservedSettings ? ', settings preserved' : ''
        const alreadyPalschema = preStatus.source === 'experimental-palworld' || preStatus.stagedSource === 'experimental-palworld'
        // UPDATE (already on the experimental-palworld line) vs first-time SWITCH to it. Only the
        // first-time switch needs the "PalSchema itself isn't installed yet" step-2 nudge; an update
        // must NOT read as a PalSchema action (a real 2026-08-30 confusion).
        const baseNote =
          body.source === 'palschema'
            ? alreadyPalschema
              ? `Updated UE4SS to the latest experimental-palworld build (previous backed up${preserved}) — restart to load it.`
              : `Installed the PalSchema UE4SS build — step 1 of 2 (previous UE4SS backed up${preserved}). PalSchema itself is not installed yet; add it in the PalSchema section.`
            : `Installed the ${body.source} UE4SS build (previous UE4SS backed up${preserved}) — restart to load it.`
        // If PalSchema was installed, it was set aside by the swap (ABI-locked) — the operator MUST
        // reinstall a matching build before starting, or roll back, to avoid a crash-loop.
        const note = palPre.installed
          ? `${baseNote} NOTE: PalSchema was set aside (in the pre-swap backup) — it is version-locked to UE4SS, so reinstall a PalSchema matching THIS build before starting, or the server will crash-loop (roll back if unsure).`
          : baseNote
        return NextResponse.json({
          status: await readUe4ssStatus(),
          backup: result.backup,
          note,
        })
      }

      // PROXY -> WORKSHOP: migrate the whole stack into the official layout
      // (spec official-workshop-mods.md). No download — synthesizes packages from
      // the on-disk proxy install.
      if (body.action === 'swap-workshop') {
        if (await isGameServerUp()) {
          return NextResponse.json(
            { error: 'Stop the server before swapping to the Workshop layout.' },
            { status: 409 },
          )
        }
        if ((await readUe4ssStatus()).regime === 'workshop') {
          return NextResponse.json({ error: 'Already in the Workshop layout.' }, { status: 400 })
        }
        const { packages } = await swapToWorkshop()
        // Cue a restart in the UI; the underlying UE4SS is the experimental-palworld build.
        await recordStagedUe4ss('experimental-palworld', 'Workshop layout')
        await markUe4ssUpdateInstalled().catch(() => {})
        return NextResponse.json({
          status: await readUe4ssStatus(),
          note: `Migrated to the official Workshop layout (${packages.join(' + ')}) — restart the server to load it. The previous proxy install was backed up.`,
        })
      }

      return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
    }

    // Upload path (operator-supplied build, e.g. the experimental one).
    if (await isGameServerUp()) {
      return NextResponse.json({ error: 'Stop the server before swapping UE4SS.' }, { status: 409 })
    }
    // From the Workshop layout: restore the proxy baseline before the upload swap.
    if ((await readUe4ssStatus()).regime === 'workshop') await swapToProxy()
    const form = await request.formData()
    const file = form.get('file')
    if (!(file instanceof File)) return NextResponse.json({ error: 'No zip uploaded' }, { status: 400 })
    if (file.size > 200 * 1024 * 1024) {
      return NextResponse.json({ error: 'Zip too large (200MB cap)' }, { status: 400 })
    }
    const buffer = Buffer.from(await file.arrayBuffer())
    const result = await installUe4ssZip(buffer)
    // Operator-supplied build — unknown which release, so mark it 'unknown'.
    await recordStagedUe4ss('unknown', 'uploaded build')
    await markUe4ssUpdateInstalled().catch(() => {})
    return NextResponse.json({
      status: await readUe4ssStatus(),
      backup: result.backup,
      note: `Installed the uploaded build (previous UE4SS backed up${
        result.preservedSettings ? ', settings preserved' : ''
      }) — restart to load it.`,
    })
  } catch (error) {
    // On failure, best-effort: the current install is untouched unless extract
    // started; the pre-swap backup (if made) is the recovery path.
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'UE4SS install failed' },
      { status: 500 },
    )
  }
}
