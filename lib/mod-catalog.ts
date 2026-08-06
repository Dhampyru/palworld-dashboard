import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
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

// The declared config basenames for one installed mod, or an empty set when the mod has
// no catalog entry / the dataset is absent / nothing parseable was found. A non-empty
// result makes discovery authoritative (show only the declared config); empty → heuristic.
export async function getDeclaredConfigBasenames(modName: string): Promise<Set<string>> {
  const text = await loadDescription(modName)
  if (!text) return new Set()
  return parseDeclaredConfigBasenames(text)
}
