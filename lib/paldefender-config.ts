// PATCH (not upstream): PalDefender Config.json model (docs/specs/paldefender-
// tab-spec.md). A0 pre-flight (2026-07-22) verified against the production
// install:
//
//  - Config is the STANDALONE layout: Pal/Binaries/Win64/PalDefender/Config.json
//    (NOT the spec's assumed ue4ss/Mods path, which does not exist here).
//  - Version 1.8.3, 64 keys. Two spec keys are ABSENT in 1.8.3 and dropped from
//    the schema below: `blockTowerBossCapture` and `pvpMaxToPlayerDamage`.
//  - 45+ keys beyond the managed set must be preserved untouched.
//
// Because Config.json is JSON the mod re-reads, the writer is SURGICAL: it
// replaces only the changed managed values in the raw text and leaves every
// other byte alone. parse+stringify would reformat all 45 unknown keys and
// normalise numbers (RCONTimeout 31.0 -> 31), which "unknown keys byte-
// preserved" (acceptance #2) forbids. The result is JSON-validated before it is
// ever returned.

export type PdFieldKind = 'bool' | 'int' | 'float'
export type PdGroup = 'anticheat' | 'exploit' | 'pvp' | 'whitelist' | 'chat' | 'announce' | 'logs' | 'misc'

export type PdField = {
  key: string
  group: PdGroup
  kind: PdFieldKind
  label: string
  description?: string
  warning?: string
  danger?: boolean
  min?: number
  max?: number
  step?: number
  // Sentinel note, e.g. "0 = unlimited", "-1 = auto-detect".
  sentinel?: string
}

