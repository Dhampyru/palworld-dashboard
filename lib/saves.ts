// PATCH (not upstream): Saves & backups (roadmap item 5, docs/specs/
// saves-backups-spec.md). This module is the READ-ONLY groundwork -- listing
// worlds and existing backup tarballs from the mounted game volume. The mutating
// operations (create backup, restore, switch active world) are specced but not
// built here; they belong in the route's POST once the design is signed off.

import { mkdir, readFile, readdir, rm, stat, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeConfigFileWithBackup } from '@/lib/config-write'
import { currentGameDir, currentRestConfig } from '@/lib/instances'
import { diskUsage, type DiskUsage } from '@/lib/disk'

const execFileP = promisify(execFile)

// Multi-instance (#7): resolved per active instance (runWithInstance in routes);
// `default` resolves to today's env value.
const gameDir = () => currentGameDir()
// Parent of SaveGames -- the `tar -C` root, matching scripts/backup.sh.
const savedDir = () => join(gameDir(), 'Pal', 'Saved')

// Worlds live under SaveGames/0/<WORLD_ID>/; backups are tarballs the game
// container's scripts/backup.sh writes; the active world id is a line in
// GameUserSettings.ini. All on the RW-mounted game volume (spec §1).
const saveGamesDir = () => join(gameDir(), 'Pal', 'Saved', 'SaveGames', '0')
const backupsDir = () => join(gameDir(), 'backups')
const gameUserSettingsPath = () => join(gameDir(), 'Pal', 'Saved', 'Config', 'WindowsServer', 'GameUserSettings.ini')

export type WorldInfo = {
  id: string
  active: boolean
  sizeBytes: number
  modifiedAt: string | null
  playerCount: number
}

export type BackupInfo = {
  file: string
  sizeBytes: number
  modifiedAt: string | null
}

// The game's own auto-backup dir sits alongside the worlds under SaveGames/0 --
// it is NOT a world and must be excluded from the world list.
const NON_WORLD_DIRS = new Set(['backup'])

// Only files matching backup.sh's naming are treated as backups (spec §1).
const BACKUP_FILE_RE = /^palworld-save-.*\.tar\.gz$/

// Active world = DedicatedServerName in GameUserSettings.ini. A missing/
// unreadable file is a valid state (returns null), not an error.
export async function readActiveWorldId(): Promise<string | null> {
  try {
    const raw = await readFile(gameUserSettingsPath(), 'utf8')
    const match = raw.match(/^DedicatedServerName=(.+)$/m)
    return match ? match[1].trim() : null
  } catch {
    return null
  }
}

// Recursive size of a world dir. Worlds are small (a few MB); no need to guard
// depth. Unreadable entries are skipped rather than failing the whole listing.
async function dirSize(dir: string): Promise<number> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  let total = 0
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      total += await dirSize(full)
    } else {
      try {
        total += (await stat(full)).size
      } catch {
        // ignore a file that vanished/raced
      }
    }
  }
  return total
}

async function countPlayers(worldDir: string): Promise<number> {
  try {
    const players = await readdir(join(worldDir, 'Players'))
    return players.filter((f) => f.toLowerCase().endsWith('.sav')).length
  } catch {
    return 0
  }
}

async function mtimeIso(path: string): Promise<string | null> {
  try {
    return (await stat(path)).mtime.toISOString()
  } catch {
    return null
  }
}

export async function listWorlds(activeWorldId: string | null): Promise<WorldInfo[]> {
  let entries
  try {
    entries = await readdir(saveGamesDir(), { withFileTypes: true })
  } catch {
    return []
  }
  const worlds: WorldInfo[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || NON_WORLD_DIRS.has(entry.name)) continue
    const dir = join(saveGamesDir(), entry.name)
    worlds.push({
      id: entry.name,
      active: entry.name === activeWorldId,
      sizeBytes: await dirSize(dir),
      modifiedAt: await mtimeIso(dir),
      playerCount: await countPlayers(dir),
    })
  }
  // Active world first, then most-recently-modified.
  worlds.sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1
    return (b.modifiedAt ?? '').localeCompare(a.modifiedAt ?? '')
  })
  return worlds
}

