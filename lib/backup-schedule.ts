// PATCH (not upstream): auto-backup scheduler (roadmap #5 extension; made
// PER-INSTANCE in #7 Phase 6 follow-up). Runs in-process (started from
// instrumentation.ts on server boot) and, on a configurable interval per
// instance, snapshots that instance's world via the same createBackup() the
// manual button uses. Settings persist to ./data (the dashboard's writable
// volume) like panel-auth. No host privilege needed -- backups run as uid 2001
// on the mounted save volume, exactly like the manual/Saves-panel path.
//
// Per-instance: the `default` (Primary) server keeps the original settings file
// and byte-identical behavior; every other instance gets an id-suffixed settings
// file and its own schedule. The scheduler ticks once/min and loops the registry.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  createBackup,
  deleteBackup,
  getServerMetrics,
  listBackups,
  resolveBackupPath,
} from '@/lib/saves'
import { getRconConfig, runRcon } from '@/lib/rcon-exec'
import { DEFAULT_INSTANCE_ID, listInstances, runWithInstance } from '@/lib/instances'

export type BackupScheduleStatus = 'ok' | 'skipped-empty' | 'error'
export type BackupSchedule = {
  enabled: boolean
  intervalMinutes: number
  keep: number
  skipWhenEmpty: boolean
  lastRunAt: string | null // last SUCCESSFUL auto-backup
  lastCheckAt: string | null // last scheduler attempt (any outcome)
  lastStatus: BackupScheduleStatus | null
  lastMessage: string | null
}

// default keeps the original path (env override honored); others are id-suffixed.
function scheduleFile(id: string): string {
  if (id === DEFAULT_INSTANCE_ID) return process.env.BACKUP_SCHEDULE_FILE ?? './data/backup-schedule.json'
  return `./data/backup-schedule.${id}.json`
}
// Auto-backups carry this prefix so retention only ever prunes THEM -- never the
// daily cron backups, manual backups, or pre-edit/pre-restore snapshots.
const AUTO_PREFIX = 'palworld-save-auto-'

const DEFAULTS: BackupSchedule = {
  enabled: false,
  intervalMinutes: 60,
  keep: 24,
  skipWhenEmpty: true,
  lastRunAt: null,
  lastCheckAt: null,
  lastStatus: null,
  lastMessage: null,
}

function clampNumber(v: unknown, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function normalize(s: Partial<BackupSchedule>): BackupSchedule {
  return {
    enabled: Boolean(s.enabled),
    intervalMinutes: clampNumber(s.intervalMinutes, 5, 1440, 60),
    keep: clampNumber(s.keep, 1, 200, 24),
    skipWhenEmpty: s.skipWhenEmpty ?? true,
    lastRunAt: s.lastRunAt ?? null,
    lastCheckAt: s.lastCheckAt ?? null,
    lastStatus: s.lastStatus ?? null,
    lastMessage: s.lastMessage ?? null,
  }
}

export function readSchedule(id: string = DEFAULT_INSTANCE_ID): BackupSchedule {
  try {
    const f = scheduleFile(id)
    if (existsSync(f)) return normalize(JSON.parse(readFileSync(f, 'utf8')) as Partial<BackupSchedule>)
  } catch {
    /* fall through to defaults */
  }
  return { ...DEFAULTS }
}

function writeSchedule(id: string, s: BackupSchedule): void {
  const f = scheduleFile(id)
  mkdirSync(dirname(f), { recursive: true })
  const tmp = `${f}.tmp`
  writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 })
  renameSync(tmp, f)
}

// Update the operator-facing settings only; the lastRun*/lastCheck* fields are
// owned by the scheduler and preserved across a settings save.
export function saveScheduleSettings(id: string, input: Partial<BackupSchedule>): BackupSchedule {
  const cur = readSchedule(id)
  const next = normalize({
    ...cur,
    enabled: input.enabled ?? cur.enabled,
    intervalMinutes: input.intervalMinutes ?? cur.intervalMinutes,
    keep: input.keep ?? cur.keep,
    skipWhenEmpty: input.skipWhenEmpty ?? cur.skipWhenEmpty,
  })
  writeSchedule(id, next)
  return next
}

function recordOutcome(id: string, status: BackupScheduleStatus, message: string): void {
  const cur = readSchedule(id)
  const now = new Date().toISOString()
  writeSchedule(id, {
    ...cur,
    lastCheckAt: now,
    lastStatus: status,
    lastMessage: message,
    lastRunAt: status === 'ok' ? now : cur.lastRunAt,
  })
}

// Keep only the newest `keep` auto-backups; delete the rest. Returns how many
// were removed. Only ever touches AUTO_PREFIX files.
async function pruneAutoBackups(keep: number): Promise<number> {
  const autos = (await listBackups())
    .filter((b) => b.file.startsWith(AUTO_PREFIX))
    .sort((a, b) => (b.modifiedAt ?? '').localeCompare(a.modifiedAt ?? ''))
  const stale = autos.slice(keep)
  for (const b of stale) {
    const full = resolveBackupPath(b.file)
    if (full) await deleteBackup(full)
  }
  return stale.length
}

const running = new Map<string, boolean>()

// Run one auto-backup for the given instance. `force` (the Test button) bypasses
// the skip-when-empty gate so the operator always gets a snapshot. All the
// filesystem/RCON work runs "as" the instance via runWithInstance.
export async function runAutoBackup(id: string = DEFAULT_INSTANCE_ID, opts: { force?: boolean } = {}): Promise<BackupSchedule> {
  if (running.get(id)) return readSchedule(id)
  running.set(id, true)
  try {
    await runWithInstance(id, async () => {
      const s = readSchedule(id)
      if (!opts.force && s.skipWhenEmpty) {
        const m = await getServerMetrics()
        // Skip only when we KNOW nobody's on (server down, or a real 0). An unknown
        // count (up but no number) backs up rather than silently never running.
        if (!m.up || m.players === 0) {
          recordOutcome(id, 'skipped-empty', m.up ? 'No players online' : 'Server offline')
          return
        }
      }
      // Best-effort RCON Save first so the tar captures the latest state (matches
      // the manual backup path). A failure (e.g. server down) is non-fatal.
      const rcon = getRconConfig(id)
      if (rcon) {
        try {
          await runRcon(rcon, 'Save')
        } catch {
          /* back up whatever is on disk */
        }
      }
      const backup = await createBackup('auto')
      const pruned = await pruneAutoBackups(s.keep)
      recordOutcome(id, 'ok', `Created ${backup.file}${pruned ? ` · pruned ${pruned} old` : ''}`)
    })
  } catch (err) {
    recordOutcome(id, 'error', err instanceof Error ? err.message : 'Backup failed')
  } finally {
    running.set(id, false)
  }
  return readSchedule(id)
}

let started = false

async function tick(): Promise<void> {
  for (const inst of listInstances()) {
    const s = readSchedule(inst.id)
    if (!s.enabled) continue
    const due = !s.lastRunAt || Date.now() - Date.parse(s.lastRunAt) >= s.intervalMinutes * 60_000
    if (due) await runAutoBackup(inst.id)
  }
}

// Idempotent: called once from instrumentation register() on server boot.
export function startBackupScheduler(): void {
  if (started) return
  started = true
  // Poll every minute and decide whether each instance's backup is due from its
  // persisted lastRunAt -- so the schedule survives restarts and a skipped
  // (empty) tick re-checks cheaply next minute instead of pushing it out.
  setInterval(() => {
    void tick()
  }, 60_000)
}
