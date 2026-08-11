// SERVER-ONLY. PATCH (not upstream): map a Pal's INTERNAL name (as PalDefender logs it, e.g.
// "Sheepball") to its friendly display name ("Lamball"), using the operator-supplied Pal
// dataset. Clean-room: ships NO game data — it only READS data/pals.json if the operator has
// populated it. The public image bakes an EMPTY stub, so the map is empty and callers fall back
// to the internal name. Datasets are baked to PALWORLD_DATASETS_DIR (NOT ./data, which is a
// volume mount at runtime — see the Dockerfile), same source /api/datasets reads.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const DATASETS_DIR = process.env.PALWORLD_DATASETS_DIR ?? join(process.cwd(), 'data')

// PalDefender's log casing differs from the dataset's (`Sheepball` vs `SheepBall`), so key the
// map lowercased. `en_text` is the dataset's "missing localization" sentinel — treat as absent.
let cache: Map<string, string> | null = null

async function loadMap(): Promise<Map<string, string>> {
  if (cache) return cache
  const m = new Map<string, string>()
  try {
    const raw = await readFile(join(DATASETS_DIR, 'pals.json'), 'utf8')
    const arr = JSON.parse(raw) as { id?: unknown; name?: unknown }[]
    if (Array.isArray(arr)) {
      for (const p of arr) {
        // Trim: some dataset names carry a stray trailing space (e.g. "Tetroise ") that would
        // otherwise break the per-pal message lookup.
        const name = typeof p?.name === 'string' ? p.name.trim() : ''
        if (typeof p?.id === 'string' && name && name !== 'en_text') {
          m.set(p.id.toLowerCase(), name)
        }
      }
    }
  } catch {
    /* no/empty dataset → empty map (clean-room public image) → callers keep internal names */
  }
  cache = m
  return m
}

// Internal name → friendly, falling back to the input unchanged when there's no dataset entry
// (unknown Pal, or a clean-room build with empty datasets). A leading BOSS_/GYM_ variant prefix
// is retried stripped, since those alpha/tower variants share a base Pal's display name.
export async function friendlyPalName(internal: string): Promise<string> {
  if (!internal) return internal
  const m = await loadMap()
  if (m.size === 0) return internal
  const key = internal.toLowerCase()
  const hit = m.get(key) ?? m.get(key.replace(/^(boss_|gym_)/, ''))
  return hit ?? internal
}
