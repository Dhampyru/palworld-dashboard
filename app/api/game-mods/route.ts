import { NextRequest, NextResponse } from 'next/server'
import { readdir, readFile, writeFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { classifyPassword, tierForClass } from '@/lib/access-tier'
import { clientIp, isLockedOut, recordFailure } from '@/lib/rate-limit'
import { DEMO_MODE } from '@/lib/demo-mode'
import { PALWORLD_PROXY_HEADERS } from '@/lib/palworld'
import { runWithInstance } from '@/lib/instances'
import {
  pakModsDir,
  resolveUe4ssModsDir,
  serializeModsTxt,
  readModsTxt,
  readPalDefenderState,
  setPalDefenderEnabled,
  readModGroups,
  readSteamMods,
  removeServerMod,
} from '@/lib/game-mods'
import { modHasEditableConfig } from '@/lib/mod-config'
import { removeClientModsBySource } from '@/lib/client-mods'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// PATCH (not upstream): this route is the one place in the app that touches
// the filesystem directly rather than proxying the Palworld REST API — because
// mod state (what's installed, what's enabled) isn't exposed by that API at
// all. It only works if the game's data directory is bind-mounted into this
// container (see docker-compose.yml) at PALWORLD_GAME_DIR.
//
// Two mod kinds, two real mechanisms:
//  - UE4SS (Lua/DLL) mods: folders under Win64/Mods, toggled via a mods.txt
//    line ("FolderName : 1" / ": 0"). UE4SS itself owns this file's format.
//  - .pak mods: loose files. Palworld has no official per-pak toggle, so we
//    use the common community convention of a `~mods` subfolder under Paks —
//    only files placed there are ever touched; the base game's own paks
//    elsewhere in that directory are never listed or modified.
//
// See lib/game-mods.ts for shared paths/parsing, and
// app/api/game-mods/install/route.ts for the upload/install path.

interface ModEntry {
  id: string
  kind: 'ue4ss' | 'pak' | 'paldefender'
  name: string
  enabled: boolean
  hasConfig?: boolean // ue4ss: has an editable config file (drives the Config button)
}

// PalDefender as a built-in mod row: only when it's actually installed. Toggled
// via the d3d9 loader config (see lib/game-mods), not deletable here.
async function listPalDefender(): Promise<ModEntry[]> {
  const { installed, enabled } = await readPalDefenderState()
  if (!installed) return []
  return [{ id: 'paldefender:PalDefender', kind: 'paldefender', name: 'PalDefender', enabled }]
}

async function listUe4ssMods(): Promise<ModEntry[]> {
  const modsDir = await resolveUe4ssModsDir()
  if (!modsDir) return []

  let entries: string[] = []
  try {
    const dirents = await readdir(modsDir, { withFileTypes: true })
    entries = dirents.filter((d) => d.isDirectory()).map((d) => d.name)
  } catch {
    return []
  }

  const active = await readModsTxt(modsDir)

  const names = entries
    // 'shared' is UE4SS's own shared runtime folder, not a mod. 'PalSchema' IS a
    // UE4SS mod, but it's managed by its dedicated PalSchema section (which owns
    // remove-with-backup + sub-mod semantics) — surfacing it here too would be a
    // confusing duplicate with a toggle/remove that bypass that section.
    .filter((name) => name.toLowerCase() !== 'shared' && name.toLowerCase() !== 'palschema')
  // hasConfig gates the Mods-tab Config button so it never appears for a mod with
  // nothing editable. Discovery-only (readdir), so cheap per mod.
  return Promise.all(
    names.map(async (name) => ({
      id: `ue4ss:${name}`,
      kind: 'ue4ss' as const,
      name,
      enabled: active.get(name) ?? true, // present on disk, no explicit "0" → UE4SS treats as enabled
      hasConfig: await modHasEditableConfig(name),
    })),
  )
}

async function listPakMods(): Promise<ModEntry[]> {
  let dirents
  try {
    dirents = await readdir(pakModsDir(), { withFileTypes: true })
  } catch {
    return [] // ~mods folder doesn't exist — no pak mods installed via this convention
  }

  return dirents
    .filter((d) => d.isFile() && (d.name.endsWith('.pak') || d.name.endsWith('.pak.disabled')))
    .map((d) => {
      const disabled = d.name.endsWith('.pak.disabled')
      const name = disabled ? d.name.slice(0, -'.disabled'.length) : d.name
      return {
        id: `pak:${name}`,
        kind: 'pak' as const,
        name,
        enabled: !disabled,
      }
    })
}

function presentedPassword(request: NextRequest) {
  return request.headers.get(PALWORLD_PROXY_HEADERS.adminPassword) ?? ''
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
  // Read-only, informational — both tiers may view installed mods, matching
  // the existing GET players/info/metrics allowlist precedent.

  if (DEMO_MODE) {
    return NextResponse.json({
      mods: [
        { id: 'ue4ss:ExampleLuaMod', kind: 'ue4ss', name: 'ExampleLuaMod', enabled: true },
        { id: 'pak:ExampleAssetMod.pak', kind: 'pak', name: 'ExampleAssetMod.pak', enabled: false },
      ],
    })
  }

  try {
    const [ue4ss, pak, paldefender] = await Promise.all([
      listUe4ssMods(),
      listPakMods(),
      listPalDefender(),
    ])
    return NextResponse.json({
      mods: [...paldefender, ...ue4ss, ...pak],
      groups: await readModGroups(),
      steamLinks: await readSteamMods(),
    })
  } catch (error) {
    return NextResponse.json(
      { error: `Failed to read mods: ${error instanceof Error ? error.message : 'unknown error'}` },
      { status: 500 }
    )
  }
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
  // Toggling changes actual server behavior on next restart — admin-only,
  // matching the existing server-restart route's gating.
  if (tierForClass(passwordClass) !== 'admin') {
    return NextResponse.json({ error: 'Forbidden: toggling mods is admin-only' }, { status: 403 })
  }

  let id = ''
  let enabled = true
  try {
    const body = (await request.json()) as { id?: unknown; enabled?: unknown }
    if (typeof body.id === 'string') id = body.id
    if (typeof body.enabled === 'boolean') enabled = body.enabled
  } catch {
    return NextResponse.json({ error: 'Malformed request body' }, { status: 400 })
  }

  const [kind, ...rest] = id.split(':')
  const name = rest.join(':')
  if ((kind !== 'ue4ss' && kind !== 'pak' && kind !== 'paldefender') || !name) {
    return NextResponse.json({ error: 'Invalid mod id' }, { status: 400 })
  }

  if (DEMO_MODE) {
    return NextResponse.json({ success: true, id, enabled, dryRun: true })
  }

  try {
    if (kind === 'ue4ss') {
      const modsDir = await resolveUe4ssModsDir()
      if (!modsDir) throw new Error('UE4SS Mods directory not found')
      const modsTxtPath = join(modsDir, 'mods.txt')
      const active = await readModsTxt(modsDir)
      active.set(name, enabled)
      const tmp = `${modsTxtPath}.tmp`
      await writeFile(tmp, serializeModsTxt(active), 'utf8')
      await rename(tmp, modsTxtPath) // atomic swap — never leaves mods.txt half-written
    } else if (kind === 'paldefender') {
      await setPalDefenderEnabled(enabled) // edits the d3d9 loader's load_dlls
    } else {
      const activePath = join(pakModsDir(), name)
      const disabledPath = `${activePath}.disabled`
      if (enabled) {
        await rename(disabledPath, activePath)
      } else {
        await rename(activePath, disabledPath)
      }
    }
  } catch (error) {
    return NextResponse.json(
      { error: `Failed to toggle mod: ${error instanceof Error ? error.message : 'unknown error'}` },
      { status: 500 }
    )
  }

  return NextResponse.json({ success: true, id, enabled })
}

export async function DELETE(request: NextRequest) {
  return runWithInstance(request.headers.get(PALWORLD_PROXY_HEADERS.instance), () => _DELETE(request))
}
async function _DELETE(request: NextRequest) {
  const ip = clientIp(request)
  if (isLockedOut(ip)) {
    return NextResponse.json({ error: 'Too many attempts. Try again later.' }, { status: 429 })
  }
  const passwordClass = classifyPassword(presentedPassword(request))
  if (passwordClass === 'unknown') {
    recordFailure(ip)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  // Deletion is permanent and irreversible — admin-only, same bar as toggling.
  if (tierForClass(passwordClass) !== 'admin') {
    return NextResponse.json({ error: 'Forbidden: removing mods is admin-only' }, { status: 403 })
  }

  let id = ''
  try {
    const body = (await request.json()) as { id?: unknown }
    if (typeof body.id === 'string') id = body.id
  } catch {
    return NextResponse.json({ error: 'Malformed request body' }, { status: 400 })
  }

  const [kind, ...rest] = id.split(':')
  const name = rest.join(':')
  if ((kind !== 'ue4ss' && kind !== 'pak') || !name) {
    return NextResponse.json({ error: 'Invalid mod id' }, { status: 400 })
  }

  if (DEMO_MODE) {
    return NextResponse.json({ success: true, id, dryRun: true })
  }

  // removeServerMod deletes the folder/pak, its mods.txt entry, any GROUPED child pak files
  // (hybrid mods), and every tracking row (Nexus/Steam/group map) — no leftovers. It returns
  // the source ids so we can cascade to the paired CLIENT stage (default: delete both sides;
  // a per-side install is chosen at add-time via the target override).
  let cascadedClient: string[] = []
  try {
    const { nexusModId, steamItemId } = await removeServerMod(id)
    if (nexusModId != null) cascadedClient = await removeClientModsBySource('nexus', String(nexusModId))
    else if (steamItemId) cascadedClient = await removeClientModsBySource('steam', steamItemId)
  } catch (error) {
    return NextResponse.json(
      { error: `Failed to remove mod: ${error instanceof Error ? error.message : 'unknown error'}` },
      { status: 500 },
    )
  }

  return NextResponse.json({ success: true, id, cascadedClient })
}
