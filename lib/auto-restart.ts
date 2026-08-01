// PATCH (not upstream): restart-automation monitor (roadmap #6, completed per
// docs/specs/restart-automation.md; made PER-INSTANCE in #7 Phase 6 follow-up).
// Runs in-process (started from instrumentation.ts on boot). Four independently-
// toggled groups, all sharing the one proven path: decide -> write the instance's
// restart.request (with an optional countdown broadcast) -> host recreates ->
// ledger the event.
//
//   1. Scheduled  — every N minutes (uptime) OR daily at fixed HH:MM times.
//   2. Memory     — restart when RSS is over an absolute MB ceiling for N
//                   consecutive samples (sustained-breach, not a single spike).
//   3. Crash      — restart when the container is running but the REST is
//                   unresponsive past a boot grace (hang / failed startup).
//   4. Countdown  — seconds of broadcast warning before a scheduled/memory
//                   restart. Crash restarts get NO countdown (waittime 0).
//
// Per-instance: `default` (Primary) keeps its original settings file, flat flag
// paths and ARMED crash default — byte-identical to #6. Every OTHER instance gets
// an id-suffixed settings file, its own /run/palworld/<id>/ metrics + flag paths,
// and crash auto-restart defaults OFF (so a new server's multi-minute first-boot
// SteamCMD install is never mistaken for a hang and killed). Metrics come from the
// per-instance publisher; the monitor acts ONLY on a running container.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { isGameServerUp } from '@/lib/saves'
import { DEFAULT_INSTANCE_ID, listInstances, resolveLifecyclePaths, runWithInstance } from '@/lib/instances'

// default keeps the original path (env override honored); others are id-suffixed.
function settingsFile(id: string): string {
  if (id === DEFAULT_INSTANCE_ID) return process.env.AUTO_RESTART_FILE ?? './data/auto-restart.json'
  return `./data/auto-restart.${id}.json`
}

const TICK_MS = 30_000
// A daily slot fires only when a tick lands within this window AFTER the slot
// time — so a slot that passed hours before the monitor started is NOT caught
// up (no surprise restart on deploy). Ticks are 30s, so 90s always catches one.
const DAILY_FIRE_WINDOW_MS = 90_000
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

export type RestartCause = 'scheduled' | 'memory' | 'crash'
export type LedgerEntry = { at: string; cause: RestartCause; outcome: 'ok' | 'capped' }

export type AutoRestart = {
  // 1. scheduled
  scheduledEnabled: boolean
  scheduleMode: 'interval' | 'daily'
  everyMinutes: number
  dailyTimes: string[]
  // 2. memory
  memoryEnabled: boolean
  memoryMb: number
  memorySustainedChecks: number
  // 3. crash
  crashEnabled: boolean
  hangChecks: number
  bootGraceSeconds: number
  // 4. shared / limits
  maxPerHour: number
  restartWaittime: number
  // status (monitor-owned)
  lastActionAt: string | null
  lastReason: RestartCause | null
  lastStatus: 'ok' | 'capped' | 'error' | null
  lastMessage: string | null
  lastScheduledFired: string | null
  ledger: LedgerEntry[]
}

const DEFAULTS: AutoRestart = {
  scheduledEnabled: false,
  scheduleMode: 'daily',
  everyMinutes: 240,
  dailyTimes: [],
  memoryEnabled: false,
  memoryMb: 0,
  memorySustainedChecks: 3,
  crashEnabled: true, // owner's choice: crash auto-restart armed out of the box
  hangChecks: 4,
  bootGraceSeconds: 150,
  maxPerHour: 5,
  restartWaittime: 30,
  lastActionAt: null,
  lastReason: null,
  lastStatus: null,
  lastMessage: null,
  lastScheduledFired: null,
  ledger: [],
}

