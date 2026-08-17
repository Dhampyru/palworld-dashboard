import { mkdir, readFile, rm, writeFile, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createHash } from 'node:crypto'

// PATCH (not upstream): Nexus Mods integration (docs/specs/nexus-integration.md).
// The admin's Nexus API key is a SECRET — stored server-side only (never sent to
// the browser or committed), in the ./data volume like the panel-auth store, with
// an env fallback for deploy-time config. All Nexus calls happen server-side.
//
// Two tiers (account-specific): read/metadata endpoints work with ANY valid key;
// auto-download is Premium-only (Phase 2). This module is Phase 1: key config +
// validation. With no key, everything is dormant.

const KEY_FILE = process.env.NEXUS_KEY_FILE ?? './data/nexus.json'
const NEXUS_API_BASE = 'https://api.nexusmods.com'
export const NEXUS_GAME_DOMAIN = 'palworld'

export type NexusStatus = {
  configured: boolean // a key is set (file or env)
  valid: boolean // the key authenticated against Nexus
  name: string | null
  isPremium: boolean
  // 'file' = set via the dashboard; 'env' = NEXUS_API_KEY; null = none
  source: 'file' | 'env' | null
  error: string | null
}

type StoredKey = { apiKey?: string }

// Read the configured key: dashboard-set file first, then NEXUS_API_KEY env.
export async function readNexusKey(): Promise<{ key: string; source: 'file' | 'env' } | null> {
  try {
    const j = JSON.parse(await readFile(KEY_FILE, 'utf8')) as StoredKey
    if (j.apiKey && j.apiKey.trim()) return { key: j.apiKey.trim(), source: 'file' }
  } catch {
    /* no file — fall through to env */
  }
  const env = process.env.NEXUS_API_KEY
  if (env && env.trim()) return { key: env.trim(), source: 'env' }
  return null
}

// Persist (or clear) the dashboard-set key. Mode 0600, temp+rename (like panel-auth).
export async function saveNexusKey(key: string | null): Promise<void> {
  if (!key) {
    try {
      await rm(KEY_FILE, { force: true })
    } catch {
      /* already absent */
    }
    return
  }
  await mkdir(dirname(KEY_FILE), { recursive: true })
  const tmp = `${KEY_FILE}.tmp`
  await writeFile(tmp, JSON.stringify({ apiKey: key.trim() }, null, 2), { mode: 0o600 })
  await rename(tmp, KEY_FILE)
}

// Validate a key against Nexus. /v1/users/validate.json 401s on a bad key.
export async function validateKey(
  key: string,
): Promise<{ valid: boolean; name: string | null; isPremium: boolean; error: string | null }> {
  try {
    const res = await fetch(`${NEXUS_API_BASE}/v1/users/validate.json`, {
      headers: { apikey: key, Accept: 'application/json', 'User-Agent': 'palworld-dashboard' },
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    })
    if (res.status === 401) return { valid: false, name: null, isPremium: false, error: 'Invalid API key' }
    if (!res.ok) return { valid: false, name: null, isPremium: false, error: `Nexus responded ${res.status}` }
    const j = (await res.json()) as { name?: string; is_premium?: boolean }
    return { valid: true, name: j.name ?? null, isPremium: Boolean(j.is_premium), error: null }
  } catch (e) {
    return { valid: false, name: null, isPremium: false, error: e instanceof Error ? e.message : 'unreachable' }
  }
}

// ── Mod ↔ Nexus association + update watching (Phase 1 increment 2) ───────────
// Our installed mods carry no Nexus ID, so the admin links each one to its Nexus
// mod (paste the URL). We watch the mod's published version: `baseline` is what the
// admin has (their entered version, or the latest at link time), and an update is
// flagged when Nexus's current version differs. Paks embed no version, so we can't
// auto-detect what's installed — this is an honest "did it change on Nexus" watcher.
const MODS_FILE = process.env.NEXUS_MODS_FILE ?? './data/nexus-mods.json'

type Assoc = {
  modId: number
  baselineVersion: string | null
  // The installed file's clean display name (variant key). Update detection compares the
  // baseline only against files sharing this name, so a DIFFERENT variant of a multi-file mod
  // bumping never shows a phantom update. Absent on legacy links → inferred on next check.
  variant?: string | null
  // Version cache for the bulk-sweep fast path (Phase 3). `latestVersion` absent
  // (undefined) = never cached; null = cached, mod has no version string.
  latestVersion?: string | null
  latestName?: string
  latestAuthor?: string | null
  checkedAt?: number
}
type Assocs = Record<string, Assoc>