// Only keys VERIFIED present in 1.8.3 (A0). Anything absent there is omitted.
export const PD_FIELDS: PdField[] = [
  // --- Anti-cheat actions ---
  { key: 'shouldWarnCheaters', group: 'anticheat', kind: 'bool', label: 'Warn cheaters', description: 'Warn a player when a cheat is detected.' },
  { key: 'shouldWarnCheatersReason', group: 'anticheat', kind: 'bool', label: 'Include reason in warning', description: 'Tell the player which detection fired.' },
  { key: 'shouldKickCheaters', group: 'anticheat', kind: 'bool', label: 'Auto-kick cheaters' },
  { key: 'shouldBanCheaters', group: 'anticheat', kind: 'bool', label: 'Auto-ban cheaters' },
  {
    key: 'shouldIPBanCheaters',
    group: 'anticheat',
    kind: 'bool',
    label: 'Auto IP-ban cheaters',
    warning: 'IP bans can hit other players behind the same IP (shared households, CGNAT).',
  },

  // --- Exploit protection --- (blockTowerBossCapture ABSENT in 1.8.3 -> dropped)
  { key: 'steamidProtection', group: 'exploit', kind: 'bool', label: 'SteamID protection', description: 'Prevent duplicate-UserId logins.' },
  {
    key: 'disableIllegalItemProtection',
    group: 'exploit',
    kind: 'bool',
    label: 'Disable illegal-item protection',
    danger: true,
    warning: 'When ON, modded/debug items are NO LONGER blocked. Generally not recommended.',
  },
  { key: 'doActionUponIllegalPalStats', group: 'exploit', kind: 'bool', label: 'Fix abnormal Pal stats', description: 'Auto-correct illegal Pal stat values.' },
  {
    key: 'palStatsMaxRank',
    group: 'exploit',
    kind: 'int',
    label: 'Pal enhancement cap',
    min: -1,
    max: 60,
    sentinel: '-1 = auto-detect',
  },

  // --- PvP / PvE limits --- (pvpMaxToPlayerDamage ABSENT/beta in 1.8.3 -> dropped)
  { key: 'pvpMaxToBuildingDamage', group: 'pvp', kind: 'int', label: 'Max PvP building damage', min: 0, max: 100000, sentinel: '0 = unlimited' },
  { key: 'pvpMaxToPalDamage', group: 'pvp', kind: 'int', label: 'Max PvP Pal damage', min: 0, max: 100000, sentinel: '0 = unlimited' },
  { key: 'pveMaxToPalBanThreshold', group: 'pvp', kind: 'int', label: 'PvE Pal-damage ban threshold', min: 0, max: 100000000, sentinel: '0 = off' },
  {
    key: 'treeLimiter',
    group: 'pvp',
    kind: 'float',
    label: 'Tree fell limiter (s)',
    min: 0,
    max: 10,
    step: 0.1,
    sentinel: '0 = off',
    description: 'Minimum seconds per felled tree, anti-lag.',
  },

  // --- Whitelist & admins (2026-07-22 extension; all present in 1.8.3) ---
  {
    key: 'useWhitelist',
    group: 'whitelist',
    kind: 'bool',
    label: 'Use whitelist',
    warning: 'Enabling this with an EMPTY whitelist locks everyone out. Add players to the whitelist (raw editor / whitelist_add) first.',
  },
  { key: 'useAdminWhitelist', group: 'whitelist', kind: 'bool', label: 'Use admin IP whitelist', description: 'Restrict admin login to whitelisted IPs (adminIPs — raw editor).' },
  { key: 'adminAutoLogin', group: 'whitelist', kind: 'bool', label: 'Admin auto-login', description: 'Auto-authenticate admins from whitelisted IPs.' },
  { key: 'preventAdminPasswordInChat', group: 'whitelist', kind: 'bool', label: 'Block admin password in chat', description: 'Stop the admin password from being typed into chat.' },
  {
    key: 'allowAdminCheats',
    group: 'whitelist',
    kind: 'bool',
    label: 'Allow admin cheats',
    danger: true,
    warning: 'Turning this OFF disables the console cheat commands (give, givepal, tp, …) and the roster quick-actions — the console gating reads this flag live and reflects it. Takes effect in-game after Apply now (reloadcfg).',
  },
  { key: 'allowGodmodeOnehit', group: 'whitelist', kind: 'bool', label: 'Allow godmode one-hit', description: 'Let godmode admins one-hit-kill.' },

  // --- Chat ---
  { key: 'chatBypassWait', group: 'chat', kind: 'bool', label: 'Bypass chat cooldown' },
  { key: 'chatMessageMaxLen', group: 'chat', kind: 'int', label: 'Max chat message length', min: 1, max: 512 },

  // --- Announcement --- (announce* flags; dontAnnounceAdminConnections belongs
  // here too though it lacks the prefix)
  { key: 'announceConnections', group: 'announce', kind: 'bool', label: 'Announce connections' },
  { key: 'dontAnnounceAdminConnections', group: 'announce', kind: 'bool', label: 'Suppress admin connection announcements' },
  { key: 'announcePunishments', group: 'announce', kind: 'bool', label: 'Announce punishments' },
  { key: 'announcePlayerDeaths', group: 'announce', kind: 'bool', label: 'Announce player deaths' },
  { key: 'announceOpenOilrigBoxes', group: 'announce', kind: 'bool', label: 'Announce oil-rig box opens' },
  { key: 'announceHelicopterKills', group: 'announce', kind: 'bool', label: 'Announce helicopter kills' },
  { key: 'announcePlayerSummons', group: 'announce', kind: 'bool', label: 'Announce player summons' },
  { key: 'announceAdminSummons', group: 'announce', kind: 'bool', label: 'Announce admin summons' },
  { key: 'announceAdminSummonsKill', group: 'announce', kind: 'bool', label: 'Announce admin-summon kills' },

  // --- Logs --- (all log* flags present in 1.8.3)
  { key: 'logNetworking', group: 'logs', kind: 'bool', label: 'Log networking' },
  { key: 'logNetworkingToConsole', group: 'logs', kind: 'bool', label: 'Log networking to console' },
  { key: 'logChat', group: 'logs', kind: 'bool', label: 'Log chat' },
  { key: 'logRCON', group: 'logs', kind: 'bool', label: 'Log RCON' },
  { key: 'logPlayerUID', group: 'logs', kind: 'bool', label: 'Log player UID' },
  { key: 'logPlayerIP', group: 'logs', kind: 'bool', label: 'Log player IP' },
  { key: 'logPlayerDeaths', group: 'logs', kind: 'bool', label: 'Log player deaths' },
  { key: 'logPlayerLogins', group: 'logs', kind: 'bool', label: 'Log player logins' },
  { key: 'logPlayerBuildings', group: 'logs', kind: 'bool', label: 'Log player buildings' },
  { key: 'logHelicopterKills', group: 'logs', kind: 'bool', label: 'Log helicopter kills' },
  { key: 'logPlayerSummons', group: 'logs', kind: 'bool', label: 'Log player summons' },
  { key: 'logPlayerCaptures', group: 'logs', kind: 'bool', label: 'Log player captures' },
  { key: 'logCraftings', group: 'logs', kind: 'bool', label: 'Log craftings' },
  { key: 'logTechUnlocks', group: 'logs', kind: 'bool', label: 'Log tech unlocks' },
  { key: 'logOpenOilrigBoxes', group: 'logs', kind: 'bool', label: 'Log oil-rig box opens' },

  // --- Misc ---
  {
    key: 'exitServerOnStartupFailure',
    group: 'misc',
    kind: 'bool',
    label: 'Exit server on startup failure',
    warning: 'Keep ON: if PalDefender fails to start it exits cleanly, rather than the container restart-looping on a broken config.',
  },
  { key: 'disableButchering', group: 'misc', kind: 'bool', label: 'Disable butchering' },
  { key: 'disableRenaming', group: 'misc', kind: 'bool', label: 'Disable player renaming' },
  { key: 'disablePalRenaming', group: 'misc', kind: 'bool', label: 'Disable Pal renaming' },
  { key: 'OilrigGoalBoxLocktime', group: 'misc', kind: 'int', label: 'Oil-rig goal box lock time (s)', min: 0, max: 3600 },
  { key: 'RCONTimeout', group: 'misc', kind: 'float', label: 'RCON timeout (s)', min: 1, max: 120, step: 0.5 },
  { key: 'RCONUsePacketIdFix', group: 'misc', kind: 'bool', label: 'RCON packet-ID fix', description: 'Palworld RCON packet-ID compatibility (leave on).' },
]

