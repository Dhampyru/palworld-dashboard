// PATCH (not upstream): scheduled/recurring broadcasts (like Nexus 2435, but built in). Runs
// in-process (started from instrumentation.ts on boot), per instance, on a configurable
// interval, cycling SEQUENTIALLY through a message list and sending each via RCON. Uses
// PalDefender's `pgbroadcast` (spaces/multi-word OK) when PalDefender is enabled, else falls
// back to vanilla `Broadcast` (which truncates at the first space, so spaces → underscores).
// Settings persist to ./data like the auto-backup/auto-restart schedulers.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { getRconConfig, runRcon } from '@/lib/rcon-exec'
import { getServerMetrics } from '@/lib/saves'
import { readPalDefenderState } from '@/lib/game-mods'
import { readChatLog } from '@/lib/chat-source'
import { DEFAULT_INSTANCE_ID, listInstances, runWithInstance } from '@/lib/instances'

// Join lines in the game's stdout log, used by the on-join welcome to detect new players. Two
// shapes are matched, both capturing (timestamp, DISPLAY name):
//   1. PalDefender:  [HH:MM:SS][info] 'Name' (UserId=steam_…, IP=…) has logged in.
//      (this is the one that carries the display name on this deployment; the plain
//       "steam_… connected to the server." line has only the SteamID, so we skip it.)
//   2. Native game:  [ts] [LOG] Name … joined/connected the server.  (chat route's JOIN_RE)
const JOIN_RES: RegExp[] = [
  /^\[([^\]]+)\]\[info\]\s+'([^']+)'\s+\(UserId=[^)]*\)\s+has logged in\./,
  /^\[([^\]]+)\]\s+\[LOG\]\s+(.+?)\s+(?:[\d.:]+\s+)?(?:joined|connected) the server\./,
]
// Cap on remembered join signatures (see runWelcome). Joins are sparse in a 512KB log tail, so
// this is far more than a tail can hold — it exists only to bound the persisted state.
const WELCOME_SEEN_CAP = 300

export type BroadcastStatus = 'ok' | 'skipped-empty' | 'error'
export type BroadcastSchedule = {
  enabled: boolean
  intervalMinutes: number
  messages: string[]
  prefix: string
  skipWhenEmpty: boolean
  nextIndex: number // sequential rotation cursor
  lastRunAt: string | null // last SUCCESSFUL send
  lastCheckAt: string | null // last scheduler attempt (any outcome)
  lastStatus: BroadcastStatus | null
  lastMessage: string | null
  // On-join welcome (event-driven, independent of the interval rotation): when a new player
  // joins, broadcast these messages in order. Supports a {name} placeholder for the joiner.
  welcomeEnabled: boolean
  welcomeMessages: string[]
  welcomeBaselined: boolean // scheduler-owned: set once welcome has seeded from the current log
  welcomeSeen: string[] // scheduler-owned: recent `ts|name` join signatures already handled
  welcomeLastAt: string | null
  welcomeLastMessage: string | null
}

function scheduleFile(id: string): string {
  if (id === DEFAULT_INSTANCE_ID) return process.env.BROADCAST_SCHEDULE_FILE ?? './data/broadcast-schedule.json'
  return `./data/broadcast-schedule.${id}.json`
}

const MAX_MESSAGES = 30
const MAX_MSG_LEN = 240

const DEFAULTS: BroadcastSchedule = {
  enabled: false,
  intervalMinutes: 15,
  messages: [],
  prefix: '',
  skipWhenEmpty: true,
  nextIndex: 0,
  lastRunAt: null,
  lastCheckAt: null,
  lastStatus: null,
  lastMessage: null,
  welcomeEnabled: false,
  welcomeMessages: [],
  welcomeBaselined: false,
  welcomeSeen: [],
  welcomeLastAt: null,
  welcomeLastMessage: null,
}

