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
    const j = (await res.json()) as { name?: string; version?: string; author?: string; available?: boolean }
    return {
      name: j.name ?? `Mod ${modId}`,
      version: j.version ?? null,
      author: j.author ?? null,
      available: j.available !== false,
      url: `https://www.nexusmods.com/${NEXUS_GAME_DOMAIN}/mods/${modId}`,
    }
  } catch {
    return null
  }
}

export type NexusFile = { fileId: number; name: string; version: string | null; category: string | null }

// Downloadable files for a mod — MAIN + OPTIONAL only (skip ARCHIVED/OLD_VERSION).
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
      files?: { file_id: number; file_name: string; version?: string; category_name?: string | null }[]
    }
    return (j.files ?? [])
      .filter((f) => {
        const c = (f.category_name ?? '').toUpperCase()
        return c === 'MAIN' || c === 'OPTIONAL' || c === 'UPDATE'
      })
      .map((f) => ({ fileId: f.file_id, name: f.file_name, version: f.version ?? null, category: f.category_name ?? null }))
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

// The Nexus association for a single installed mod, or null if it isn't linked.
// Used by the update flow to resolve which Nexus mod a row points at.
export async function getLinkedModId(
  modKey: string,
): Promise<{ modId: number; baselineVersion: string | null } | null> {
  const a = await readAssocs()
  return a[modKey] ?? null
}

export async function linkNexusMod(modKey: string, modId: number, haveVersion: string | null): Promise<void> {
  const info = await getModInfo(modId)
  const a = await readAssocs()
  // Seed the version cache from this fetch so getNexusMods needn't re-hit Nexus
  // until the bulk sweep says this mod actually changed.
  a[modKey] = {
    modId,
    baselineVersion: (haveVersion?.trim() || info?.version) ?? null,
    latestVersion: info?.version ?? null,
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
      const info = await getModInfo(assoc.modId)
      latest = info?.version ?? null
      name = info?.name ?? `Mod ${assoc.modId}`
      author = info?.author ?? null
      available = info?.available ?? true
      a[modKey] = { ...assoc, latestVersion: latest, latestName: name, latestAuthor: author, checkedAt: now }
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
      updateAvailable: Boolean(latest && assoc.baselineVersion && latest !== assoc.baselineVersion),
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