export async function listBackups(): Promise<BackupInfo[]> {
  let entries
  try {
    entries = await readdir(backupsDir(), { withFileTypes: true })
  } catch {
    return []
  }
  const backups: BackupInfo[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !BACKUP_FILE_RE.test(entry.name)) continue
    const full = join(backupsDir(), entry.name)
    try {
      const s = await stat(full)
      backups.push({ file: entry.name, sizeBytes: s.size, modifiedAt: s.mtime.toISOString() })
    } catch {
      // skip a file that vanished mid-listing
    }
  }
  backups.sort((a, b) => (b.modifiedAt ?? '').localeCompare(a.modifiedAt ?? '')) // newest first
  return backups
}

// --- Mutating operations (spec §2/§3) ----------------------------------------

// Validate a client-supplied backup filename and resolve it to an absolute path
// strictly inside backupsDir(). Rejects anything that isn't a bare, correctly
// named basename -- the primary path-traversal guard (spec §3).
export function resolveBackupPath(file: unknown): string | null {
  if (typeof file !== 'string' || !BACKUP_FILE_RE.test(file)) return null
  if (file.includes('/') || file.includes('\\') || file.includes('..')) return null
  if (file !== basename(file)) return null
  return join(backupsDir(), file)
}

// A world id is a bare directory name under SaveGames/0. Restrict the charset
// and confirm the directory exists (no traversal, no phantom worlds).
export async function worldExists(worldId: unknown): Promise<boolean> {
  if (typeof worldId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(worldId)) return false
  if (NON_WORLD_DIRS.has(worldId)) return false
  try {
    return (await stat(join(saveGamesDir(), worldId))).isDirectory()
  } catch {
    return false
  }
}

// Free/total disk on the volume holding this instance's worlds + backups.
export async function getSavesDisk(): Promise<DiskUsage | null> {
  return diskUsage(gameDir())
}

// backup.sh's timestamp shape: YYYYMMDD_HHMMSS (local time).
function backupStamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

// tar the whole SaveGames tree, exactly as scripts/backup.sh does, into
// backupsDir(). `label` distinguishes special backups (e.g. "prerestore") while
// keeping the palworld-save-*.tar.gz shape so they list as restore points.
export async function createBackup(label?: string): Promise<BackupInfo> {
  await mkdir(backupsDir(), { recursive: true })
  const file = `palworld-save-${label ? `${label}-` : ''}${backupStamp()}.tar.gz`
  const dest = join(backupsDir(), file)
  try {
    await execFileP('tar', [
      // On a LIVE server the game's own rolling backup files change/vanish as
      // tar reads them. Suppress those warnings...
      '--warning=no-file-changed',
      '--warning=no-file-removed',
      // ...and skip the game's own rolling backups entirely: they're bulky,
      // owned by the game user (unwritable by uid 2001 on restore), and not the
      // world we care about. Restore excludes them too, so this keeps create and
      // restore symmetric.
      '--exclude',
      '*/backup',
      '-czf',
      dest,
      '-C',
      savedDir(),
      'SaveGames',
    ])
  } catch (err) {
    // ...and still tolerate tar's exit code 1 ("some files differ / changed
    // while reading"), which is non-fatal -- the archive is written and the
    // main save files are captured. Only a fatal error (exit >= 2) is a real
    // failure. (scripts/backup.sh gets away with this by ignoring tar's status.)
    if ((err as { code?: number }).code !== 1) throw err
  }
  const s = await stat(dest) // confirm the archive exists before reporting success
  return { file, sizeBytes: s.size, modifiedAt: s.mtime.toISOString() }
}

export async function deleteBackup(fullPath: string): Promise<void> {
  await unlink(fullPath)
}

// --- Per-player saves (Players/<PlayerUId>.sav) ------------------------------
// Each file in a world's Players/ dir is one player's character. Deleting it
// forces that player to recreate their character on next join. The filename is
// the Palworld PlayerUId (8 significant hex chars + zero padding, 32 total).

export type PlayerSaveInfo = { playerUid: string; sizeBytes: number; modifiedAt: string | null }

const PLAYER_SAVE_RE = /^[0-9A-Fa-f]{32}\.sav$/

function playersDir(worldId: string): string {
  return join(saveGamesDir(), worldId, 'Players')
}