function clampNumber(v: unknown, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function cleanMessages(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v
    .map((m) => (typeof m === 'string' ? m.trim() : ''))
    .filter(Boolean)
    .slice(0, MAX_MESSAGES)
    .map((m) => m.slice(0, MAX_MSG_LEN))
}

function normalize(s: Partial<BroadcastSchedule>): BroadcastSchedule {
  const messages = cleanMessages(s.messages)
  return {
    enabled: Boolean(s.enabled),
    intervalMinutes: clampNumber(s.intervalMinutes, 1, 1440, 15),
    messages,
    prefix: typeof s.prefix === 'string' ? s.prefix.trim().slice(0, 40) : '',
    skipWhenEmpty: s.skipWhenEmpty ?? true,
    nextIndex: messages.length ? clampNumber(s.nextIndex, 0, messages.length - 1, 0) : 0,
    lastRunAt: s.lastRunAt ?? null,
    lastCheckAt: s.lastCheckAt ?? null,
    lastStatus: s.lastStatus ?? null,
    lastMessage: s.lastMessage ?? null,
    welcomeEnabled: Boolean(s.welcomeEnabled),
    welcomeMessages: cleanMessages(s.welcomeMessages),
    welcomeBaselined: Boolean(s.welcomeBaselined),
    welcomeSeen: Array.isArray(s.welcomeSeen)
      ? s.welcomeSeen.filter((x): x is string => typeof x === 'string').slice(-WELCOME_SEEN_CAP)
      : [],
    welcomeLastAt: s.welcomeLastAt ?? null,
    welcomeLastMessage: s.welcomeLastMessage ?? null,
  }
}

export function readSchedule(id: string = DEFAULT_INSTANCE_ID): BroadcastSchedule {
  try {
    const f = scheduleFile(id)
    if (existsSync(f)) return normalize(JSON.parse(readFileSync(f, 'utf8')) as Partial<BroadcastSchedule>)
  } catch {
    /* fall through to defaults */
  }
  return { ...DEFAULTS }
}

function writeSchedule(id: string, s: BroadcastSchedule): void {
  const f = scheduleFile(id)
  mkdirSync(dirname(f), { recursive: true })
  const tmp = `${f}.tmp`
  writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 })
  renameSync(tmp, f)
}

// Operator settings only; the lastRun*/nextIndex fields are owned by the scheduler. If the
// message list changed, restart rotation from the top so the cursor can't dangle.
export function saveScheduleSettings(id: string, input: Partial<BroadcastSchedule>): BroadcastSchedule {
  const cur = readSchedule(id)
  const nextMessages = input.messages !== undefined ? cleanMessages(input.messages) : cur.messages
  const messagesChanged = JSON.stringify(nextMessages) !== JSON.stringify(cur.messages)
  const next = normalize({
    ...cur,
    enabled: input.enabled ?? cur.enabled,
    intervalMinutes: input.intervalMinutes ?? cur.intervalMinutes,
    messages: nextMessages,
    prefix: input.prefix ?? cur.prefix,
    skipWhenEmpty: input.skipWhenEmpty ?? cur.skipWhenEmpty,
    nextIndex: messagesChanged ? 0 : cur.nextIndex,
    welcomeEnabled: input.welcomeEnabled ?? cur.welcomeEnabled,
    welcomeMessages: input.welcomeMessages !== undefined ? cleanMessages(input.welcomeMessages) : cur.welcomeMessages,
    // welcomeBaselined/welcomeSeen are scheduler-owned; preserve them so toggling welcome off/on
    // doesn't re-welcome everyone who joined while it was off (baseline is seeded on first run).
    welcomeBaselined: cur.welcomeBaselined,
    welcomeSeen: cur.welcomeSeen,
  })
  writeSchedule(id, next)
  return next
}

function record(id: string, status: BroadcastStatus, message: string, nextIndex?: number): void {
  const cur = readSchedule(id)
  const now = new Date().toISOString()
  writeSchedule(id, {
    ...cur,
    lastCheckAt: now,
    lastStatus: status,
    lastMessage: message,
    lastRunAt: status === 'ok' ? now : cur.lastRunAt,
    nextIndex: nextIndex ?? cur.nextIndex,
  })
}

// Strip to printable ASCII — non-ASCII (emoji/non-Latin) has hung RCON broadcast for ~10s.
const toAscii = (s: string): string => s.replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, ' ').trim()

const running = new Map<string, boolean>()

// Send the next scheduled message for an instance. `force` (Test) bypasses skip-when-empty.
export async function runBroadcast(id: string = DEFAULT_INSTANCE_ID, opts: { force?: boolean } = {}): Promise<BroadcastSchedule> {
  if (running.get(id)) return readSchedule(id)
  running.set(id, true)
  try {
    await runWithInstance(id, async () => {
      const s = readSchedule(id)
      if (!s.messages.length) {
        record(id, 'error', 'No messages configured')
        return
      }
      if (!opts.force && s.skipWhenEmpty) {
        const m = await getServerMetrics()
        // Skip only when we KNOW nobody's on (down, or a real 0); unknown count still sends.
        if (!m.up || m.players === 0) {
          record(id, 'skipped-empty', m.up ? 'No players online' : 'Server offline')
          return
        }
      }
      const rcon = getRconConfig(id)
      if (!rcon) {
        record(id, 'error', 'RCON not configured')
        return
      }
      const idx = s.nextIndex % s.messages.length
      const raw = s.prefix ? `${s.prefix} ${s.messages[idx]}` : s.messages[idx]
      const ascii = toAscii(raw)
      if (!ascii) {
        record(id, 'error', 'Message empty after sanitizing', (idx + 1) % s.messages.length)
        return
      }
      // pgbroadcast (PalDefender) keeps spaces; vanilla Broadcast truncates at the first space.
      const pd = await readPalDefenderState().catch(() => ({ enabled: false }))
      const cmd = pd.enabled ? `pgbroadcast ${ascii}` : `Broadcast ${ascii.replace(/ /g, '_')}`
      await runRcon(rcon, cmd)
      record(id, 'ok', `Sent: ${s.messages[idx]}`, (idx + 1) % s.messages.length)
    })
  } catch (err) {
    record(id, 'error', err instanceof Error ? err.message : 'Broadcast failed')
  } finally {
    running.set(id, false)
  }
  return readSchedule(id)
}

