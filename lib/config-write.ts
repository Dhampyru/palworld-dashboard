// SERVER-ONLY. Shared config-write path: snapshot the current file to a
// timestamped .bak (keeping the last 10), then write the new content
// atomically. Every config surface goes through this -- PalDefender
// Config.json, Engine.ini, and PalWorldSettings.ini -- so a bad save is always
// one file-copy away from being undone.
//
// NOT for .env or token files: backups are plaintext siblings, so backing up a
// secret would sprawl it across the directory. Callers pass only the config
// files here; the world-settings route keeps its separate in-place .env sync.

import { readFile, writeFile, rename, readdir, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

const KEEP_BACKUPS = 10
const BACKUP_SUFFIX = '.bak'

// A filesystem-safe timestamp: ISO with `:`/`.` swapped for `-`, so the name
// still sorts chronologically (lexicographic == time order).
function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

// Copy the current file to `<file>.<timestamp>.bak`, then prune to the newest
// KEEP_BACKUPS. Returns the backup path, or null when there was nothing to back
// up (first write of a not-yet-existing file). Best-effort: a backup failure
// must not block the actual write, so callers wrap this defensively.
export async function snapshotBeforeWrite(filePath: string): Promise<string | null> {
  let current: string
  try {
    current = await readFile(filePath, 'utf8')
  } catch {
    return null // file doesn't exist yet -- nothing to snapshot
  }

  const backupPath = `${filePath}.${timestamp()}${BACKUP_SUFFIX}`
  await writeFile(backupPath, current, 'utf8')
  await pruneBackups(filePath)
  return backupPath
}

async function pruneBackups(filePath: string): Promise<void> {
  const dir = dirname(filePath)
  const prefix = `${basename(filePath)}.`
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return
  }
  // Our own backups only: `<base>.<stamp>.bak`. The `.tmp` write-file and any
  // unrelated sibling are excluded by the suffix + prefix match.
  const backups = entries.filter((n) => n.startsWith(prefix) && n.endsWith(BACKUP_SUFFIX)).sort()
  const excess = backups.slice(0, Math.max(0, backups.length - KEEP_BACKUPS))
  await Promise.all(
    excess.map((name) => unlink(join(dir, name)).catch(() => {})),
  )
}

// The one write path. Snapshot first (best-effort), then temp-file + rename so
// the target is never a half-written file. Rename is safe here because every
// config file we write lives inside a mounted DIRECTORY, not as a single
// bind-mounted file -- a directory-local rename does not detach an inode from a
// mount (the trap the world-settings .env sync avoids by writing in place).
export async function writeConfigFileWithBackup(filePath: string, content: string): Promise<void> {
  try {
    await snapshotBeforeWrite(filePath)
  } catch {
    // A failed backup is not a reason to block the save the operator asked for.
  }
  const tmp = `${filePath}.tmp`
  await writeFile(tmp, content, 'utf8')
  await rename(tmp, filePath)
}