export async function listPlayerSaves(worldId: string): Promise<PlayerSaveInfo[]> {
  let entries
  try {
    entries = await readdir(playersDir(worldId), { withFileTypes: true })
  } catch {
    return []
  }
  const saves: PlayerSaveInfo[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !PLAYER_SAVE_RE.test(entry.name)) continue
    try {
      const s = await stat(join(playersDir(worldId), entry.name))
      saves.push({ playerUid: entry.name.replace(/\.sav$/i, ''), sizeBytes: s.size, modifiedAt: s.mtime.toISOString() })
    } catch {
      // skip a file that vanished mid-listing
    }
  }
  saves.sort((a, b) => (b.modifiedAt ?? '').localeCompare(a.modifiedAt ?? '')) // most-recent first
  return saves
}

// Validate world id + player uid as bare identifiers and resolve to an absolute
// path strictly inside that world's Players/ dir (path-traversal guard).
export function resolvePlayerSavePath(worldId: unknown, playerUid: unknown): string | null {
  if (typeof worldId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(worldId) || NON_WORLD_DIRS.has(worldId)) return null
  if (typeof playerUid !== 'string' || !/^[0-9A-Fa-f]{32}$/.test(playerUid)) return null
  const file = `${playerUid}.sav`
  const full = join(playersDir(worldId), file)
  if (full !== join(playersDir(worldId), basename(file))) return null
  return full
}

export async function deletePlayerSave(fullPath: string): Promise<void> {
  await unlink(fullPath)
}

// --- Save decoding (read-only, via the vendored psp-decode helper) -----------
// Shells out to the `psp-decode` binary (savtools/, MIT psp-core) to decompress
// a PlM1/Oodle .sav to its GVAS JSON. A world Level.sav decodes to ~1MB of JSON,
// so allow a large buffer.
const PSP_DECODE_BIN = process.env.PSP_DECODE_BIN ?? 'psp-decode'

export async function decodeSaveToJson(fullPath: string): Promise<string> {
  const { stdout } = await execFileP(PSP_DECODE_BIN, [fullPath], {
    maxBuffer: 256 * 1024 * 1024,
  })
  return stdout
}

// World inspector (Stage 2): loads Level.sav + Players/ via psp-inspect and
// returns domain summaries { players, guilds, pals }. Needs the bundled game
// data (Pal names). Large worlds produce a lot of JSON, so allow a big buffer.
const PSP_INSPECT_BIN = process.env.PSP_INSPECT_BIN ?? 'psp-inspect'

// psp-core game-data dir (Pal/item metadata). OPERATOR-SUPPLIABLE: a bundle placed
// at <srv>/gamedata/psp-data/json (fleet-wide) is used ahead of the baked one, so
// a clean-room image (built with BUNDLE_PSP_DATA=0, no bundled Pocketpair data)
// can be given it at runtime without a rebuild. If neither is present the binaries
// degrade to raw ids (load_game_data_or_empty) — and the inspector UI resolves
// friendly names from the runtime datasets (/api/datasets) anyway, so this is
// optional. A private build (BUNDLE_PSP_DATA=1) keeps the baked path.
const PSP_GAME_DATA_BAKED = process.env.PSP_GAME_DATA_DIR ?? '/usr/local/share/psp-data/json'
const PSP_SUPPLIED_DATA = `${process.env.PALWORLD_SRV_ROOT ?? '/srv/palworld'}/gamedata/psp-data/json`
function pspGameDataDir(): string {
  try {
    if (existsSync(PSP_SUPPLIED_DATA)) return PSP_SUPPLIED_DATA
  } catch {
    /* fall through to baked */
  }
  return PSP_GAME_DATA_BAKED
}

export async function inspectWorld(worldId: string): Promise<unknown> {
  const worldDir = join(saveGamesDir(), worldId)
  const { stdout } = await execFileP(PSP_INSPECT_BIN, [worldDir, pspGameDataDir()], {
    maxBuffer: 512 * 1024 * 1024,
  })
  return JSON.parse(stdout)
}

// Per-player inventory (Stage 2b, read-only): one player's five item containers
// from the world save. Lazy -- fetched only when the operator inspects a player,
// so it isn't paid on every world load. Item friendly names aren't in the
// bundled data, so slots are ID + category/rarity/count (+ gear dynamics).
const PSP_PLAYER_BIN = process.env.PSP_PLAYER_BIN ?? 'psp-player'

