// PATCH (not upstream): witty player-death announcements. PalDefender already logs every player
// death WITH CAUSE (logPlayerDeaths) to its own Pal/Binaries/Win64/PalDefender/Logs/<session>.log
// — e.g. `[HH:MM:SS][info] 'Name' (UserId=…, IP=…) died to extreme body temperature.`. This
// tails the newest such log, classifies the cause, and broadcasts an operator-editable witty
// line via RCON (pgbroadcast). Keep PalDefender's own `announcePlayerDeaths` OFF so the wording
// isn't duplicated. Same in-process, per-instance, signature-dedup, baseline-on-enable model as
// the on-join welcome (lib/broadcast-schedule).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { open, readdir, readFile, stat } from 'node:fs/promises'
import { Buffer } from 'node:buffer'
import { dirname, join } from 'node:path'
import { getRconConfig, runRcon } from '@/lib/rcon-exec'
import { readPalDefenderState } from '@/lib/game-mods'
import { friendlyPalName } from '@/lib/pal-names'
import { DEFAULT_INSTANCE_ID, currentGameDir, listInstances, runWithInstance } from '@/lib/instances'

// Cause categories we classify PalDefender's death phrasings into. {name} = victim everywhere;
// {killer} for killedBy/towerBoss; {pal} for wildPal.
export const DEATH_CAUSES = [
  'wildPal',
  'killedBy',
  'towerBoss',
  'temperature',
  'poison',
  'explosion',
  'noAttacker',
  'unknown',
] as const
export type DeathCause = (typeof DEATH_CAUSES)[number]

export const CAUSE_LABELS: Record<DeathCause, string> = {
  wildPal: 'Killed by a wild Pal ({pal})',
  killedBy: 'Killed by someone ({killer})',
  towerBoss: 'Killed by a tower boss ({killer})',
  temperature: 'Extreme temperature (cold/heat)',
  poison: 'Poison',
  explosion: 'Explosion',
  noAttacker: 'Died with no attacker (fall/self)',
  unknown: 'Unknown cause',
}

export const DEFAULT_TEMPLATES: Record<DeathCause, string[]> = {
  wildPal: [
    '{name} was cut down by a wild {pal}. Nature 1, {name} 0.',
    'A wild {pal} added {name} to its trophy shelf.',
    '{name} tried to befriend a wild {pal}. It declined.',
  ],
  killedBy: [
    '{killer} sent {name} back to the respawn screen.',
    '{name} got folded by {killer}.',
    '{killer} politely uninstalled {name} from the world.',
  ],
  towerBoss: [
    '{name} got flattened by {killer} in the tower. Bosses: still undefeated.',
    'The tower boss {killer} made an example of {name}.',
  ],
  temperature: [
    '{name} forgot a coat and became a popsicle.',
    '{name} lost a fight with the weather.',
    'The elements claimed {name}. Pack layers next time.',
  ],
  poison: [
    '{name} really should have packed antidotes.',
    '{name} found out which berries were the bad berries.',
  ],
  explosion: [
    '{name} died with a bang. Literally.',
    '{name} found out what that red barrel does.',
  ],
  noAttacker: [
    '{name} died with no one swinging. Gravity, probably.',
    '{name} found the ground the hard way.',
  ],
  unknown: [
    '{name} died under mysterious circumstances.',
    'Something got {name}. We may never know what.',
  ],
}

export type DeathSchedule = {
  enabled: boolean
  prefix: string
  templates: Record<DeathCause, string[]>
  baselined: boolean // scheduler-owned: seeded from the current log once
  seen: string[] // scheduler-owned: recent `ts|name|phrase` signatures already announced
  lastAt: string | null
  lastMessage: string | null
}

function scheduleFile(id: string): string {
  if (id === DEFAULT_INSTANCE_ID) return process.env.DEATH_ANNOUNCE_FILE ?? './data/death-announce.json'
  return `./data/death-announce.${id}.json`
}

const MAX_TEMPLATES_PER_CAUSE = 20
const MAX_TEMPLATE_LEN = 200
const SEEN_CAP = 300
const PD_LOG_TAIL_BYTES = 256 * 1024

function cleanTemplates(v: unknown): Record<DeathCause, string[]> {
  const src = (v && typeof v === 'object' ? (v as Record<string, unknown>) : {}) as Record<string, unknown>
  const out = {} as Record<DeathCause, string[]>
  for (const cause of DEATH_CAUSES) {
    const raw = src[cause]
    const list = Array.isArray(raw)
      ? raw
          .map((m) => (typeof m === 'string' ? m.trim() : ''))
          .filter(Boolean)
          .slice(0, MAX_TEMPLATES_PER_CAUSE)
          .map((m) => m.slice(0, MAX_TEMPLATE_LEN))
      : []
    // Fall back to the built-in witty defaults for any category the operator cleared/omitted.
    out[cause] = list.length ? list : [...DEFAULT_TEMPLATES[cause]]
  }
  return out
}

