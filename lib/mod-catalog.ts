import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { readSteamMods } from '@/lib/game-mods'
import { getLinkedModId } from '@/lib/nexus'

// Mod catalog (docs/specs/mod-config-editor.md §2a). An OPTIONAL, operator-supplied
// dataset of mod descriptions keyed `<source>_<id>` (nexus_3546, workshop_37655…).
// When present it makes config discovery description-driven instead of pure heuristic:
// authors state where their config lives, so we can name the real config file and stop
// mis-classifying generated data as settings. Absent → discovery stays heuristic. The
// dataset is NOT shipped (it's the operator's own mod list); only this reader ships.
const MOD_DATA_DIR = process.env.MOD_DATA_DIR ?? '/app/mod-data'

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

// Resolve an installed UE4SS mod folder → its catalog description, via the association
// ids the dashboard already stores (Steam Workshop itemId / Nexus modId). No fuzzy name
// matching. Returns null when the mod isn't linked or isn't in the operator's dataset.
async function loadDescription(modName: string): Promise<string | null> {
  const modKey = `ue4ss:${modName}`
  const steam = await readSteamMods().catch(() => ({} as Record<string, { itemId: string }>))
  const itemId = steam[modKey]?.itemId
  if (itemId) {
    const t = await readText(join(MOD_DATA_DIR, 'descriptions', `workshop_${itemId}.txt`))
    if (t) return t
  }
  const nx = await getLinkedModId(modKey).catch(() => null)
  if (nx?.modId) {
    const t = await readText(join(MOD_DATA_DIR, 'descriptions', `nexus_${nx.modId}.txt`))
    if (t) return t
  }
  return null
}

// Config-file basenames a description mentions (config*.ext / settings*.ext / *config*.ext).
// Basename, not full path — matched against discovered files, so we don't have to parse
// the author's exact (and inconsistent) directory notation.
export function parseDeclaredConfigBasenames(text: string): Set<string> {
  const set = new Set<string>()
  const norm = text.replace(/\\/g, '/')
  const re = /([A-Za-z0-9_.\-]*(?:config|settings)[A-Za-z0-9_.\-]*\.(?:lua|jsonc?|ini))/gi
  for (const m of norm.matchAll(re)) set.add(m[1].toLowerCase())
  return set
}

// Per-mod override map — the operator's manual "this file IS the config" for mods whose
// description names none (or names it wrong). Operator config, so it lives in the data
// volume (writable, UI-editable, NOT shipped), keyed by installed mod folder → declared
// config basenames. An override wins over the description parse for that mod.
const OVERRIDES_FILE = process.env.MOD_CONFIG_OVERRIDES_FILE ?? './data/mod-config-overrides.json'

export async function readConfigOverrides(): Promise<Record<string, string[]>> {
  try {
    const o = JSON.parse(await readFile(OVERRIDES_FILE, 'utf8')) as Record<string, unknown>
    const out: Record<string, string[]> = {}
    for (const [k, v] of Object.entries(o)) {
      if (Array.isArray(v)) out[k] = v.map((x) => String(x).toLowerCase()).filter(Boolean)
    }
    return out
  } catch {
    return {} // no file yet → no overrides
  }
}

// Set (basenames non-empty) or clear (null / empty) the override for one mod. Atomic.
export async function setConfigOverride(modName: string, basenames: string[] | null): Promise<void> {
  const all = await readConfigOverrides()
  const clean = (basenames ?? []).map((b) => b.toLowerCase()).filter(Boolean)
  if (clean.length) all[modName] = [...new Set(clean)]
  else delete all[modName]
  await mkdir(dirname(OVERRIDES_FILE), { recursive: true })
  const tmp = `${OVERRIDES_FILE}.tmp`
  await writeFile(tmp, JSON.stringify(all, null, 2) + '\n', 'utf8')
  await rename(tmp, OVERRIDES_FILE)
}

// The declared config basenames for a mod + where the declaration came from. An override
// wins; else the description parse; else none (→ heuristic). Basenames are lowercased.
export async function getDeclaration(
  modName: string,
): Promise<{ basenames: Set<string>; source: 'override' | 'description' | null }> {
  const overrides = await readConfigOverrides()
  if (overrides[modName]?.length) return { basenames: new Set(overrides[modName]), source: 'override' }
  const text = await loadDescription(modName)
  if (text) {
    const parsed = parseDeclaredConfigBasenames(text)
    if (parsed.size) return { basenames: parsed, source: 'description' }
  }
  return { basenames: new Set(), source: null }
}

// Back-compat helper used by discovery: just the basenames (override ∪ description).
export async function getDeclaredConfigBasenames(modName: string): Promise<Set<string>> {
  return (await getDeclaration(modName)).basenames
}