// Accept a full nexusmods.com/palworld/mods/<id> URL or a bare mod id.
export function parseNexusModId(input: string): number | null {
  const s = input.trim()
  if (/^\d+$/.test(s)) return Number(s)
  const m = s.match(/nexusmods\.com\/palworld\/mods\/(\d+)/i)
  return m ? Number(m[1]) : null
}

export type NexusModInfo = {
  name: string
  version: string | null
  author: string | null
  available: boolean
  url: string
  summary: string | null // short plain-text blurb
  description: string | null // full BBCode description (used for placement keyword mining)
}

export async function getModInfo(modId: number): Promise<NexusModInfo | null> {
  const found = await readNexusKey()
  if (!found) return null
  try {
    const res = await fetch(`${NEXUS_API_BASE}/v1/games/${NEXUS_GAME_DOMAIN}/mods/${modId}.json`, {
      headers: { apikey: found.key, Accept: 'application/json', 'User-Agent': 'palworld-dashboard' },
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return null
    const j = (await res.json()) as {
      name?: string; version?: string; author?: string; available?: boolean; summary?: string; description?: string
    }
    return {
      name: j.name ?? `Mod ${modId}`,
      version: j.version ?? null,
      author: j.author ?? null,
      available: j.available !== false,
      url: `https://www.nexusmods.com/${NEXUS_GAME_DOMAIN}/mods/${modId}`,
      summary: j.summary ?? null,
      description: j.description ?? null,
    }
  } catch {
    return null
  }
}

// `name` is the download filename (noisy: embeds modId/version/timestamp/hash). `displayName`
// is Nexus's clean per-file name (e.g. "358 GuildChest Slots Pak version") — STABLE across
// versions of the same variant, so it's the key used to match "the same file" when detecting
// updates on a mod that ships several independently-versioned MAIN files.
export type NexusFile = { fileId: number; name: string; displayName: string; version: string | null; category: string | null }

// The version of the newest MAIN file — the correct thing to compare an installed
// mod against. Nexus has TWO version fields: the mod page's headline `version` AND each
// file's `version`, and for some mods they DIFFER. `baselineVersion` is the installed
// FILE's version, so update-detection must compare it to the latest FILE version (not the
// mod headline), or a divergent mod perpetually shows a phantom update. Newest = last.
// Compare version-ish strings numerically by their digit groups: "2" > "1",
// "1.3.5" > "1.2", "v2.0.1" > "v1.9". Returns >0 if a is newer than b, <0 if older, 0 equal.
// Non-numeric noise (prefixes/suffixes) is ignored so odd version labels still order sanely.
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => (v.match(/\d+/g) ?? []).map(Number)
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x - y
  }
  return 0
}

// The NEWEST MAIN file version — the MAX across MAIN files, not just the last in the list.
// A mod with several MAIN files (variants, each independently versioned — e.g. 3434 GuildChest
// ships 358-pak-v2 alongside 2466-*-v1) must not report a lower variant's version as "latest",
// or an up-to-date install shows a phantom update. Falls back to the last file when no version
// parses. NOTE: still not variant-aware — a DIFFERENT variant bumping can look like an update;
// the strictly-newer gate at the call site keeps the common (installed-is-newest) case correct.
export function latestMainFileVersion(files: NexusFile[]): string | null {
  const main = files.filter((f) => (f.category ?? '').toUpperCase() === 'MAIN')
  const pool = main.length ? main : files
  let best: string | null = null
  for (const f of pool) {
    const v = f.version ?? null
    if (v == null) continue
    if (best == null || compareVersions(v, best) > 0) best = v
  }
  return best ?? (pool.length ? (pool[pool.length - 1].version ?? null) : null)
}