export type InventorySlot = {
  slot: number
  id: string
  count: number
  category?: string
  type?: string
  rarity?: number
  weight?: number
  max_stack?: number
  durability?: number
  bullets?: number
  passives?: string[]
}
export type InventoryContainer = { kind: string; slots: InventorySlot[] }
export type PlayerInventory = {
  uid: string
  nickname: string
  level: number
  exp: number
  hp: number
  stomach: number
  sanity: number
  status_points: Record<string, number>
  containers: InventoryContainer[]
}

export async function inspectPlayerInventory(
  worldId: string,
  playerUid: string,
): Promise<PlayerInventory> {
  const worldDir = join(saveGamesDir(), worldId)
  const { stdout } = await execFileP(PSP_PLAYER_BIN, [worldDir, pspGameDataDir(), playerUid], {
    maxBuffer: 512 * 1024 * 1024,
  })
  return JSON.parse(stdout) as PlayerInventory
}

// Player-basics editor (Stage 3, a Level.sav WRITE): sets level/exp/hp/stomach/
// sanity and per-stat status-point allocations by round-tripping the player DTO
// (only the patched fields change; techs/quests/inventory/Pals are preserved).
// DESTRUCTIVE write -- the caller MUST have confirmed the server is stopped and
// taken a backup first. Only Level.sav is written.
const PSP_EDIT_PLAYER_BIN = process.env.PSP_EDIT_PLAYER_BIN ?? 'psp-edit-player'

export type PlayerEdit = {
  level?: number
  exp?: number
  hp?: number
  stomach?: number
  sanity?: number
  status_points?: Record<string, number>
  pals?: { heal_all?: boolean; levels?: Record<string, number> }
  items?: Record<string, Record<string, number>>
}
export type PlayerEditResult = {
  ok: boolean
  nickname: string
  level: number
  exp: number
  hp: number
  stomach: number
  sanity: number
  status_points: Record<string, number>
  healed: boolean
  pals_updated: string[]
}

export async function editPlayerBasics(
  worldId: string,
  playerUid: string,
  edit: PlayerEdit,
): Promise<PlayerEditResult> {
  const worldDir = join(saveGamesDir(), worldId)
  const { stdout } = await execFileP(
    PSP_EDIT_PLAYER_BIN,
    [worldDir, pspGameDataDir(), playerUid, JSON.stringify(edit)],
    { maxBuffer: 512 * 1024 * 1024 },
  )
  return JSON.parse(stdout) as PlayerEditResult
}

// Deletes a player from the WORLD save (Level.sav) so the game forces fresh
// character creation on next join -- character, Pals, containers, guild
// membership, and bases. DESTRUCTIVE + a Level.sav WRITE: the caller MUST have
// confirmed the server is stopped and taken a backup first. Returns
// { deleted, nickname, reason? }; deleted=false means refused (guild admin).
const PSP_DELETE_PLAYER_BIN = process.env.PSP_DELETE_PLAYER_BIN ?? 'psp-delete-player'

export type DeletePlayerResult = {
  deleted: boolean
  nickname: string
  reason?: string
  guild_name?: string
  guild_named?: boolean
  member_count?: number
  guild_deleted?: boolean
}

export async function deletePlayerFromWorld(
  worldId: string,
  playerUid: string,
): Promise<DeletePlayerResult> {
  const worldDir = join(saveGamesDir(), worldId)
  const { stdout } = await execFileP(PSP_DELETE_PLAYER_BIN, [worldDir, pspGameDataDir(), playerUid], {
    maxBuffer: 512 * 1024 * 1024,
  })
  return JSON.parse(stdout) as DeletePlayerResult
}

// Every line tar prints on a metadata op it can't do as a non-owner. These are
// harmless here (see restoreBackup) -- any OTHER error means a real failure.
const METADATA_ONLY_TAR_ERROR =
  /Cannot (change mode|utime|change ownership)|Operation not permitted|Exiting with failure status/

