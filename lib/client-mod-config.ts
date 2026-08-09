import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { validateConfigContent, type ModConfigFormat } from '@/lib/mod-config'
import { extractZipTolerant } from '@/lib/archive'
import { clientModStorePath, listClientMods } from '@/lib/client-mods'

// PATCH (not upstream): per-client-mod config editing (docs/specs/client-mod-sync.md §2c).
// Many client mods ship a config file (Scripts/config.lua, config.ini, …). The admin can
// edit it here so EVERY client's loadout ships the config the host expects. Edits are
// stored as an OVERRIDE (never mutating the staged payload) under the mod's store dir; the
// loadout generator overlays them onto the placed mod. Nothing here touches the server.

export type ClientConfigFormat = ModConfigFormat | 'text'
export type ClientModConfigFile = {
  id: string // = relWithin, the config's path within its mod folder (stable key)
  relWithin: string
  modFolder: string
  format: ClientConfigFormat
  content: string
  overridden: boolean
}

// A config-looking file: name mentions config/settings/options, a known extension, and not
// a readme/license. Matched on the basename.
const CONFIG_RE = /(config|settings|options|user_config)[^/]*\.(lua|jsonc?|ini|cfg|txt)$/i
const SKIP_RE = /(readme|license|licence|changelog|credits|notes?)/i

function formatOf(name: string): ClientConfigFormat {
  const l = name.toLowerCase()
  if (l.endsWith('.lua')) return 'lua'
  if (l.endsWith('.jsonc')) return 'jsonc'
  if (l.endsWith('.json')) return 'json'
  if (l.endsWith('.ini') || l.endsWith('.cfg')) return 'ini'
  return 'text' // .txt — freeform, no strict validation
}

// Validate per format (reuses the server editor's validator); 'text' passes through.
function validate(format: ClientConfigFormat, content: string): string {
  if (format === 'text') return content.replace(/\r\n/g, '\n')
  return validateConfigContent(format, content)
}

const overrideRoot = (modId: string) => join(clientModStorePath(modId), 'config-override')

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}
async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory()
  } catch {
    return false
  }
}

// A dir that IS a UE4SS mod (directly holds Scripts/ or dlls/ or enabled.txt or main.dll).
async function dirIsMod(dir: string): Promise<boolean> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return false
  }
  for (const e of entries) {
    const n = e.name.toLowerCase()
    if (e.isDirectory() && (n === 'scripts' || n === 'dlls')) return true
    if (e.isFile() && (n === 'enabled.txt' || n === 'main.dll')) return true
  }
  return false
}

async function walkFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) out.push(...(await walkFiles(full)))
    else out.push(full)
  }
  return out
}

// Nearest ancestor of `file` (walking up, not past `root`) that is a UE4SS mod dir. Config
// files that don't live under a mod (loose text, PalSchema data) return null → not shown.
async function modRootFor(file: string, root: string): Promise<string | null> {
  let dir = dirname(file)
  while (dir.startsWith(root)) {
    if (await dirIsMod(dir)) return dir
    if (dir === root) break
    dir = dirname(dir)
  }
  return null
}

// Materialize a mod's files to a temp dir so we can inspect them: steam items are already
// unpacked (content/), archive payloads are extracted with the tolerant zip extractor (unar
// choked on mods that pack malformed dir entries, e.g. OathrBGM). Returns the base dir + a
// cleanup. Bare paks have no config.
async function materialize(modId: string, payload: string): Promise<{ base: string; cleanup: () => Promise<void> } | null> {
  const store = clientModStorePath(modId)
  if (payload === 'content') return { base: join(store, 'content'), cleanup: async () => {} }
  if (payload === 'payload.pak') return null
  const dir = await mkdtemp(join(tmpdir(), 'cm-config-'))
  await extractZipTolerant(join(store, 'payload.zip'), dir)
  return { base: dir, cleanup: async () => void (await rm(dir, { recursive: true, force: true }).catch(() => {})) }
}

// The mod record (by id) or null.
async function modById(modId: string) {
  return (await listClientMods()).find((m) => m.id === modId) ?? null
}

// List a client mod's editable config files, each with its CURRENT content (override if the
// admin saved one, else the shipped default).
export async function listClientModConfigs(modId: string): Promise<ClientModConfigFile[]> {
  const mod = await modById(modId)
  if (!mod) throw new Error('No such client mod')
  const mat = await materialize(modId, mod.payload)
  if (!mat) return []
  try {
    const files = await walkFiles(mat.base)
    const seen = new Set<string>()
    const out: ClientModConfigFile[] = []
    for (const f of files) {
      const name = f.slice(f.lastIndexOf('/') + 1)
      if (!CONFIG_RE.test(name) || SKIP_RE.test(f)) continue
      const root = await modRootFor(f, mat.base)
      if (!root) continue // not under a mod folder → not placed on the client
      const relWithin = relative(root, f).replace(/\\/g, '/')
      if (seen.has(relWithin)) continue
      seen.add(relWithin)
      const overridePath = join(overrideRoot(modId), relWithin)
      const overridden = await exists(overridePath)
      const content = await readFile(overridden ? overridePath : f, 'utf8').catch(() => '')
      out.push({
        id: relWithin,
        relWithin,
        modFolder: relative(mat.base, root).replace(/\\/g, '/').split('/').pop() || relWithin,
        format: formatOf(name),
        content,
        overridden,
      })
    }
    out.sort((a, b) => a.relWithin.localeCompare(b.relWithin))
    return out
  } finally {
    await mat.cleanup()
  }
}

// Save an override for one config file (validated by format). relWithin identifies it.
export async function saveClientModConfig(modId: string, relWithin: string, content: string): Promise<void> {
  const mod = await modById(modId)
  if (!mod) throw new Error('No such client mod')
  if (relWithin.includes('..') || relWithin.startsWith('/')) throw new Error('Invalid config path')
  const normalized = validate(formatOf(relWithin), content)
  const dest = join(overrideRoot(modId), relWithin)
  await mkdir(dirname(dest), { recursive: true })
  const tmp = `${dest}.tmp`
  await writeFile(tmp, normalized, 'utf8')
  await cp(tmp, dest)
  await rm(tmp, { force: true }).catch(() => {})
}

// Drop an override → the loadout falls back to the mod's shipped config.
export async function clearClientModConfig(modId: string, relWithin: string): Promise<void> {
  if (relWithin.includes('..') || relWithin.startsWith('/')) throw new Error('Invalid config path')
  await rm(join(overrideRoot(modId), relWithin), { force: true }).catch(() => {})
}

// Override files for the loadout to overlay (relWithin → absolute path). Empty if none.
export async function readClientModConfigOverrides(modId: string): Promise<{ relWithin: string; absPath: string }[]> {
  const root = overrideRoot(modId)
  if (!(await isDir(root))) return []
  return (await walkFiles(root)).map((absPath) => ({ relWithin: relative(root, absPath).replace(/\\/g, '/'), absPath }))
}

// Does this mod have any config file (for the UI to show/hide the Config button cheaply)?
export async function clientModHasConfig(modId: string): Promise<boolean> {
  return (await listClientModConfigs(modId)).length > 0
}
