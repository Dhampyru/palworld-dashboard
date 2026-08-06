import { NextRequest, NextResponse } from 'next/server'
import { classifyPassword, tierForClass } from '@/lib/access-tier'
import { clientIp, isLockedOut, recordFailure } from '@/lib/rate-limit'
import { DEMO_MODE } from '@/lib/demo-mode'
import { demoWorlds, demoBackups, demoPlayerSaves, DEMO_WORLD_ID } from '@/lib/demo'
import { PALWORLD_PROXY_HEADERS } from '@/lib/palworld'
import { runWithInstance } from '@/lib/instances'
import { getRconConfig, runRcon } from '@/lib/rcon-exec'
import {
  createBackup,
  createWorld,
  deleteBackup,
  deletePlayerFromWorld,
  deletePlayerSave,
  deleteWorld,
  editPlayerBasics,
  type PlayerEdit,
  isGameServerUp,
  backupDashboardData,
  listBackups,
  listDashboardDataBackups,
  listPlayerSaves,
  getSavesDisk,
  listWorlds,
  readActiveWorldId,
  resolveBackupPath,
  resolvePlayerSavePath,
  restoreBackup,
  restoreDashboardData,
  setActiveWorld,
  worldExists,
} from '@/lib/saves'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// PATCH (not upstream): Saves & backups route (roadmap item 5, docs/specs/
// saves-backups-spec.md). Admin-tier only -- listing (and, later,
// backup/restore/switch) touches real save data. This is the read-only GET;
// mutating actions land in a POST once the spec's restore design is signed off.

function presentedPassword(request: NextRequest) {
  return request.headers.get(PALWORLD_PROXY_HEADERS.adminPassword) ?? ''
}

function requireAdmin(request: NextRequest): NextResponse | null {
  const passwordClass = classifyPassword(presentedPassword(request))
  if (passwordClass === 'unknown') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (tierForClass(passwordClass) !== 'admin') {
    return NextResponse.json({ error: 'Forbidden: saves are admin-only' }, { status: 403 })
  }
  return null
}

export async function GET(request: NextRequest) {
  return runWithInstance(request.headers.get(PALWORLD_PROXY_HEADERS.instance), () => _GET(request))
}
async function _GET(request: NextRequest) {
  const denied = requireAdmin(request)
  if (denied) return denied

  if (DEMO_MODE) {
    return NextResponse.json({ worlds: demoWorlds, backups: demoBackups, playerSaves: demoPlayerSaves, activeWorldId: DEMO_WORLD_ID, demo: true })
  }

  const activeWorldId = await readActiveWorldId()
  const [worlds, backups, playerSaves, disk, dashboardBackups] = await Promise.all([
    listWorlds(activeWorldId),
    listBackups(),
    activeWorldId ? listPlayerSaves(activeWorldId) : Promise.resolve([]),
    getSavesDisk(),
    listDashboardDataBackups(),
  ])
  return NextResponse.json({ worlds, backups, playerSaves, activeWorldId, disk, dashboardBackups })
}

