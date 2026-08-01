// PATCH (not upstream): Engine.ini tuning model (docs/specs/engine-tuning-spec.md).
//
// CORRECTION to the earlier "performance presets": those wrongly wrote
// PalWorldSettings.ini world settings. The presets actually manage
// Pal/Saved/Config/WindowsServer/Engine.ini -- Unreal engine/network tuning --
// a completely different file and format.
//
// This is NOT the PalWorldSettings tokenizer. That file is one giant
// single-line OptionSettings=(...) tuple; Engine.ini is a normal line-based
// sectioned INI. The two share nothing, and reusing the tuple parser here would
// be wrong.
//
// Pre-flight against the production file (2026-07-21): it exists, is STOCK
// (none of our managed keys present), holds exactly one section -- [Core.System]
// with 71 `Paths=` lines -- and is uniformly CRLF. The [Core.System] section is
// NOT ours and must survive every write byte-for-byte, including its repeated
// `Paths=` keys (duplicate keys are legal INI; never dedupe/reorder/collapse).
// So the writer preserves the file's exact line terminator and every
// non-managed line verbatim, and touches only the managed keys/sections below.

// --- managed sections ---
export const SECTION_NET = '/Script/OnlineSubsystemUtils.IpNetDriver'
export const SECTION_ENGINE = '/Script/Engine.Engine'
export const SECTION_GC = '/Script/Engine.GarbageCollectionSettings'

// Every section this panel is allowed to create/edit/remove. Anything else in
// the file (notably [Core.System]) is off-limits and copied verbatim.
export const MANAGED_SECTIONS = [SECTION_NET, SECTION_ENGINE, SECTION_GC] as const

export type EngineFieldKind = 'int' | 'float' | 'bool'
export type EngineGroup = 'network' | 'framerate' | 'memory'

export type EngineField = {
  key: string
  section: string
  kind: EngineFieldKind
  group: EngineGroup
  label: string
  description?: string
  // Slider bounds where a slider makes sense (spec §5: same slider+number
  // pattern as world settings).
  min?: number
  max?: number
  step?: number
  // Per-field warning from the reference, reworded (spec §3).
  warning?: string
}

// Order here is the order fields render AND the order managed keys are written
// within their section.
export const ENGINE_FIELDS: EngineField[] = [
  {
    key: 'NetServerMaxTickRate',
    section: SECTION_NET,
    kind: 'int',
    group: 'network',
    label: 'Server tick rate',
    description: 'Server simulation updates per second. The single biggest lever — and the biggest CPU cost.',
    min: 30,
    max: 120,
    step: 5,
    warning: 'Above 120 is not recommended; below 50 hurts game feel. A CPU that cannot hold the tick makes things worse, not better.',
  },
  {
    key: 'MaxClientRate',
    section: SECTION_NET,
    kind: 'int',
    group: 'network',
    label: 'Per-player bandwidth cap',
    description: 'Max bytes/sec to each player. Total upload ≈ this × online players.',
    min: 15000,
    max: 200000,
    step: 5000,
    warning: 'Total upload ≈ per-player cap × online players. Exceeding your real upload capacity lags everyone.',
  },
  {
    key: 'MaxInternetClientRate',
    section: SECTION_NET,
    kind: 'int',
    group: 'network',
    label: 'Per-player bandwidth cap (internet)',
    description: 'Same cap for non-LAN players.',
    min: 10000,
    max: 200000,
    step: 5000,
  },
  {
    key: 'ConnectionTimeout',
    section: SECTION_NET,
    kind: 'float',
    group: 'network',
    label: 'Connection timeout (s)',
    min: 30,
    max: 240,
    step: 5,
  },
  {
    key: 'InitialConnectTimeout',
    section: SECTION_NET,
    kind: 'float',
    group: 'network',
    label: 'Initial connect timeout (s)',
    min: 30,
    max: 240,
    step: 5,
  },
  {
    key: 'bUseFixedFrameRate',
    section: SECTION_ENGINE,
    kind: 'bool',
    group: 'framerate',
    label: 'Use fixed frame rate',
    description: 'Pins the server to a fixed simulation rate.',
    warning: 'Fixed frame rate interacts with tick and can slow simulation on weak hardware.',
  },
  {
    key: 'FixedFrameRate',
    section: SECTION_ENGINE,
    kind: 'float',
    group: 'framerate',
    label: 'Fixed frame rate',
    description: 'Only meaningful when "Use fixed frame rate" is on. Usually equals the tick rate.',
    min: 30,
    max: 120,
    step: 5,
  },
  {
    key: 'bSmoothFrameRate',
    section: SECTION_ENGINE,
    kind: 'bool',
    group: 'framerate',
    label: 'Smooth frame rate',
    description: 'Smooths frame pacing.',
  },
  {
    key: 'gc.TimeBetweenPurgingPendingKillObjects',
    section: SECTION_GC,
    kind: 'int',
    group: 'memory',
    label: 'GC interval (s)',
    description: 'Seconds between garbage-collection sweeps of destroyed objects. Lower = more frequent, steadier memory, slightly more CPU.',
    min: 10,
    max: 120,
    step: 5,
  },
]