function clampNumber(v: unknown, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function normalizeTimes(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  const set = new Set(v.filter((t): t is string => typeof t === 'string' && TIME_RE.test(t)))
  return Array.from(set).sort()
}

// Old #6 ledger entries were bare ISO strings; carry them forward as objects.
function normalizeLedger(v: unknown): LedgerEntry[] {
  if (!Array.isArray(v)) return []
  return v
    .map((e): LedgerEntry | null => {
      if (typeof e === 'string') return { at: e, cause: 'memory', outcome: 'ok' }
      if (e && typeof e === 'object') {
        const o = e as Record<string, unknown>
        if (typeof o.at === 'string') {
          const cause = (['scheduled', 'memory', 'crash'].includes(o.cause as string)
            ? o.cause
            : 'memory') as RestartCause
          const outcome = o.outcome === 'capped' ? 'capped' : 'ok'
          return { at: o.at, cause, outcome }
        }
      }
      return null
    })
    .filter((e): e is LedgerEntry => e !== null)
    .slice(-100)
}

function normalize(s: Partial<AutoRestart> & Record<string, unknown>, crashDefault: boolean): AutoRestart {
  return {
    scheduledEnabled: Boolean(s.scheduledEnabled),
    scheduleMode: s.scheduleMode === 'interval' ? 'interval' : 'daily',
    everyMinutes: clampNumber(s.everyMinutes, 30, 10_080, 240),
    dailyTimes: normalizeTimes(s.dailyTimes),
    memoryEnabled: Boolean(s.memoryEnabled),
    memoryMb: clampNumber(s.memoryMb, 0, 1_048_576, 0),
    memorySustainedChecks: clampNumber(s.memorySustainedChecks, 1, 60, 3),
    crashEnabled: s.crashEnabled === undefined ? crashDefault : Boolean(s.crashEnabled),
    hangChecks: clampNumber(s.hangChecks, 1, 60, 4),
    bootGraceSeconds: clampNumber(s.bootGraceSeconds, 30, 1800, 150),
    maxPerHour: clampNumber(s.maxPerHour, 1, 20, 5),
    restartWaittime: clampNumber(s.restartWaittime, 0, 600, 30),
    lastActionAt: (s.lastActionAt as string) ?? null,
    lastReason: (['scheduled', 'memory', 'crash'].includes(s.lastReason as string)
      ? s.lastReason
      : null) as RestartCause | null,
    lastStatus: (['ok', 'capped', 'error'].includes(s.lastStatus as string)
      ? s.lastStatus
      : null) as AutoRestart['lastStatus'],
    lastMessage: (s.lastMessage as string) ?? null,
    lastScheduledFired: (s.lastScheduledFired as string) ?? null,
    ledger: normalizeLedger(s.ledger),
  }
}

// Crash auto-restart is ARMED by default only for the Primary server; new
// instances default OFF so a long first-boot install isn't killed as a "hang".
function crashDefaultFor(id: string): boolean {
  return id === DEFAULT_INSTANCE_ID
}

export function readAutoRestart(id: string = DEFAULT_INSTANCE_ID): AutoRestart {
  try {
    const f = settingsFile(id)
    if (existsSync(f)) return normalize(JSON.parse(readFileSync(f, 'utf8')), crashDefaultFor(id))
  } catch {
    /* defaults */
  }
  return { ...DEFAULTS, crashEnabled: crashDefaultFor(id) }
}

function writeAutoRestart(id: string, s: AutoRestart): void {
  const f = settingsFile(id)
  mkdirSync(dirname(f), { recursive: true })
  const tmp = `${f}.tmp`
  writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 })
  renameSync(tmp, f)
}

// Operator-facing settings only; status/ledger are monitor-owned.
export function saveAutoRestartSettings(id: string, input: Partial<AutoRestart>): AutoRestart {
  const cur = readAutoRestart(id)
  const merge = <K extends keyof AutoRestart>(k: K): AutoRestart[K] =>
    input[k] === undefined ? cur[k] : (input[k] as AutoRestart[K])
  const next = normalize(
    {
      ...cur,
      scheduledEnabled: merge('scheduledEnabled'),
      scheduleMode: merge('scheduleMode'),
      everyMinutes: merge('everyMinutes'),
      dailyTimes: merge('dailyTimes'),
      memoryEnabled: merge('memoryEnabled'),
      memoryMb: merge('memoryMb'),
      memorySustainedChecks: merge('memorySustainedChecks'),
      crashEnabled: merge('crashEnabled'),
      maxPerHour: merge('maxPerHour'),
      restartWaittime: merge('restartWaittime'),
    },
    crashDefaultFor(id),
  )
  writeAutoRestart(id, next)
  return next
}