function normalize(s: Partial<DeathSchedule>): DeathSchedule {
  return {
    enabled: Boolean(s.enabled),
    prefix: typeof s.prefix === 'string' ? s.prefix.trim().slice(0, 40) : '',
    templates: cleanTemplates(s.templates),
    baselined: Boolean(s.baselined),
    seen: Array.isArray(s.seen) ? s.seen.filter((x): x is string => typeof x === 'string').slice(-SEEN_CAP) : [],
    lastAt: s.lastAt ?? null,
    lastMessage: s.lastMessage ?? null,
  }
}

export function readDeathSchedule(id: string = DEFAULT_INSTANCE_ID): DeathSchedule {
  try {
    const f = scheduleFile(id)
    if (existsSync(f)) return normalize(JSON.parse(readFileSync(f, 'utf8')) as Partial<DeathSchedule>)
  } catch {
    /* fall through to defaults */
  }
  return normalize({})
}

function writeDeathSchedule(id: string, s: DeathSchedule): void {
  const f = scheduleFile(id)
  mkdirSync(dirname(f), { recursive: true })
  const tmp = `${f}.tmp`
  writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 })
  renameSync(tmp, f)
}

// Operator settings only; baselined/seen/last* are scheduler-owned and preserved.
export function saveDeathSettings(id: string, input: Partial<DeathSchedule>): DeathSchedule {
  const cur = readDeathSchedule(id)
  const next = normalize({
    ...cur,
    enabled: input.enabled ?? cur.enabled,
    prefix: input.prefix ?? cur.prefix,
    templates: input.templates !== undefined ? input.templates : cur.templates,
    baselined: cur.baselined,
    seen: cur.seen,
  })
  writeDeathSchedule(id, next)
  return next
}

// Strip to printable ASCII — non-ASCII (emoji/non-Latin) has hung RCON broadcast for ~10s.
const toAscii = (s: string): string => s.replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, ' ').trim()

async function sendViaRcon(rcon: NonNullable<ReturnType<typeof getRconConfig>>, text: string): Promise<string> {
  const ascii = toAscii(text)
  if (!ascii) return ''
  const pd = await readPalDefenderState().catch(() => ({ enabled: false }))
  await runRcon(rcon, pd.enabled ? `pgbroadcast ${ascii}` : `Broadcast ${ascii.replace(/ /g, '_')}`)
  return ascii
}

// PalDefender rotates its log per session (one file per boot). Resolve the newest .log by mtime.
async function newestPdLog(): Promise<string | null> {
  const dir = join(currentGameDir(), 'Pal', 'Binaries', 'Win64', 'PalDefender', 'Logs')
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return null
  }
  let best: { p: string; m: number } | null = null
  for (const e of entries) {
    if (!e.toLowerCase().endsWith('.log')) continue
    const p = join(dir, e)
    try {
      const st = await stat(p)
      if (st.isFile() && (!best || st.mtimeMs > best.m)) best = { p, m: st.mtimeMs }
    } catch {
      /* skip */
    }
  }
  return best ? best.p : null
}

async function readTail(path: string, limit: number): Promise<string> {
  const info = await stat(path)
  if (info.size <= limit) return readFile(path, 'utf8')
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(limit)
    const { bytesRead } = await handle.read(buffer, 0, limit, info.size - limit)
    const text = buffer.toString('utf8', 0, bytesRead)
    const nl = text.indexOf('\n')
    return nl >= 0 ? text.slice(nl + 1) : text
  } finally {
    await handle.close()
  }
}

// A PalDefender death line: `[HH:MM:SS][info] 'Name' (UserId=…, IP=…) <phrase>.`
const DEATH_LINE_RE = /^\[([^\]]+)\]\[info\]\s+'([^']+)'\s+\(UserId=[^)]*\)\s+(.+?)\.?\s*$/

type ParsedDeath = { sig: string; name: string; cause: DeathCause; killer?: string; pal?: string }

