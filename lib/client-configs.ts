import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

// PATCH (not upstream): store for CLIENT mod runtime configs (docs/specs/client-mod-sync.md).
// Mods using DekModConfigMenu write their settings to
// Pal/Content/Paks/LogicMods/<name>.modconfig.json ON THE CLIENT. The dashboard/server can't
// generate these (they're client-runtime), so an admin uploads one per mod; the schema each
// file embeds drives a form editor, and the loadout overlays them all so every friend installs
// pre-configured. Stored flat (dashboard-global, like the client-mod store) — NOT a secret.

const DATA_DIR = resolve(process.env.DASHBOARD_DATA_DIR ?? './data')
const CONFIG_DIR = join(DATA_DIR, 'client-configs')

// Where these land on a client — DekModConfigMenu keeps them beside the paks.
export const CLIENT_CONFIG_REL = 'Pal/Content/Paks/LogicMods'

export function clientConfigsDir(): string {
  return CONFIG_DIR
}

// A plain *.json basename — no path separators, no traversal. (DekModConfigMenu names them
// "<ModName>.modconfig.json"; allow spaces/parens/() that appear in mod names.)
export function isSafeConfigName(name: string): boolean {
  return (
    /^[A-Za-z0-9 ._()+-]+\.json$/i.test(name) &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('..')
  )
}

export type ClientConfig = { name: string; json: unknown }

export async function listClientConfigs(): Promise<ClientConfig[]> {
  let entries: string[]
  try {
    entries = await readdir(CONFIG_DIR)
  } catch {
    return []
  }
  const out: ClientConfig[] = []
  for (const name of entries.sort((a, b) => a.localeCompare(b))) {
    if (!name.toLowerCase().endsWith('.json') || !isSafeConfigName(name)) continue
    try {
      out.push({ name, json: JSON.parse(await readFile(join(CONFIG_DIR, name), 'utf8')) })
    } catch {
      /* skip unparseable */
    }
  }
  return out
}

// Write a config (from the form editor or a validated upload). `json` must already be parsed.
export async function saveClientConfig(name: string, json: unknown): Promise<void> {
  if (!isSafeConfigName(name)) throw new Error('Invalid config filename — use a plain *.json name.')
  await mkdir(CONFIG_DIR, { recursive: true })
  await writeFile(join(CONFIG_DIR, name), JSON.stringify(json, null, 2), 'utf8')
}

export async function removeClientConfig(name: string): Promise<void> {
  if (!isSafeConfigName(name)) throw new Error('Invalid config filename')
  await rm(join(CONFIG_DIR, name), { force: true })
}

// Copy every stored client config into the loadout's LogicMods dir. Returns the count placed.
// Deduped path is fine — each config is a distinct filename. Used by the loadout generator.
export async function overlayClientConfigsInto(logicModsDir: string): Promise<number> {
  let entries: string[]
  try {
    entries = await readdir(CONFIG_DIR)
  } catch {
    return 0
  }
  let n = 0
  for (const name of entries) {
    if (!name.toLowerCase().endsWith('.json') || !isSafeConfigName(name)) continue
    await mkdir(logicModsDir, { recursive: true })
    await cp(join(CONFIG_DIR, name), join(logicModsDir, name))
    n++
  }
  return n
}