export const ENGINE_FIELD_BY_KEY: Record<string, EngineField> = Object.fromEntries(
  ENGINE_FIELDS.map((field) => [field.key, field]),
)

const MANAGED_KEYS_BY_SECTION: Record<string, string[]> = ENGINE_FIELDS.reduce(
  (acc, field) => {
    ;(acc[field.section] ??= []).push(field.key)
    return acc
  },
  {} as Record<string, string[]>,
)

// The read-only launch-flag display now sources real state from the game .env
// (MULTITHREADING / COMMUNITY) -- see lib/engine-launch.ts. The former static
// LAUNCH_FLAGS/LAUNCH_FLAGS_NOTE placeholders lived here.

export type EngineValue = number | boolean
export type EngineValues = Record<string, EngineValue>

// --- value formatting (match the observed file exactly, spec §1) ---
// timeouts + FixedFrameRate -> 60.000000 ; bools -> True/False ;
// tick, client rates, gc interval -> bare integers.
export function formatEngineValue(field: EngineField, value: EngineValue): string {
  switch (field.kind) {
    case 'bool':
      return value ? 'True' : 'False'
    case 'float':
      return Number(value).toFixed(6)
    case 'int':
    default:
      return String(Math.round(Number(value)))
  }
}

function parseEngineValue(field: EngineField, raw: string): EngineValue {
  const trimmed = raw.trim()
  if (field.kind === 'bool') return /^true$/i.test(trimmed) || trimmed === '1'
  const n = Number(trimmed)
  return Number.isFinite(n) ? n : 0
}

// --- presets (spec §2) ---
// Balanced / High performance are explicit value maps. "Game defaults" is NOT a
// value map: it REMOVES every managed key so the engine falls back to built-ins.
// The built-in column is display-only, captured here for the UI.
export type PresetId = 'default' | 'balanced' | 'performance'

export const BUILTIN_DISPLAY_VALUES: EngineValues = {
  NetServerMaxTickRate: 30,
  MaxClientRate: 15000,
  MaxInternetClientRate: 10000,
  ConnectionTimeout: 60,
  InitialConnectTimeout: 60,
  bUseFixedFrameRate: false,
  FixedFrameRate: 30,
  bSmoothFrameRate: false,
  'gc.TimeBetweenPurgingPendingKillObjects': 60,
}

export const PRESET_VALUES: Record<'balanced' | 'performance', EngineValues> = {
  balanced: {
    NetServerMaxTickRate: 60,
    MaxClientRate: 100000,
    MaxInternetClientRate: 100000,
    ConnectionTimeout: 60,
    InitialConnectTimeout: 60,
    bUseFixedFrameRate: false,
    FixedFrameRate: 60,
    bSmoothFrameRate: true,
    'gc.TimeBetweenPurgingPendingKillObjects': 60,
  },
  performance: {
    NetServerMaxTickRate: 90,
    MaxClientRate: 150000,
    MaxInternetClientRate: 150000,
    ConnectionTimeout: 60,
    InitialConnectTimeout: 60,
    bUseFixedFrameRate: true,
    FixedFrameRate: 90,
    bSmoothFrameRate: true,
    'gc.TimeBetweenPurgingPendingKillObjects': 30,
  },
}