// Names appear quoted with an internal id in the real log: 'Sheepball' (ID: Sheepball). Strip the
// quotes + (ID: …) and normalise a multi-killer "and" join. NOTE: Pal names are the game's
// INTERNAL names — Lamball logs as "Sheepball", Cattiva as "PinkCat", etc. A friendly-name map
// would need an operator-supplied Pal dataset (clean-room: we ship none), so {pal} shows the
// internal name until data/pals.json is populated (see the internal-name follow-up).
function cleanNames(s: string): string {
  return s
    .replace(/\(ID:[^)]*\)/gi, '')
    .replace(/'/g, '')
    .replace(/\s+and\s+/gi, ' & ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Match the real PalDefender phrasings, which wrap names in quotes+(ID:…) and add "was "/"has
// been " prefixes the base format strings don't show. Regexes are unanchored + tolerant.
function classify(phrase: string): { cause: DeathCause; killer?: string; pal?: string } | null {
  let m: RegExpExecArray | null
  // "(was) attacked by a wild 'Pal' (ID: Pal) and died"
  if ((m = /attacked by a wild (.+?) and died/i.exec(phrase))) return { cause: 'wildPal', pal: cleanNames(m[1]!) }
  // "(got) killed by X [and Y] in a tower boss battle"
  if ((m = /killed by (.+?) in a tower boss battle/i.exec(phrase))) return { cause: 'towerBoss', killer: cleanNames(m[1]!) }
  // "(has been|was) killed by X" — but NOT "killed from an unknown attack"
  if (!/unknown/i.test(phrase) && (m = /killed by (.+?)\.?\s*$/i.exec(phrase))) return { cause: 'killedBy', killer: cleanNames(m[1]!) }
  if (/extreme body temperature/i.test(phrase)) return { cause: 'temperature' }
  if (/poison/i.test(phrase)) return { cause: 'poison' }
  if (/with a bang/i.test(phrase)) return { cause: 'explosion' }
  if (/without being attacked/i.test(phrase)) return { cause: 'noAttacker' }
  // "died due to an unknown reason", "was killed from an unknown attack", "invalid player", etc.
  if (/died|killed/i.test(phrase)) return { cause: 'unknown' }
  return null // not a death line
}

function parseDeaths(log: string): ParsedDeath[] {
  const out: ParsedDeath[] = []
  for (const raw of log.split('\n')) {
    const line = raw.trim()
    const m = DEATH_LINE_RE.exec(line)
    if (!m) continue
    const phrase = m[3]!.trim()
    const c = classify(phrase)
    if (!c) continue
    out.push({ sig: `${m[1]!.trim()}|${m[2]!.trim()}|${phrase}`, name: m[2]!.trim(), ...c })
  }
  return out
}

// Optional per-pal wild-Pal messages, operator-supplied at
// <DASHBOARD_DATA_DIR>/death-pal-messages.json: { "<friendly Pal name>": ["{name} …", …] }.
// When the killing Pal has its own lines they win over the generic wildPal templates; keyed
// lowercased since names are matched after friendlyPalName(). Clean-room: shipped empty/absent.
const PAL_MESSAGES_FILE = join(process.env.DASHBOARD_DATA_DIR ?? './data', 'death-pal-messages.json')
const ELEMENTAL_SUFFIX = / (noct|cryst|ignis|terra|lux|aqua)$/
let palMsgCache: Map<string, string[]> | null = null

async function loadPalMessages(): Promise<Map<string, string[]>> {
  if (palMsgCache) return palMsgCache
  const m = new Map<string, string[]>()
  try {
    const obj = JSON.parse(await readFile(PAL_MESSAGES_FILE, 'utf8')) as Record<string, unknown>
    for (const [k, v] of Object.entries(obj)) {
      if (Array.isArray(v)) {
        const lines = v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim().slice(0, MAX_TEMPLATE_LEN))
        if (lines.length) m.set(k.toLowerCase(), lines)
      }
    }
  } catch {
    /* absent/unreadable → no per-pal overrides; wildPal uses the generic templates */
  }
  palMsgCache = m
  return m
}

// Raw per-pal file text for the editor — pretty-printed if valid JSON, '{}' when absent.
export async function readPalMessagesRaw(): Promise<string> {
  try {
    const raw = await readFile(PAL_MESSAGES_FILE, 'utf8')
    try {
      return JSON.stringify(JSON.parse(raw), null, 2)
    } catch {
      return raw // keep a syntactically-broken file visible so the operator can fix it
    }
  } catch {
    return '{}'
  }
}

// Validate + write the per-pal file (atomic temp+rename). Throws on invalid structure. Returns
// a small summary and clears the in-process cache so the next tick reloads. Shape:
// { "<friendly Pal name>": ["{name} …", …] }.
export function writePalMessages(text: string): { pals: number; lines: number } {
  let obj: unknown
  try {
    obj = JSON.parse(text)
  } catch (e) {
    throw new Error(`Invalid JSON: ${e instanceof Error ? e.message : 'parse error'}`)
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('Top level must be an object of "Pal name": ["line", …]')
  }
  const clean: Record<string, string[]> = {}
  let lines = 0
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (!Array.isArray(v)) throw new Error(`"${k}" must be an array of strings`)
    const arr = v
      .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
      .map((x) => x.trim().slice(0, MAX_TEMPLATE_LEN))
      .slice(0, MAX_TEMPLATES_PER_CAUSE)
    if (arr.length) {
      clean[k] = arr
      lines += arr.length
    }
  }
  mkdirSync(dirname(PAL_MESSAGES_FILE), { recursive: true })
  const tmp = `${PAL_MESSAGES_FILE}.tmp`
  writeFileSync(tmp, JSON.stringify(clean, null, 2), { mode: 0o600 })
  renameSync(tmp, PAL_MESSAGES_FILE)
  palMsgCache = null
  return { pals: Object.keys(clean).length, lines }
}