export const PD_FIELD_BY_KEY: Record<string, PdField> = Object.fromEntries(PD_FIELDS.map((f) => [f.key, f]))

export const PD_GROUP_LABELS: Record<PdGroup, string> = {
  anticheat: 'Anti-cheat actions',
  exploit: 'Exploit protection',
  pvp: 'PvP / PvE limits',
  whitelist: 'Whitelist & admins',
  chat: 'Chat',
  announce: 'Announcement',
  logs: 'Logs',
  misc: 'Misc',
}

export type PdValue = boolean | number
export type PdValues = Record<string, PdValue>

// The MOTD is separate from the scalar fields: an array of lines, empty =
// disabled. Placeholders (`{PlayerName}`, ...) pass through verbatim.
export type PdConfig = {
  values: PdValues // managed scalar keys present in the file
  motd: string[]
  version: string | null
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

export function parsePalDefenderConfig(raw: string): PdConfig {
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return { values: {}, motd: [], version: null }
  }
  const values: PdValues = {}
  for (const field of PD_FIELDS) {
    const v = obj[field.key]
    if (field.kind === 'bool' && typeof v === 'boolean') values[field.key] = v
    else if ((field.kind === 'int' || field.kind === 'float') && typeof v === 'number') values[field.key] = v
  }
  const motd = Array.isArray(obj.MOTD) ? obj.MOTD.filter((l): l is string => typeof l === 'string') : []
  const version = typeof obj.version === 'string' ? obj.version : null
  return { values, motd, version }
}