// Send one already-composed line via RCON (pgbroadcast keeps spaces; vanilla Broadcast
// truncates at the first space, so spaces → underscores). Returns the sanitized text, or ''
// if it was empty after stripping non-ASCII.
async function sendViaRcon(rcon: NonNullable<ReturnType<typeof getRconConfig>>, text: string): Promise<string> {
  const ascii = toAscii(text)
  if (!ascii) return ''
  const pd = await readPalDefenderState().catch(() => ({ enabled: false }))
  await runRcon(rcon, pd.enabled ? `pgbroadcast ${ascii}` : `Broadcast ${ascii.replace(/ /g, '_')}`)
  return ascii
}

const welcoming = new Map<string, boolean>()

// Parse join lines (both log shapes) out of a chat-log tail into `ts|name` signatures.
function parseJoins(log: string): { sig: string; name: string }[] {
  const out: { sig: string; name: string }[] = []
  for (const raw of log.split('\n')) {
    const line = raw.trim()
    for (const re of JOIN_RES) {
      const m = re.exec(line)
      if (m) {
        const name = m[2]!.trim()
        out.push({ sig: `${m[1]!.trim()}|${name}`, name })
        break
      }
    }
  }
  return out
}

// On-join welcome: detect new joins from the game log and broadcast the welcome messages once
// per new player. Event-driven (runs every tick regardless of the interval). Dedup is by a
// bounded set of `ts|name` signatures rather than a timestamp cursor, because the log tail
// slides and PalDefender's timestamps are time-only (no date → not globally sortable). The
// FIRST run just seeds the baseline from the current tail without sending, so enabling welcome
// doesn't spam everyone already connected. {name} in a message is replaced with the joiner.
async function runWelcome(id: string): Promise<void> {
  if (welcoming.get(id)) return
  welcoming.set(id, true)
  try {
    await runWithInstance(id, async () => {
      const s = readSchedule(id)
      if (!s.welcomeEnabled || !s.welcomeMessages.length) return
      let log = ''
      try {
        log = await readChatLog()
      } catch {
        return // no readable log source (welcome needs the file-based chat log)
      }
      if (!log) return

      const joins = parseJoins(log)

      // First activation → seed baseline (mark current joins seen), don't welcome the backlog.
      if (!s.welcomeBaselined) {
        const seed = [...new Set(joins.map((j) => j.sig))].slice(-WELCOME_SEEN_CAP)
        writeSchedule(id, { ...readSchedule(id), welcomeBaselined: true, welcomeSeen: seed })
        return
      }

      const seen = new Set(s.welcomeSeen)
      const fresh = joins.filter((j) => !seen.has(j.sig))
      if (!fresh.length) return

      const rcon = getRconConfig(id)
      if (!rcon) return
      let lastMsg = ''
      for (const j of fresh) {
        for (const tmpl of s.welcomeMessages) {
          const line = (s.prefix ? `${s.prefix} ${tmpl}` : tmpl).replace(/\{name\}/gi, j.name)
          const sent = await sendViaRcon(rcon, line)
          if (sent) lastMsg = sent
        }
        seen.add(j.sig)
      }
      const cur = readSchedule(id)
      writeSchedule(id, {
        ...cur,
        welcomeSeen: [...seen].slice(-WELCOME_SEEN_CAP),
        welcomeLastAt: new Date().toISOString(),
        welcomeLastMessage: lastMsg || cur.welcomeLastMessage,
      })
    })
  } catch {
    /* best-effort — welcome never blocks the interval broadcaster */
  } finally {
    welcoming.set(id, false)
  }
}

let started = false

async function tick(): Promise<void> {
  for (const inst of listInstances()) {
    const s = readSchedule(inst.id)
    if (s.enabled && s.messages.length) {
      const due = !s.lastRunAt || Date.now() - Date.parse(s.lastRunAt) >= s.intervalMinutes * 60_000
      if (due) await runBroadcast(inst.id)
    }
    if (s.welcomeEnabled && s.welcomeMessages.length) await runWelcome(inst.id)
  }
}

// Idempotent: called once from instrumentation register() on boot. Polls each minute and
// fires per instance when due (from persisted lastRunAt, so it survives restarts).
export function startBroadcastScheduler(): void {
  if (started) return
  started = true
  setInterval(() => {
    void tick()
  }, 60_000)
}