type Metrics = { present?: boolean; status?: string; startedAt?: string; memBytes?: number | null }

export function readMetrics(id: string = DEFAULT_INSTANCE_ID): Metrics | null {
  try {
    const f = resolveLifecyclePaths(id).metrics
    if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8')) as Metrics
  } catch {
    /* unavailable */
  }
  return null
}

export function recentTriggers(ledger: LedgerEntry[]): number {
  const cutoff = Date.now() - 60 * 60 * 1000
  return ledger.filter((e) => e.outcome === 'ok' && Date.parse(e.at) >= cutoff).length
}

// Next scheduled restart as an ISO string (for the card + Overview chip), or null.
export function computeNextScheduled(s: AutoRestart, m: Metrics | null): string | null {
  if (!s.scheduledEnabled) return null
  if (s.scheduleMode === 'interval') {
    if (!m?.startedAt) return null
    return new Date(Date.parse(m.startedAt) + s.everyMinutes * 60_000).toISOString()
  }
  if (s.dailyTimes.length === 0) return null
  const now = new Date()
  let best: Date | null = null
  for (let dayOffset = 0; dayOffset <= 1; dayOffset++) {
    for (const t of s.dailyTimes) {
      const [h, min] = t.split(':').map(Number)
      const d = new Date(now)
      d.setDate(now.getDate() + dayOffset)
      d.setHours(h, min, 0, 0)
      if (d.getTime() > now.getTime() && (!best || d < best)) best = d
    }
  }
  return best ? best.toISOString() : null
}

function lifecycleInFlight(id: string): boolean {
  const p = resolveLifecyclePaths(id)
  return existsSync(p.start) || existsSync(p.shutdown) || existsSync(p.restart)
}

function requestRestart(id: string, waittime: number, message: string, dryRun: boolean): void {
  const p = resolveLifecyclePaths(id)
  mkdirSync(p.runDir, { recursive: true })
  const tmp = `${p.restart}.tmp`
  writeFileSync(tmp, JSON.stringify({ waittime, message, dryRun, requestedAt: Date.now() }), { mode: 0o660 })
  renameSync(tmp, p.restart)
}

function recordAction(
  id: string,
  status: AutoRestart['lastStatus'],
  cause: RestartCause | null,
  message: string,
  ledgerEntry: LedgerEntry | null,
  scheduledFired?: string,
): void {
  const cur = readAutoRestart(id)
  writeAutoRestart(id, {
    ...cur,
    ledger: ledgerEntry ? [...cur.ledger, ledgerEntry].slice(-100) : cur.ledger,
    lastActionAt: new Date().toISOString(),
    lastReason: cause,
    lastStatus: status,
    lastMessage: message,
    lastScheduledFired: scheduledFired ?? cur.lastScheduledFired,
  })
}

// Force a restart request now (Test button). Dry-run by default so it doesn't
// kick players — exercises the whole path (broadcast, no recreate).
export function testAutoRestart(id: string = DEFAULT_INSTANCE_ID, dryRun = true): AutoRestart {
  const s = readAutoRestart(id)
  try {
    requestRestart(id, s.restartWaittime, dryRun ? 'Restart automation test' : 'Server restarting', dryRun)
    recordAction(id, 'ok', null, dryRun ? 'Test restart queued (dry run).' : 'Restart queued.', null)
  } catch (err) {
    recordAction(id, 'error', null, err instanceof Error ? err.message : 'Failed to queue restart', null)
  }
  return readAutoRestart(id)
}

// ── monitor ─────────────────────────────────────────────────────────────────
// Per-instance streak/cooldown state.
const hangStreak = new Map<string, number>()
const memStreak = new Map<string, number>()
const cooldownUntil = new Map<string, number>()
let running = false