// Pick a template for the cause and fill placeholders. `pick` is injectable for testing; a
// per-pal override map (from loadPalMessages) supplies pal-specific wildPal lines when present.
export function renderDeath(
  d: ParsedDeath,
  templates: Record<DeathCause, string[]>,
  prefix: string,
  pick: (n: number) => number = (n) => Math.floor(Math.random() * n),
  perPal?: Map<string, string[]>,
): string {
  let list = templates[d.cause]?.length ? templates[d.cause] : DEFAULT_TEMPLATES[d.cause]
  if (d.cause === 'wildPal' && d.pal && perPal && perPal.size) {
    const k = d.pal.toLowerCase()
    const palLines = perPal.get(k) ?? perPal.get(k.replace(ELEMENTAL_SUFFIX, ''))
    if (palLines && palLines.length) list = palLines
  }
  const tmpl = list[pick(list.length)] ?? list[0]!
  const body = tmpl
    .replace(/\{name\}/gi, d.name)
    .replace(/\{killer\}/gi, d.killer ?? 'something')
    .replace(/\{pal\}/gi, d.pal ?? 'wild Pal')
  return prefix ? `${prefix} ${body}` : body
}

const running = new Map<string, boolean>()

async function runDeath(id: string): Promise<void> {
  if (running.get(id)) return
  running.set(id, true)
  try {
    await runWithInstance(id, async () => {
      const s = readDeathSchedule(id)
      if (!s.enabled) return
      const path = await newestPdLog()
      if (!path) return
      let log = ''
      try {
        log = await readTail(path, PD_LOG_TAIL_BYTES)
      } catch {
        return
      }
      const deaths = parseDeaths(log)

      // First run → seed baseline (mark current deaths seen), don't announce the backlog.
      if (!s.baselined) {
        const seed = [...new Set(deaths.map((d) => d.sig))].slice(-SEEN_CAP)
        writeDeathSchedule(id, { ...readDeathSchedule(id), baselined: true, seen: seed })
        return
      }

      const seen = new Set(s.seen)
      const fresh = deaths.filter((d) => !seen.has(d.sig))
      if (!fresh.length) return

      const rcon = getRconConfig(id)
      if (!rcon) return
      const perPal = await loadPalMessages()
      let lastMsg = ''
      for (const d of fresh) {
        // Map the game's internal names to friendly ones (Sheepball → Lamball) when the operator
        // has a Pal dataset; no-ops to the internal name otherwise. Single-killer only — a
        // "X & Y" tower join isn't a lookup key.
        if (d.pal) d.pal = await friendlyPalName(d.pal)
        if (d.killer && !d.killer.includes('&')) d.killer = await friendlyPalName(d.killer)
        const sent = await sendViaRcon(rcon, renderDeath(d, s.templates, s.prefix, undefined, perPal))
        if (sent) lastMsg = sent
        seen.add(d.sig)
      }
      const cur = readDeathSchedule(id)
      writeDeathSchedule(id, {
        ...cur,
        seen: [...seen].slice(-SEEN_CAP),
        lastAt: new Date().toISOString(),
        lastMessage: lastMsg || cur.lastMessage,
      })
    })
  } catch {
    /* best-effort — never let a death tick throw kill the interval */
  } finally {
    running.set(id, false)
  }
}

let started = false

// Ticks faster than the broadcast scheduler (deaths are momentary; a minute-late "X died" reads
// oddly). Reading a 256KB log tail every 20s is cheap. Started once from instrumentation.
export function startDeathAnnouncer(): void {
  if (started) return
  started = true
  setInterval(() => {
    void (async () => {
      for (const inst of listInstances()) {
        const s = readDeathSchedule(inst.id)
        if (s.enabled) await runDeath(inst.id)
      }
    })()
  }, 20_000)
}