// ---------------------------------------------------------------------------
// Surgical write
// ---------------------------------------------------------------------------

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function scalarLiteral(field: PdField, value: PdValue): string {
  if (field.kind === 'bool') return value ? 'true' : 'false'
  // JSON.stringify renders a JS number as a valid JSON literal (0.1 -> "0.1",
  // 1 -> "1", -1 -> "-1") without float-noise.
  return JSON.stringify(Number(value))
}

// Replace one top-level scalar key's value, matching the key as a JSON key
// (quoted, followed by a colon) so it can't collide with a substring or a value.
function replaceScalar(raw: string, key: string, literal: string): string {
  const re = new RegExp(`("${escapeRegExp(key)}"\\s*:\\s*)(true|false|-?\\d+(?:\\.\\d+)?)`)
  if (!re.test(raw)) throw new Error(`PalDefender key not found for write: ${key}`)
  return raw.replace(re, `$1${literal}`)
}

// Find the span of the MOTD array in the raw text by bracket-matching, honoring
// string literals so a `]` inside a message can't end the scan early.
function findArraySpan(raw: string, key: string): { start: number; end: number; indent: string } | null {
  const keyRe = new RegExp(`"${escapeRegExp(key)}"\\s*:\\s*`)
  const keyMatch = keyRe.exec(raw)
  if (!keyMatch) return null
  const open = raw.indexOf('[', keyMatch.index + keyMatch[0].length - 1)
  if (open === -1) return null

  // Indent of the key's line, for rebuilding the closing bracket position.
  const lineStart = raw.lastIndexOf('\n', keyMatch.index) + 1
  const indent = raw.slice(lineStart, keyMatch.index).match(/^\s*/)?.[0] ?? ''

  let depth = 0
  let inString = false
  for (let i = open; i < raw.length; i++) {
    const c = raw[i]
    if (inString) {
      if (c === '\\') i++
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    else if (c === '[') depth++
    else if (c === ']') {
      depth--
      if (depth === 0) return { start: open, end: i + 1, indent }
    }
  }
  return null
}

// Serialize MOTD lines as a JSON array matching the file's indentation, so the
// block is well-formed and reads like the rest of the file.
function motdLiteral(lines: string[], indent: string): string {
  if (lines.length === 0) return '[]'
  const inner = indent + '    '
  return '[\n' + lines.map((l) => inner + JSON.stringify(l)).join(',\n') + '\n' + indent + ']'
}

export type PdWrite = {
  values?: PdValues // changed scalar keys only
  motd?: string[] // present only when MOTD changed
}

// Apply a set of managed changes to the raw Config.json, byte-preserving
// everything else, and validate the result is still JSON before returning it.
export function writePalDefenderConfig(raw: string, changes: PdWrite): string {
  let out = raw

  if (changes.values) {
    for (const [key, value] of Object.entries(changes.values)) {
      const field = PD_FIELD_BY_KEY[key]
      if (!field) throw new Error(`Unknown PalDefender key: ${key}`)
      out = replaceScalar(out, key, scalarLiteral(field, value))
    }
  }

  if (changes.motd) {
    const span = findArraySpan(out, 'MOTD')
    if (!span) throw new Error('MOTD array not found in Config.json')
    out = out.slice(0, span.start) + motdLiteral(changes.motd, span.indent) + out.slice(span.end)
  }

  // A malformed result must never reach disk -- a JSON syntax error kills the
  // mod's config load (spec A1 raw-editor rationale, applied here too).
  try {
    JSON.parse(out)
  } catch {
    throw new Error('Refusing to write: the edit produced invalid JSON')
  }
  return out
}

// True when parsing succeeds -- used by the raw editor to gate a manual save.
export function isValidJson(text: string): boolean {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}