export type PresetMeta = { id: PresetId; name: string; recommended?: boolean; blurb: string }

export const ENGINE_PRESETS: PresetMeta[] = [
  {
    id: 'default',
    name: 'Game defaults',
    blurb:
      'Clears everything this panel manages so the server falls back to built-in engine defaults (30 tick). The safe baseline — and the undo button if tuning made things worse.',
  },
  {
    id: 'balanced',
    name: 'Balanced',
    recommended: true,
    blurb:
      'The community-standard tune: 60 tick, roomier bandwidth caps, smoothed frame pacing. Noticeably smoother for most servers at modest CPU cost.',
  },
  {
    id: 'performance',
    name: 'High performance',
    blurb:
      '90 tick with fixed + smoothed frame pacing and faster garbage collection. For strong single-core CPUs and few players. Watch server FPS after applying — a CPU that can’t hold the tick makes this worse than Balanced, not better.',
  },
]

function valuesEqual(field: EngineField, a: EngineValue, b: EngineValue): boolean {
  if (field.kind === 'bool') return Boolean(a) === Boolean(b)
  return Number(a) === Number(b)
}

// Which preset the CURRENT DISK state matches, or 'custom' (spec §4.4/§5).
// diskValues holds only the managed keys actually present in the file.
export function detectPreset(diskValues: EngineValues): PresetId | 'custom' {
  const presentKeys = Object.keys(diskValues)
  // Game defaults == no managed keys present at all.
  if (presentKeys.length === 0) return 'default'
  // Any preset match requires all nine managed keys present and equal.
  for (const id of ['balanced', 'performance'] as const) {
    const target = PRESET_VALUES[id]
    const matches = ENGINE_FIELDS.every((field) => {
      if (!(field.key in diskValues)) return false
      return valuesEqual(field, diskValues[field.key], target[field.key])
    })
    if (matches) return id
  }
  return 'custom'
}

// ---------------------------------------------------------------------------
// Reading and writing Engine.ini, byte-preserving.
// ---------------------------------------------------------------------------

type ParsedIni = {
  eol: string
  trailingEol: boolean
  lines: string[] // logical lines, terminators stripped
}

// Preserve the file's exact terminator (CRLF on the production file) and
// whether it ends in one, so a round-trip is byte-identical.
function splitIni(raw: string): ParsedIni {
  // Default a NEW/empty file to CRLF: this is a Windows dedicated-server INI and
  // the game writes CRLF, so a file we create for the "missing" state (spec §1)
  // should match. An existing file's own terminator always wins.
  const eol = raw === '' ? '\r\n' : raw.includes('\r\n') ? '\r\n' : '\n'
  if (raw === '') return { eol, trailingEol: false, lines: [] }
  const trailingEol = raw.endsWith(eol)
  const body = trailingEol ? raw.slice(0, -eol.length) : raw
  return { eol, trailingEol, lines: body.split(eol) }
}

function joinIni(parsed: ParsedIni): string {
  const joined = parsed.lines.join(parsed.eol)
  return parsed.trailingEol ? joined + parsed.eol : joined
}

function sectionHeader(line: string): string | null {
  const m = line.match(/^\s*\[(.+)\]\s*$/)
  return m ? m[1] : null
}

// A `key=value` line whose key (trimmed) equals `key`.
function isKeyLine(line: string, key: string): boolean {
  const eq = line.indexOf('=')
  return eq !== -1 && line.slice(0, eq).trim() === key
}