// Variant-aware latest: the newest version among MAIN files that share the INSTALLED variant's
// display name — so a mod shipping several independently-versioned MAIN files (e.g. 3434
// GuildChest: "358 …Pak version" v2 vs "2466 …" v1) never reports a different variant's bump as
// an update. `variant` is the stored installed display name; if absent (legacy link) it's
// inferred as the unique MAIN file whose version equals the baseline. Returns the resolved
// variant so the caller can persist it. Falls back to all MAIN files when the variant is
// unknown or has disappeared from the mod.
export function resolveVariantLatest(
  files: NexusFile[],
  baselineVersion: string | null,
  variant: string | null | undefined,
): { latest: string | null; variant: string | null } {
  const main = files.filter((f) => (f.category ?? '').toUpperCase() === 'MAIN')
  const pool = main.length ? main : files
  let v = variant ?? null
  if (!v && baselineVersion) {
    const matches = pool.filter((f) => f.version && compareVersions(f.version, baselineVersion) === 0)
    if (matches.length === 1) v = matches[0].displayName
  }
  const scoped = v ? pool.filter((f) => f.displayName === v) : pool
  const use = scoped.length ? scoped : pool
  let best: string | null = null
  for (const f of use) {
    if (f.version == null) continue
    if (best == null || compareVersions(f.version, best) > 0) best = f.version
  }
  return { latest: best ?? (use.length ? (use[use.length - 1].version ?? null) : null), variant: v }
}