// Extract a backup over SaveGames. DESTRUCTIVE: the caller MUST have confirmed
// the server is stopped and taken a pre-restore snapshot first.
//
// The dashboard runs as uid 2001 while the existing world dirs are owned by the
// game user, so tar exits 2 trying to chmod/utime those dirs -- but the FILES
// still extract correctly (the dirs are 0777, and the game re-chowns everything
// to its own user on start). We therefore tolerate an extraction whose ONLY
// errors are those metadata permission failures, and rethrow anything else (a
// genuine write error, corrupt archive, disk full, ...).
export async function restoreBackup(fullPath: string): Promise<void> {
  try {
    await execFileP('tar', [
      '-xzf',
      fullPath,
      '--exclude',
      '*/backup', // skip the game's own rolling backups (bulky, unwritable, regenerated)
      '-C',
      savedDir(),
    ])
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? ''
    const lines = stderr
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    const onlyMetadataErrors = lines.length > 0 && lines.every((line) => METADATA_ONLY_TAR_ERROR.test(line))
    if (!onlyMetadataErrors) throw err
  }
}

// Point DedicatedServerName at another world. Written through the shared
// backup-then-atomic path; the game re-reads GameUserSettings.ini on start, so
// this takes effect on the next restart (caller does NOT auto-restart).
export async function setActiveWorld(worldId: string): Promise<void> {
  const raw = await readFile(gameUserSettingsPath(), 'utf8')
  if (!/^DedicatedServerName=.*$/m.test(raw)) {
    throw new Error('DedicatedServerName line not found in GameUserSettings.ini')
  }
  await writeConfigFileWithBackup(
    gameUserSettingsPath(),
    raw.replace(/^DedicatedServerName=.*$/m, `DedicatedServerName=${worldId}`),
  )
}

// Create a fresh world: pick a new Palworld-style id (32 uppercase hex) and point
// the server at it. The game generates the empty world dir on its NEXT start (we
// deliberately don't create it here), so the current world is untouched and stays
// listed + switchable until then. Returns the new id.
export async function createWorld(): Promise<string> {
  const id = randomBytes(16).toString('hex').toUpperCase()
  await setActiveWorld(id)
  return id
}

// Permanently remove a world's save directory. Charset-guarded and confined to
// SaveGames/0 (worldExists rejects traversal + non-world dirs like `backup`). The
// ROUTE is responsible for refusing the active world and snapshotting first; this
// just performs the delete.
export async function deleteWorld(worldId: unknown): Promise<void> {
  if (!(await worldExists(worldId))) throw new Error('World not found')
  await rm(join(saveGamesDir(), worldId as string), { recursive: true, force: true })
}

// Is the game server currently SERVING? Restore refuses while it is, since
// overwriting the live save files under a running server corrupts them (spec
// §3). "Up" means a genuine AUTHENTICATED 200 from the game REST -- the exact
// signal the snapshot relies on (fetchUpstream). This matters because on this
// host, even a fully-exited game container still answers port 8212 with a 401
// (some leftover/proxy), so an earlier "any HTTP response = up" check wrongly
// blocked restore while the game was down. A 401/5xx/refusal/timeout all mean
// not-serving -> restore is allowed.
// Lightweight metrics probe for the auto-backup scheduler: is the game up, and
// how many players are online. `players` is -1 when the server is up but the
// count can't be read (so callers can choose NOT to treat unknown as empty).
export async function getServerMetrics(): Promise<{ up: boolean; players: number }> {
  const { restUrl, adminPassword: password } = currentRestConfig()
  try {
    const base = new URL(restUrl)
    const response = await fetch(new URL('/v1/api/metrics', base), {
      headers: {
        Accept: 'application/json',
        Authorization: `Basic ${Buffer.from(`admin:${password}`).toString('base64')}`,
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(3000),
    })
    if (!response.ok) return { up: false, players: 0 }
    const data = (await response.json().catch(() => ({}))) as { currentplayernum?: number }
    return { up: true, players: typeof data.currentplayernum === 'number' ? data.currentplayernum : -1 }
  } catch {
    return { up: false, players: 0 }
  }
}

export async function isGameServerUp(): Promise<boolean> {
  const { restUrl, adminPassword: password } = currentRestConfig()
  try {
    const base = new URL(restUrl)
    const response = await fetch(new URL('/v1/api/metrics', base), {
      headers: {
        Accept: 'application/json',
        Authorization: `Basic ${Buffer.from(`admin:${password}`).toString('base64')}`,
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(3000),
    })
    return response.ok
  } catch {
    return false
  }
}