// Which daily slots (if any) are firing right now, and the guard string to store.
function dueDailySlot(s: AutoRestart): string | null {
  if (s.scheduleMode !== 'daily') return null
  const now = new Date()
  const y = now.getFullYear()
  const mo = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  const today = `${y}-${mo}-${d}`
  for (const t of s.dailyTimes) {
    const [h, min] = t.split(':').map(Number)
    const slot = new Date(now)
    slot.setHours(h, min, 0, 0)
    const delta = now.getTime() - slot.getTime()
    const guard = `${today}T${t}`
    if (delta >= 0 && delta < DAILY_FIRE_WINDOW_MS && s.lastScheduledFired !== guard) {
      return guard
    }
  }
  return null
}

async function tickInstance(id: string): Promise<void> {
  const s = readAutoRestart(id)
  const anyEnabled = s.crashEnabled || s.memoryEnabled || s.scheduledEnabled
  if (!anyEnabled || lifecycleInFlight(id) || Date.now() < (cooldownUntil.get(id) ?? 0)) {
    hangStreak.set(id, 0)
    memStreak.set(id, 0)
    return
  }

  const m = readMetrics(id)
  // Act only on a running container (exited == deliberate stop).
  if (!m || m.present === false || m.status !== 'running') {
    hangStreak.set(id, 0)
    memStreak.set(id, 0)
    return
  }
  const ageSec = m.startedAt ? (Date.now() - Date.parse(m.startedAt)) / 1000 : Infinity

  // --- reactive first: crash (hang), then memory ---
  if (s.crashEnabled && ageSec > s.bootGraceSeconds) {
    const up = await runWithInstance(id, () => isGameServerUp())
    hangStreak.set(id, up ? 0 : (hangStreak.get(id) ?? 0) + 1)
  } else {
    hangStreak.set(id, 0)
  }
  if (s.memoryEnabled && s.memoryMb > 0 && typeof m.memBytes === 'number') {
    memStreak.set(id, m.memBytes / (1024 * 1024) > s.memoryMb ? (memStreak.get(id) ?? 0) + 1 : 0)
  } else {
    memStreak.set(id, 0)
  }

  let cause: RestartCause | null = null
  let scheduledGuard: string | undefined
  let countdown = s.restartWaittime
  if (s.crashEnabled && (hangStreak.get(id) ?? 0) >= s.hangChecks) {
    cause = 'crash'
    countdown = 0 // no warning — the server is already unresponsive
  } else if (s.memoryEnabled && s.memoryMb > 0 && (memStreak.get(id) ?? 0) >= s.memorySustainedChecks) {
    cause = 'memory'
  } else if (s.scheduledEnabled) {
    if (s.scheduleMode === 'interval' && ageSec >= s.everyMinutes * 60) {
      cause = 'scheduled'
    } else {
      const guard = dueDailySlot(s)
      if (guard) {
        cause = 'scheduled'
        scheduledGuard = guard
      }
    }
  }
  if (!cause) return

  if (recentTriggers(s.ledger) >= s.maxPerHour) {
    recordAction(id, 'capped', cause, `Would restart (${cause}) but hit the ${s.maxPerHour}/hour cap.`, {
      at: new Date().toISOString(),
      cause,
      outcome: 'capped',
    }, scheduledGuard)
    cooldownUntil.set(id, Date.now() + 5 * 60_000)
    return
  }

  const message =
    cause === 'memory'
      ? `Auto-restart: memory over ${s.memoryMb}MB`
      : cause === 'crash'
        ? 'Auto-restart: server not responding'
        : 'Scheduled restart'
  requestRestart(id, countdown, message, false)
  recordAction(id, 'ok', cause, `Restart requested (${cause}).`, {
    at: new Date().toISOString(),
    cause,
    outcome: 'ok',
  }, scheduledGuard)
  hangStreak.set(id, 0)
  memStreak.set(id, 0)
  cooldownUntil.set(id, Date.now() + (countdown + s.bootGraceSeconds + 60) * 1000)
}

async function tick(): Promise<void> {
  if (running) return
  running = true
  try {
    for (const inst of listInstances()) {
      try {
        await tickInstance(inst.id)
      } catch {
        /* never let one instance's failure stop the others */
      }
    }
  } catch {
    /* never let a tick throw kill the interval */
  } finally {
    running = false
  }
}

let started = false

export function startAutoRestartMonitor(): void {
  if (started) return
  started = true
  setInterval(() => {
    void tick()
  }, TICK_MS)
}
