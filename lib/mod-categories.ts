// PATCH (not upstream): genre categories for installed mods, for the Mods-page category
// grouping. There is no category stored in the tracking files, so this fetches it from the
// mod's SOURCE — Nexus (the mod's `category_id`, mapped via the game's category list) or
// Steam Workshop (the item's tags) — and caches it in `data/mod-categories.json`, keyed by
// SOURCE IDENTITY (`nexus:<modId>` / `steam:<itemId>`) so the server and client panels share
// one cache. Manual uploads (no source link) have no category and land in "Uncategorized".
//
// Reads are cache-first and cheap; a GET awaits a bounded fetch of only the MISSING/stale
// keys (categories change ~never, so the 30-day TTL means this is a one-time cost per mod).
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import { readNexusKey, NEXUS_GAME_DOMAIN } from '@/lib/nexus'
import { fetchWorkshopTags } from '@/lib/steam'

const NEXUS_API_BASE = 'https://api.nexusmods.com'
const CACHE_FILE = process.env.MOD_CATEGORIES_FILE ?? './data/mod-categories.json'
const TTL_MS = 30 * 24 * 3600 * 1000 // categories rarely change
const REQ_TIMEOUT_MS = 8000
const NEXUS_CONCURRENCY = 4

export type ModSourceLink = { source: 'nexus' | 'steam'; sourceId: string }
type CacheEntry = { category: string | null; checkedAt: number }
type Cache = Record<string, CacheEntry>

export function sourceCategoryKey(source: 'nexus' | 'steam', sourceId: string | number): string {
  return `${source}:${sourceId}`
}

async function readCache(): Promise<Cache> {
  try {
    return JSON.parse(await readFile(CACHE_FILE, 'utf8')) as Cache
  } catch {
    return {}
  }
}
async function writeCache(c: Cache): Promise<void> {
  await mkdir(dirname(CACHE_FILE), { recursive: true })
  const tmp = `${CACHE_FILE}.tmp`
  await writeFile(tmp, JSON.stringify(c, null, 2))
  await rename(tmp, CACHE_FILE)
}

async function fetchJson(url: string, key?: string): Promise<unknown | null> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'palworld-dashboard', ...(key ? { apikey: key } : {}) },
      signal: ctrl.signal,
    })
    return res.ok ? await res.json() : null
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}

// Nexus category_id -> name, fetched once from the game endpoint. In-memory cached.
let nexusCatMap: Record<number, string> | null = null
let nexusCatMapAt = 0
async function getNexusCategoryMap(key: string): Promise<Record<number, string>> {
  if (nexusCatMap && Date.now() - nexusCatMapAt < TTL_MS) return nexusCatMap
  const j = (await fetchJson(`${NEXUS_API_BASE}/v1/games/${NEXUS_GAME_DOMAIN}.json`, key)) as {
    categories?: { category_id: number; name: string }[]
  } | null
  const map: Record<number, string> = {}
  for (const c of j?.categories ?? []) map[c.category_id] = c.name
  if (Object.keys(map).length) {
    nexusCatMap = map
    nexusCatMapAt = Date.now()
  }
  return nexusCatMap ?? {}
}

// string = resolved genre; null = fetched OK but the mod has no mapped category; undefined =
// the fetch itself failed (network/timeout/rate-limit) — the caller must NOT cache that, so a
// transient failure retries next time instead of sticking as "Uncategorized" for the TTL.
async function fetchNexusCategory(modId: number, key: string, catMap: Record<number, string>): Promise<string | null | undefined> {
  const j = (await fetchJson(`${NEXUS_API_BASE}/v1/games/${NEXUS_GAME_DOMAIN}/mods/${modId}.json`, key)) as {
    category_id?: number
  } | null
  if (j === null) return undefined
  return typeof j.category_id === 'number' ? catMap[j.category_id] ?? null : null
}

// Steam tags that are framework/plumbing labels, not a genre.
const GENERIC_STEAM_TAGS = new Set(['ue4ss', 'mods', 'mod', 'palschema', 'multiplayer', 'server', 'client', 'pak', 'logicmod'])
function pickSteamCategory(tags: string[]): string | null {
  const genre = tags.find((t) => !GENERIC_STEAM_TAGS.has(t.toLowerCase()))
  return genre ?? tags[0] ?? null
}

// Resolve genre categories for a set of source links. Returns sourceKey -> category name (or
// null). Cache-first; only MISSING/stale keys are fetched, and never throws.
export async function getCategories(links: ModSourceLink[]): Promise<Record<string, string | null>> {
  const cache = await readCache()
  const now = Date.now()
  const wanted = new Map<string, ModSourceLink>()
  for (const l of links) {
    if (l && l.sourceId) wanted.set(sourceCategoryKey(l.source, l.sourceId), l)
  }
  const stale = [...wanted.values()].filter((l) => {
    const e = cache[sourceCategoryKey(l.source, l.sourceId)]
    return !e || now - e.checkedAt > TTL_MS
  })

  if (stale.length) {
    // Steam: one batched call. Only cache items the API actually returned (an id missing from
    // the response = a failed lookup → leave it stale so it retries next time).
    const steamIds = [...new Set(stale.filter((l) => l.source === 'steam').map((l) => l.sourceId))]
    if (steamIds.length) {
      const tagMap = await fetchWorkshopTags(steamIds)
      for (const id of steamIds) {
        if (id in tagMap) cache[sourceCategoryKey('steam', id)] = { category: pickSteamCategory(tagMap[id]), checkedAt: now }
      }
    }
    // Nexus: per-mod, concurrency-limited, only if a key is configured AND the category map
    // loaded (an empty map = the map fetch failed → don't map every id to null).
    const nexusIds = [...new Set(stale.filter((l) => l.source === 'nexus').map((l) => l.sourceId))]
    if (nexusIds.length) {
      const found = await readNexusKey()
      if (found) {
        const catMap = await getNexusCategoryMap(found.key)
        if (Object.keys(catMap).length) {
          for (let i = 0; i < nexusIds.length; i += NEXUS_CONCURRENCY) {
            const batch = nexusIds.slice(i, i + NEXUS_CONCURRENCY)
            const cats = await Promise.all(batch.map((id) => fetchNexusCategory(Number(id), found.key, catMap)))
            batch.forEach((id, j) => {
              if (cats[j] !== undefined) cache[sourceCategoryKey('nexus', id)] = { category: cats[j] as string | null, checkedAt: now }
            })
          }
        }
      }
      // No key / failed map → leave unfetched so they retry; don't poison the cache.
    }
    await writeCache(cache).catch(() => {})
  }

  const out: Record<string, string | null> = {}
  for (const [k] of wanted) out[k] = cache[k]?.category ?? null
  return out
}