// Downloadable files for a mod (skip ARCHIVED/OLD_VERSION). Includes MISCELLANEOUS:
// some mods (e.g. 5120 Stuck Pal Scanner) publish their ONLY download under that category,
// so excluding it left getModFiles empty — detection still flagged an update via the mod's
// headline version, but the Update flow found no file to download and failed ("can't update").
// MAIN stays preferred everywhere (pickUpdateFile / downloadMainArchive / resolveVariantLatest
// all fall back to the full list only when no MAIN exists), so this only affects MAIN-less mods.
export async function getModFiles(modId: number): Promise<NexusFile[]> {
  const found = await readNexusKey()
  if (!found) return []
  try {
    const res = await fetch(`${NEXUS_API_BASE}/v1/games/${NEXUS_GAME_DOMAIN}/mods/${modId}/files.json`, {
      headers: { apikey: found.key, Accept: 'application/json', 'User-Agent': 'palworld-dashboard' },
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return []
    const j = (await res.json()) as {
      files?: { file_id: number; name?: string; file_name: string; version?: string; category_name?: string | null }[]
    }
    return (j.files ?? [])
      .filter((f) => {
        const c = (f.category_name ?? '').toUpperCase()
        return c === 'MAIN' || c === 'OPTIONAL' || c === 'UPDATE' || c === 'MISCELLANEOUS'
      })
      .map((f) => ({
        fileId: f.file_id,
        name: f.file_name,
        displayName: (f.name ?? f.file_name).trim(),
        version: f.version ?? null,
        category: f.category_name ?? null,
      }))
  } catch {
    return []
  }
}

// Premium: resolve a CDN download link for a mod file.
async function getDownloadLink(modId: number, fileId: number): Promise<string | null> {
  const found = await readNexusKey()
  if (!found) return null
  const res = await fetch(
    `${NEXUS_API_BASE}/v1/games/${NEXUS_GAME_DOMAIN}/mods/${modId}/files/${fileId}/download_link.json`,
    {
      headers: { apikey: found.key, Accept: 'application/json', 'User-Agent': 'palworld-dashboard' },
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    },
  )
  if (res.status === 403) throw new Error('Auto-download needs a Nexus Premium account')
  if (!res.ok) throw new Error(`Nexus download link failed (${res.status})`)
  const arr = (await res.json()) as { URI?: string }[]
  return arr?.[0]?.URI ?? null
}

// Download a mod file (Premium) → its bytes. The archive is a zip.
export async function downloadNexusFile(modId: number, fileId: number): Promise<Buffer> {
  const link = await getDownloadLink(modId, fileId)
  if (!link) throw new Error('No download link returned by Nexus')
  const res = await fetch(link, {
    headers: { 'User-Agent': 'palworld-dashboard' },
    cache: 'no-store',
    signal: AbortSignal.timeout(180_000),
  })
  if (!res.ok) throw new Error(`Download failed (${res.status})`)
  return Buffer.from(await res.arrayBuffer())
}

async function readAssocs(): Promise<Assocs> {
  try {
    return JSON.parse(await readFile(MODS_FILE, 'utf8')) as Assocs
  } catch {
    return {}
  }
}
async function writeAssocs(a: Assocs): Promise<void> {
  await mkdir(dirname(MODS_FILE), { recursive: true })
  const tmp = `${MODS_FILE}.tmp`
  await writeFile(tmp, JSON.stringify(a, null, 2))
  await rename(tmp, MODS_FILE)
}

// Drop a server mod's Nexus tracking row — called on delete so a removed mod leaves no
// phantom "update available" entry (the leftover that motivated this).
export async function removeNexusAssoc(modKey: string): Promise<void> {
  const a = await readAssocs()
  if (a[modKey]) {
    delete a[modKey]
    await writeAssocs(a)
  }
}

// The Nexus modId a tracked server mod key came from (null if untracked) — lets a delete
// find the paired client stage.
export async function nexusModIdForKey(modKey: string): Promise<number | null> {
  const a = await readAssocs()
  return a[modKey]?.modId ?? null
}

// Server mod keys (ue4ss:X / pak:Y) tracked as coming from this Nexus modId — lets a
// client-side delete find the paired server install(s).
export async function nexusKeysForModId(modId: number): Promise<string[]> {
  const a = await readAssocs()
  return Object.keys(a).filter((k) => a[k].modId === modId)
}

// The Nexus association for a single installed mod, or null if it isn't linked.
// Used by the update flow to resolve which Nexus mod a row points at.
export async function getLinkedModId(
  modKey: string,
): Promise<{ modId: number; baselineVersion: string | null; variant?: string | null } | null> {
  const a = await readAssocs()
  return a[modKey] ?? null
}

export async function linkNexusMod(
  modKey: string,
  modId: number,
  haveVersion: string | null,
  variant?: string | null,
): Promise<void> {
  const info = await getModInfo(modId)
  const a = await readAssocs()
  // Seed the version cache from this fetch so getNexusMods needn't re-hit Nexus
  // until the bulk sweep says this mod actually changed. `variant` = the installed file's
  // display name, so update detection stays scoped to the same file across versions.
  const baseline = (haveVersion?.trim() || info?.version) ?? null
  a[modKey] = {
    modId,
    baselineVersion: baseline,
    variant: variant ?? null,
    latestVersion: baseline, // seed latest == baseline so a just-installed mod shows no update
    latestName: info?.name,
    latestAuthor: info?.author ?? null,
    checkedAt: Date.now(),
  }
  await writeAssocs(a)
}
export async function unlinkNexusMod(modKey: string): Promise<void> {
  const a = await readAssocs()
  delete a[modKey]
  await writeAssocs(a)
}
export async function markNexusSeen(modKey: string): Promise<void> {
  const a = await readAssocs()
  const cur = a[modKey]
  if (!cur) return
  const info = await getModInfo(cur.modId)
  // Accept the current Nexus version as the baseline AND refresh the cache so the
  // fast path doesn't resurface a phantom update from stale cached data.
  a[modKey] = {
    ...cur,
    baselineVersion: info?.version ?? cur.baselineVersion,
    latestVersion: info?.version ?? cur.latestVersion ?? null,
    latestName: info?.name ?? cur.latestName,
    latestAuthor: info?.author ?? cur.latestAuthor ?? null,
    checkedAt: Date.now(),
  }
  await writeAssocs(a)
}

// One bulk call: mod ids with Nexus activity in the given window. null = the call
// failed (caller should fall back to per-mod refetch). Lets getNexusMods skip the
// per-mod version fetch for mods that provably haven't changed.
async function getUpdatedModIds(period: '1d' | '1w' | '1m'): Promise<Set<number> | null> {
  const found = await readNexusKey()
  if (!found) return null
  try {
    const res = await fetch(
      `${NEXUS_API_BASE}/v1/games/${NEXUS_GAME_DOMAIN}/mods/updated.json?period=${period}`,
      {
        headers: { apikey: found.key, Accept: 'application/json', 'User-Agent': 'palworld-dashboard' },
        cache: 'no-store',
        signal: AbortSignal.timeout(10_000),
      },
    )
    if (!res.ok) return null
    const arr = (await res.json()) as { mod_id?: number }[]
    return new Set((arr ?? []).map((m) => m.mod_id).filter((n): n is number => typeof n === 'number'))
  } catch {
    return null
  }
}

// Best-effort: identify a freshly-installed archive by its MD5 against Nexus and,
// if a file matches, auto-link the mod for update-watching (baseline = that file's
// version). Silent no-op with no key, no match, or any error — this must NEVER fail
// an install. Matches only when the uploaded bytes equal a file Nexus has on record
// (i.e. the admin uploaded the unmodified Nexus download); a repacked archive won't.
export async function md5AutoAssociate(
  modKey: string,
  archive: Buffer,
): Promise<{ modId: number; name: string; version: string | null } | null> {
  const found = await readNexusKey()
  if (!found) return null
  try {
    const md5 = createHash('md5').update(archive).digest('hex')
    const res = await fetch(
      `${NEXUS_API_BASE}/v1/games/${NEXUS_GAME_DOMAIN}/mods/md5_search/${md5}.json`,
      {
        headers: { apikey: found.key, Accept: 'application/json', 'User-Agent': 'palworld-dashboard' },
        cache: 'no-store',
        signal: AbortSignal.timeout(10_000),
      },
    )
    if (!res.ok) return null // 404 = no match; anything else = give up quietly
    const arr = (await res.json()) as {
      mod?: { mod_id?: number; name?: string; version?: string }
      file_details?: { version?: string }
    }[]
    const hit = Array.isArray(arr) ? arr[0] : null
    const modId = hit?.mod?.mod_id
    if (!modId) return null
    const version = hit?.file_details?.version ?? hit?.mod?.version ?? null
    await linkNexusMod(modKey, modId, version)
    return { modId, name: hit?.mod?.name ?? `Mod ${modId}`, version }
  } catch {
    return null
  }
}

export type NexusModRow = {
  modId: number
  name: string
  author: string | null
  latestVersion: string | null
  baselineVersion: string | null
  updateAvailable: boolean
  available: boolean
  url: string
}

const CACHE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000 // matches the '1m' sweep period

// All associations enriched with current Nexus info + update flag. Bulk-sweep fast
// path (Phase 3): one updated.json call tells us which mods changed in the last
// month; a linked mod whose cache is fresher than that window AND absent from the
// set provably hasn't changed, so we skip its per-mod call and reuse the cache.
// Cold cache / sweep failure falls back to a per-mod refetch (still correct).
export async function getNexusMods(): Promise<Record<string, NexusModRow>> {
  const a = await readAssocs()
  const entries = Object.entries(a)
  if (!entries.length) return {}

  const updated = await getUpdatedModIds('1m')
  const now = Date.now()

  const out: Record<string, NexusModRow> = {}
  let dirty = false
  for (const [modKey, assoc] of entries) {
    const cacheFresh = typeof assoc.checkedAt === 'number' && now - assoc.checkedAt < CACHE_WINDOW_MS
    // Refetch when we can't trust the cache: sweep failed, never cached, cache
    // older than the sweep window, or the sweep says this mod changed.
    const mustRefetch =
      !updated || assoc.latestVersion === undefined || !cacheFresh || updated.has(assoc.modId)

    let latest: string | null
    let name: string
    let author: string | null
    let available: boolean
    if (mustRefetch) {
      const [info, files] = await Promise.all([getModInfo(assoc.modId), getModFiles(assoc.modId)])
      // Compare the installed FILE version (baseline) to the latest version OF THE SAME VARIANT
      // — not the headline `version` (a divergent field) and not the newest across all MAIN
      // files (a different variant's bump would flag a phantom update on a multi-file mod).
      const rv = resolveVariantLatest(files, assoc.baselineVersion, assoc.variant)
      latest = rv.latest ?? info?.version ?? null
      name = info?.name ?? `Mod ${assoc.modId}`
      author = info?.author ?? null
      available = info?.available ?? true
      a[modKey] = {
        ...assoc,
        variant: rv.variant ?? assoc.variant ?? null, // backfill the inferred variant
        latestVersion: latest,
        latestName: name,
        latestAuthor: author,
        checkedAt: now,
      }
      dirty = true
    } else {
      latest = assoc.latestVersion ?? null
      name = assoc.latestName ?? `Mod ${assoc.modId}`
      author = assoc.latestAuthor ?? null
      available = true
    }

    out[modKey] = {
      modId: assoc.modId,
      name,
      author,
      latestVersion: latest,
      baselineVersion: assoc.baselineVersion,
      updateAvailable: Boolean(
        latest && assoc.baselineVersion && compareVersions(latest, assoc.baselineVersion) > 0,
      ),
      available,
      url: `https://www.nexusmods.com/${NEXUS_GAME_DOMAIN}/mods/${assoc.modId}`,
    }
  }
  if (dirty) await writeAssocs(a)
  return out
}

// Current integration status (drives which tier the UI offers). Dormant with no key.
export async function getNexusStatus(): Promise<NexusStatus> {
  const found = await readNexusKey()
  if (!found) {
    return { configured: false, valid: false, name: null, isPremium: false, source: null, error: null }
  }
  const v = await validateKey(found.key)
  return {
    configured: true,
    valid: v.valid,
    name: v.name,
    isPremium: v.isPremium,
    source: found.source,
    error: v.error,
  }
}
