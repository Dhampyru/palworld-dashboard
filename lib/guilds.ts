// PATCH (not upstream): types and normalisation for the guild/base browser
// (roadmap item 3, re-scoped).
//
// WHY THIS EXISTS INSTEAD OF SAVE PARSING. The roadmap assumed item 3 would
// parse Level.sav via palworld-save-tools. Verified 2026-07-20 against this
// build: every save file -- Level.sav, Players/*.sav, LevelMeta.sav -- uses
// the `PlM1` container with GVAS at offset 20 and NO zlib stream at any
// offset. The documented `PlZ1` layout every community parser expects simply
// fails. The shipping binary confirms it: `PlM1` is the only Pl?1 magic
// present, and Oodle is statically linked (Kraken, kraken_chunk_optimal) with
// no loadable oo2core DLL anywhere in the install. Save parsing is therefore
// not available on this build at any effort level short of a reverse-engineered
// Oodle decoder.
//
// PalDefender's `exportguilds` gives much of the same data as structured JSON,
// and -- unlike `exportpals`, which fails for anyone not currently connected --
// it works for OFFLINE players. That makes it the only source of last-seen
// times and last-known positions for players who are not online, which the
// live snapshot cannot provide at all.

export type GuildMember = {
  id: string
  nickName: string
  level: number
  exp: number
  // Last known position. Present for offline players too, which is the point.
  worldPosition: { x: number; y: number; z: number } | null
  mapPosition: { x: number; y: number } | null
  lastOnline: string | null // ISO 8601, or null when unparseable
}

export type Guild = {
  id: string
  name: string
  adminId: string
  adminName: string
  level: number
  campNum: number
  campNumTotal: number
  memberCount: number
  members: GuildMember[]
  expeditionsFinished: number
  expeditionsUnlocked: number
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

// PalDefender emits LastOnline as a .NET-style parts object plus a Ticks
// field. The parts are what we can trust across timezones, so build from
// those rather than converting Ticks; a missing or malformed date becomes null
// rather than 1970, which would render as a confidently wrong "last seen".
function toIsoDate(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  const parts = value as Record<string, unknown>
  const year = num(parts.Year, 0)
  if (year < 2000 || year > 3000) return null
  const date = new Date(
    Date.UTC(year, num(parts.Month, 1) - 1, num(parts.Day, 1), num(parts.Hour), num(parts.Min), num(parts.Sec), num(parts.Msec)),
  )
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function toVec3(value: unknown): { x: number; y: number; z: number } | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (typeof v.X !== 'number' || typeof v.Y !== 'number') return null
  return { x: v.X, y: v.Y, z: num(v.Z) }
}

function toVec2(value: unknown): { x: number; y: number } | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (typeof v.X !== 'number' || typeof v.Y !== 'number') return null
  return { x: v.X, y: v.Y }
}

// The export is an object keyed by guild id, not an array. Every field is
// treated as optional: this is a mod's output format, and it has already
// changed shape once between versions (a `Laboratory` key appeared).
export function parseGuildExport(raw: string): Guild[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []

  const guilds: Guild[] = []
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue
    const g = value as Record<string, unknown>
    const membersRaw = (g.Members && typeof g.Members === 'object' ? g.Members : {}) as Record<string, unknown>

    const members: GuildMember[] = Object.entries(membersRaw).map(([memberId, m]) => {
      const member = (m && typeof m === 'object' ? m : {}) as Record<string, unknown>
      return {
        id: memberId,
        nickName: str(member.NickName, 'Unknown'),
        level: num(member.Level),
        exp: num(member.Exp),
        worldPosition: toVec3(member.WorldPosition),
        mapPosition: toVec2(member.MapPosition),
        lastOnline: toIsoDate(member.LastOnline),
      }
    })

    guilds.push({
      id,
      name: str(g.Name, 'Unnamed Guild'),
      adminId: str(g.AdminID),
      adminName: str(g.AdminName, 'Unknown'),
      level: num(g.Level),
      campNum: num(g.CampNum),
      campNumTotal: num(g.CampNumTotal),
      // MemberCount can disagree with the Members map; trust the map.
      memberCount: members.length || num(g.MemberCount),
      members,
      expeditionsFinished: num(g.ExpeditionsFinished),
      expeditionsUnlocked: Array.isArray(g.ExpeditionsUnlocked) ? g.ExpeditionsUnlocked.length : 0,
    })
  }

  // Biggest guilds first, then by name, so the list is stable between polls.
  return guilds.sort((a, b) => b.memberCount - a.memberCount || a.name.localeCompare(b.name))
}