// Read the managed keys currently present. Only keys inside their OWN managed
// section count -- a stray `FixedFrameRate=` under [Core.System] is not ours.
export function parseEngineIni(raw: string): EngineValues {
  const { lines } = splitIni(raw)
  const values: EngineValues = {}
  let current: string | null = null
  for (const line of lines) {
    const header = sectionHeader(line)
    if (header !== null) {
      current = header
      continue
    }
    if (current === null) continue
    const managedKeys = MANAGED_KEYS_BY_SECTION[current]
    if (!managedKeys) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    const field = ENGINE_FIELD_BY_KEY[key]
    if (field && field.section === current) {
      values[key] = parseEngineValue(field, line.slice(eq + 1))
    }
  }
  return values
}

export type WriteOp =
  | { type: 'reset' } // Game defaults: remove every managed key/section
  | { type: 'write'; values: EngineValues } // Balanced / High / Custom

// Rewrite Engine.ini applying `op`, preserving every non-managed line and the
// file's terminator exactly. Managed sections are created only when needed and
// removed when they end up empty.
export function writeEngineIni(raw: string, op: WriteOp): string {
  const parsed = splitIni(raw)

  // desired[section] = ordered [key, formattedValue] to be PRESENT. Empty/absent
  // section => that section should carry none of our keys.
  const desired: Record<string, [string, string][]> = {}
  if (op.type === 'write') {
    for (const field of ENGINE_FIELDS) {
      const value = op.values[field.key]
      if (value === undefined) continue
      ;(desired[field.section] ??= []).push([field.key, formatEngineValue(field, value)])
    }
  }

  const managedSectionSet = new Set<string>(MANAGED_SECTIONS)
  const out: string[] = []
  const placedSections = new Set<string>()

  let i = 0
  while (i < parsed.lines.length) {
    const line = parsed.lines[i]
    const header = sectionHeader(line)

    if (header === null || !managedSectionSet.has(header)) {
      // Preamble line or a non-managed section header: copy verbatim.
      out.push(line)
      i++
      continue
    }

    // A managed section. Gather its body (until the next header or EOF).
    const bodyStart = i + 1
    let j = bodyStart
    while (j < parsed.lines.length && sectionHeader(parsed.lines[j]) === null) j++
    const body = parsed.lines.slice(bodyStart, j)
    i = j
    placedSections.add(header)

    const managedKeys = new Set(MANAGED_KEYS_BY_SECTION[header] ?? [])
    // Keep any line that is NOT one of our managed keys: comments, blanks, and
    // crucially any non-managed key some operator added to this section.
    const survivingBody = body.filter(
      (bodyLine) => ![...managedKeys].some((key) => isKeyLine(bodyLine, key)),
    )
    const desiredKeys = desired[header] ?? []

    // Drop a managed section that would be left with no managed keys AND no
    // other meaningful content (spec §2: defaults removes the section).
    const survivingIsBlankOnly = survivingBody.every((l) => l.trim() === '')
    if (desiredKeys.length === 0 && survivingIsBlankOnly) {
      continue
    }

    out.push(line) // the section header
    for (const [key, value] of desiredKeys) out.push(`${key}=${value}`)
    for (const bodyLine of survivingBody) out.push(bodyLine)
  }

  // Append managed sections that need keys but did not exist in the file.
  for (const section of MANAGED_SECTIONS) {
    if (placedSections.has(section)) continue
    const desiredKeys = desired[section]
    if (!desiredKeys || desiredKeys.length === 0) continue
    // Separate from prior content with one blank line, unless the file already
    // ends on a blank (the production file's trailing empty line does).
    if (out.length > 0 && out[out.length - 1].trim() !== '') out.push('')
    out.push(`[${section}]`)
    for (const [key, value] of desiredKeys) out.push(`${key}=${value}`)
  }

  return joinIni({ ...parsed, lines: out })
}

// Convenience for the API: turn a UI intent into a WriteOp.
export function writeOpFor(presetOrValues: 'default' | EngineValues): WriteOp {
  return presetOrValues === 'default' ? { type: 'reset' } : { type: 'write', values: presetOrValues }
}