// Mutating actions (spec §2/§3). Admin-tier only; rate-limited like the other
// privileged routes. Deliberately does NOT orchestrate lifecycle: switch writes
// the ini and asks the operator to restart; restore refuses while the server is
// up rather than stopping it. Keeps the fragile stop/start choreography out of
// the save path.
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

  let body: {
    action?: unknown
    file?: unknown
    worldId?: unknown
    playerUid?: unknown
    edit?: unknown
  }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return NextResponse.json({ error: 'Malformed request body' }, { status: 400 })
  }

  const action = body.action
  if (
    action !== 'backup' &&
    action !== 'delete' &&
    action !== 'switch' &&
    action !== 'newWorld' &&
    action !== 'deleteWorld' &&
    action !== 'restore' &&
    action !== 'restoreDashboardData' &&
    action !== 'backupDashboardData' &&
    action !== 'deletePlayerSave' &&
    action !== 'resetPlayer' &&
    action !== 'editPlayer'
  ) {
    return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
  }

  if (DEMO_MODE) {
    return NextResponse.json({ success: true, dryRun: true, action })
  }

  try {
    if (action === 'backup') {
      // Best-effort RCON Save to flush to disk first (spec §2). A save failure
      // is non-fatal -- the tar still captures the current on-disk state.
      const rcon = getRconConfig()
      if (rcon) {
        try {
          await runRcon(rcon, 'Save')
        } catch {
          /* proceed with whatever is on disk */
        }
      }
      const backup = await createBackup()
      return NextResponse.json({ success: true, backup, note: 'Backup created.' })
    }

    if (action === 'backupDashboardData') {
      // Force an immediate snapshot of /app/data (overrides, links, schedules, groups)
      // to the game-backups volume — bypasses the scheduler's ~daily freshness gate so a
      // config change is captured now rather than at the next tick.
      const r = await backupDashboardData({ force: true, keep: 14 })
      return NextResponse.json({ success: true, file: r.file, note: `Backed up dashboard config to ${r.file}.` })
    }

    if (action === 'restoreDashboardData') {
      // Restore the dashboard's OWN config (/app/data) from a snapshot. No server-down
      // guard — this is dashboard config, not the live world. Takes a pre-restore
      // safety snapshot first. Most restored settings apply immediately (config
      // discovery, links); schedules re-read on the next tick.
      const file = typeof body.file === 'string' ? body.file : ''
      if (!file) return NextResponse.json({ error: 'file required' }, { status: 400 })
      const r = await restoreDashboardData(file)
      return NextResponse.json({
        success: true,
        ...r,
        note: `Restored ${r.restored.length} config file(s) from ${file}. A pre-restore snapshot was saved.`,
      })
    }

    if (action === 'delete') {
      const full = resolveBackupPath(body.file)
      if (!full) return NextResponse.json({ error: 'Invalid backup file' }, { status: 400 })
      await deleteBackup(full)
      return NextResponse.json({ success: true, note: 'Backup deleted.' })
    }

    if (action === 'switch') {
      if (!(await worldExists(body.worldId))) {
        return NextResponse.json({ error: 'Unknown world' }, { status: 400 })
      }
      await setActiveWorld(body.worldId as string)
      return NextResponse.json({
        success: true,
        note: 'Active world set — restart the server to load it.',
      })
    }

    if (action === 'newWorld') {
      // Point the server at a brand-new world id; the game generates the empty
      // world on next start. Non-destructive: the current world is kept and stays
      // switchable, so this needs no server-down and no backup.
      const worldId = await createWorld()
      return NextResponse.json({
        success: true,
        worldId,
        note: 'New world created and set active — restart the server to generate it. Your previous world is kept and can be switched back to under Worlds.',
      })
    }

    if (action === 'deleteWorld') {
      if (!(await worldExists(body.worldId))) {
        return NextResponse.json({ error: 'Unknown world' }, { status: 400 })
      }
      // Never delete the world the server is set to load — switch/new-world first.
      const activeWorldId = await readActiveWorldId()
      if (body.worldId === activeWorldId) {
        return NextResponse.json(
          { error: 'This is the active world. Switch to (or create) another world first, then delete this one.' },
          { status: 409 },
        )
      }
      // Snapshot everything first so a mistaken delete is reversible via restore.
      await createBackup('preworlddelete')
      await deleteWorld(body.worldId as string)
      return NextResponse.json({ success: true, note: 'World deleted. A "preworlddelete" backup was taken first.' })
    }

    if (action === 'deletePlayerSave') {
      // Default to the active world when the client doesn't pin one.
      const worldId = typeof body.worldId === 'string' ? body.worldId : await readActiveWorldId()
      const full = resolvePlayerSavePath(worldId, body.playerUid)
      if (!full) return NextResponse.json({ error: 'Invalid world or player id' }, { status: 400 })
      await deletePlayerSave(full)
      // NB: this only removes the FILE. The game regenerates it from Level.sav on
      // next join, so it does NOT force recreation -- use resetPlayer for that.
      return NextResponse.json({ success: true, note: 'Player save file removed.' })
    }

    if (action === 'resetPlayer') {
      const worldId = typeof body.worldId === 'string' ? body.worldId : await readActiveWorldId()
      const full = resolvePlayerSavePath(worldId, body.playerUid)
      if (!full || !worldId) {
        return NextResponse.json({ error: 'Invalid world or player id' }, { status: 400 })
      }
      // World-save WRITE -- refuse while the game is serving (would corrupt).
      if (await isGameServerUp()) {
        return NextResponse.json(
          { error: 'The server is still running. Stop it before resetting a player.' },
          { status: 409 },
        )
      }
      // Snapshot the world first, so a mistaken delete is reversible via restore.
      const preDelete = await createBackup('predelete')
      const result = await deletePlayerFromWorld(worldId, body.playerUid as string)
      if (!result.deleted) {
        const guildLabel = result.guild_named ? `the guild “${result.guild_name}”` : 'their guild'
        const members = result.member_count ? ` (${result.member_count} members)` : ''
        return NextResponse.json({
          success: false,
          deleted: false,
          reason: result.reason ?? 'refused',
          nickname: result.nickname,
          guildName: result.guild_name,
          guildNamed: result.guild_named,
          memberCount: result.member_count,
          preBackup: preDelete.file,
          note:
            result.reason === 'guild_admin'
              ? `${result.nickname || 'This player'} is the admin of ${guildLabel}${members} — remove or transfer that guild before deleting them. Nothing was changed.`
              : 'Could not delete this player. Nothing was changed.',
        })
      }
      // Character is gone from Level.sav; drop their now-orphan .sav too.
      await deletePlayerSave(full)
      return NextResponse.json({
        success: true,
        deleted: true,
        nickname: result.nickname,
        guildDeleted: result.guild_deleted,
        preBackup: preDelete.file,
        note: `${result.nickname || 'Player'} deleted from the world${
          result.guild_deleted ? ' (their one-person guild was removed too)' : ''
        } — they'll create a new character on next join. Start the server to apply.`,
      })
    }

    if (action === 'editPlayer') {
      const worldId = typeof body.worldId === 'string' ? body.worldId : await readActiveWorldId()
      const full = resolvePlayerSavePath(worldId, body.playerUid)
      if (!full || !worldId) {
        return NextResponse.json({ error: 'Invalid world or player id' }, { status: 400 })
      }
      if (!body.edit || typeof body.edit !== 'object') {
        return NextResponse.json({ error: 'Missing edit payload' }, { status: 400 })
      }
      // Level.sav WRITE -- refuse while the game is serving (would corrupt).
      if (await isGameServerUp()) {
        return NextResponse.json(
          { error: 'The server is still running. Stop it before editing a player.' },
          { status: 409 },
        )
      }
      // Snapshot the world first, so a mistaken edit is reversible via restore.
      const preEdit = await createBackup('preedit')
      const result = await editPlayerBasics(worldId, body.playerUid as string, body.edit as PlayerEdit)
      return NextResponse.json({
        success: true,
        ...result,
        preBackup: preEdit.file,
        note: `${result.nickname || 'Player'} updated — start the server to load the changes.`,
      })
    }

    // restore
    const full = resolveBackupPath(body.file)
    if (!full) return NextResponse.json({ error: 'Invalid backup file' }, { status: 400 })
    if (await isGameServerUp()) {
      return NextResponse.json(
        { error: 'The server is still running. Stop it before restoring a backup.' },
        { status: 409 },
      )
    }
    // Snapshot the current world first, so even a mistaken restore is reversible.
    const preRestore = await createBackup('prerestore')
    await restoreBackup(full)
    return NextResponse.json({
      success: true,
      preRestoreBackup: preRestore.file,
      note: 'Restored — start the server to load it.',
    })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Operation failed' },
      { status: 500 },
    )
  }
}
