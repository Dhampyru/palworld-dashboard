import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, sep } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import AdmZip from 'adm-zip'
import {
  isSafeModFolderName,
  pakModsDir,
  readModsTxt,
  resolveUe4ssModsDir,
  serializeModsTxt,
} from '@/lib/game-mods'
import { currentGameDir, currentInstanceId, DEFAULT_INSTANCE_ID } from '@/lib/instances'

const execFileP = promisify(execFile)

// PATCH (not upstream): PalSchema support (docs/specs/palschema-support.md).
// PalSchema mods are NOT standard UE4SS mods — they are folders of JSON/JSONC at
//   <Win64>/ue4ss/Mods/PalSchema/Mods/<modname>/
// one level deeper than a UE4SS mod, with NO mods.txt/enabled.txt registration
// (presence = active). PalSchema itself IS a normal UE4SS mod (folder
// <...>/ue4ss/Mods/PalSchema/, registered in mods.txt) that we install through a
// dedicated flatten-aware path here rather than the generic mod-install pipeline
// (which would double-nest a wrapper-folder zip). Kept a distinct module so none
// of this bends the existing UE4SS handling in lib/game-mods.ts.

const PALSCHEMA_FOLDER = 'PalSchema'
const backupDir = () => join(currentGameDir(), 'backups')
// Dashboard-owned record of the installed PalSchema version — PalSchema stores
// no reliable version string on disk, so we remember what we installed (same
// ./data volume as the backup scheduler / panel auth). Absent record → unknown.
const metaFile = () => currentInstanceId() === DEFAULT_INSTANCE_ID
  ? (process.env.PALSCHEMA_META_FILE ?? './data/palschema.json')
  : `./data/palschema.${currentInstanceId()}.json`
// pak-family asset extensions that belong at the pak-mod path, never inside a
// PalSchema JSON mod folder (hybrid mods, spec §3).
const PAK_ASSET = /\.(pak|utoc|ucas)$/i
const SAFE_ASSET_NAME = /^[A-Za-z0-9_.-]+\.(pak|utoc|ucas)$/i

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '')
}

// ── Paths ───────────────────────────────────────────────────────────────────

// The PalSchema loader-mod folder (<modsDir>/PalSchema), or null if UE4SS's Mods
// dir can't be resolved at all.
export async function resolvePalSchemaDir(): Promise<string | null> {
  const modsDir = await resolveUe4ssModsDir()
  return modsDir ? join(modsDir, PALSCHEMA_FOLDER) : null
}

// Where the PalSchema *sub-mods* live. The 0.6.1 release ships this folder as
// lowercase `mods/` — and the game volume is case-sensitive (Linux), so the
// dashboard MUST use the exact on-disk name or it would read/create a second,
// divergent directory PalSchema never scans. Prefer whichever case already
// exists; default to the shipped lowercase for a fresh create.
async function resolvePalSchemaModsDir(): Promise<string | null> {
  const dir = await resolvePalSchemaDir()
  if (!dir) return null
  for (const name of ['mods', 'Mods']) {
    try {
      await stat(join(dir, name))
      return join(dir, name)
    } catch {
      /* try next case */
    }
  }
  return join(dir, 'mods')
}

// ── Status & listing ─────────────────────────────────────────────────────────

export type PalSchemaStatus = {
  installed: boolean
  version: string | null
  submodCount: number
}

async function readMeta(): Promise<{ version?: string }> {
  try {
    return JSON.parse(await readFile(metaFile(), 'utf8')) as { version?: string }
  } catch {
    return {}
  }
}

async function writeMeta(meta: { version?: string }): Promise<void> {
  try {
    await mkdir(dirname(metaFile()), { recursive: true })
    await writeFile(metaFile(), JSON.stringify(meta, null, 2), 'utf8')
  } catch {
    /* best-effort — version display is non-critical */
  }
}

export async function readPalSchemaStatus(): Promise<PalSchemaStatus> {
  const dir = await resolvePalSchemaDir()
  if (!dir) return { installed: false, version: null, submodCount: 0 }
  try {
    await stat(dir)
  } catch {
    return { installed: false, version: null, submodCount: 0 }
  }
  const meta = await readMeta()
  const submods = await listPalSchemaSubmods()
  return { installed: true, version: meta.version ?? null, submodCount: submods.length }
}

export type PalSchemaSubmod = {
  name: string
  fileCount: number
  sizeBytes: number
  modifiedAt: string | null
}

// Recursively total file count + bytes + newest mtime for one sub-mod folder.
async function folderStats(dir: string): Promise<{ fileCount: number; sizeBytes: number; modifiedAt: number }> {
  let fileCount = 0
  let sizeBytes = 0
  let modifiedAt = 0
  const walk = async (d: string) => {
    let dirents
    try {
      dirents = await readdir(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of dirents) {
      const full = join(d, ent.name)
      if (ent.isDirectory()) {
        await walk(full)
      } else {
        try {
          const s = await stat(full)
          fileCount += 1
          sizeBytes += s.size
          modifiedAt = Math.max(modifiedAt, s.mtimeMs)
        } catch {
          /* skip */
        }
      }
    }
  }
  await walk(dir)
  return { fileCount, sizeBytes, modifiedAt }
}

export async function listPalSchemaSubmods(): Promise<PalSchemaSubmod[]> {
  const modsDir = await resolvePalSchemaModsDir()
  if (!modsDir) return []
  let dirents
  try {
    dirents = await readdir(modsDir, { withFileTypes: true })
  } catch {
    return [] // no PalSchema/Mods yet — none installed
  }
  const out: PalSchemaSubmod[] = []
  for (const ent of dirents) {
    if (!ent.isDirectory()) continue
    const { fileCount, sizeBytes, modifiedAt } = await folderStats(join(modsDir, ent.name))
    out.push({
      name: ent.name,
      fileCount,
      sizeBytes,
      modifiedAt: modifiedAt ? new Date(modifiedAt).toISOString() : null,
    })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

// ── Zip content-root resolution (shared by loader + sub-mod installs) ─────────

type ZipFile = { name: string; getData: () => Buffer; size: number }

function normalize(name: string): string {
  return name.replace(/\\/g, '/')
}

// Given the non-directory entries of a zip, find the content root: the deepest
// prefix reachable by descending through single wrapper folders (handles the
// Mod/Mod/ nesting trap). Returns the prefix ('' = zip root) plus the outermost
// top-level folder name (the natural mod name), or null if the layout isn't a
// single top-level folder.
function contentRoot(files: ZipFile[]): { prefix: string; topFolder: string | null } {
  const looseAtRoot = files.some((f) => !normalize(f.name).includes('/'))
  const topSegs = new Set(files.map((f) => normalize(f.name).split('/')[0]))
  if (looseAtRoot || topSegs.size !== 1) {
    // No single wrapper folder (loose files, or several top-level entries).
    return { prefix: '', topFolder: null }
  }
  const topFolder = [...topSegs][0]
  // Descend while the current level holds exactly one subfolder and no direct
  // files (e.g. Mod/Mod/... → strip the redundant wrapper).
  let prefix = `${topFolder}/`
  for (;;) {
    const under = files.map((f) => normalize(f.name)).filter((n) => n.startsWith(prefix))
    const rel = under.map((n) => n.slice(prefix.length))
    const directFile = rel.some((r) => !r.includes('/'))
    const childDirs = new Set(rel.map((r) => r.split('/')[0]))
    if (directFile || childDirs.size !== 1) break
    prefix += `${[...childDirs][0]}/`
  }
  return { prefix, topFolder }
}

// ── Sub-mod install / remove ──────────────────────────────────────────────────

export type SubmodInstallResult = {
  name: string // installed mod name(s), comma-joined (for the toast)
  names: string[]
  hybrid: boolean
  pakFiles: string[]
}

// Install PalSchema sub-mod(s) from a zip. Splits any pak-family assets out to the
// pak-mod path (hybrid mods), then locates the mod folder(s) across the layouts
// that show up in the wild:
//   - GAME-ROOT DROP-IN (common on Nexus): paths carry .../PalSchema/mods/<Name>/…
//     often prefixed with Pal/Binaries/Win64/Mods/… — anchor on that segment.
//     (The old code treated the shared `Pal/` prefix as the mod folder, so a mod
//     installed as "Pal" with its JSON buried at a wrong nested path.)
//   - BARE MOD FOLDER: <Name>/<rel> at the zip root (with Mod/Mod flattening).
export async function installPalSchemaSubmod(buffer: Buffer, replace = false): Promise<SubmodInstallResult> {
  const modsDir = await resolvePalSchemaModsDir()
  if (!modsDir) {
    throw new Error('PalSchema is not installed — install PalSchema first, then add mods to it.')
  }

  let zip: AdmZip
  try {
    zip = new AdmZip(buffer)
  } catch {
    throw new Error('Not a valid zip file')
  }
  const files: ZipFile[] = zip
    .getEntries()
    .filter((e) => !e.isDirectory)
    .map((e) => ({ name: e.entryName, getData: () => e.getData(), size: e.header.size }))
  if (!files.length) throw new Error('The zip is empty')

  // Separate pak-family assets (from ANYWHERE in the zip) from the JSON content.
  const pakEntries = files.filter((f) => PAK_ASSET.test(normalize(f.name)))
  const nonPak = files.filter((f) => !PAK_ASSET.test(normalize(f.name)))

  // Group the JSON content by mod folder. Anchored layout first (…/PalSchema/mods/
  // <Name>/…), else a single bare wrapper folder.
  const mods = new Map<string, { rel: string; f: ZipFile }[]>()
  const anchor = /(?:^|\/)PalSchema\/mods\/([^/]+)\/(.+)$/i
  for (const f of nonPak) {
    const m = normalize(f.name).match(anchor)
    if (!m) continue
    const list = mods.get(m[1]) ?? []
    list.push({ rel: m[2], f })
    mods.set(m[1], list)
  }
  if (mods.size === 0) {
    const { prefix, topFolder } = contentRoot(nonPak)
    if (!topFolder) {
      throw new Error(
        'Could not find a PalSchema mod folder — expected a single mod folder of JSON/JSONC, or paths under PalSchema/mods/<name>/.',
      )
    }
    const list: { rel: string; f: ZipFile }[] = []
    for (const f of nonPak) {
      const rel = normalize(f.name).slice(prefix.length)
      if (rel) list.push({ rel, f })
    }
    mods.set(topFolder, list)
  }

  // Validate EVERY mod folder before writing anything (fail closed).
  for (const [name, entries] of mods) {
    if (!isSafeModFolderName(name)) {
      throw new Error(`Unsafe mod folder name: "${name}"`)
    }
    // UE4SS-ONLY signals. NOTE: enabled.txt is deliberately NOT here — PalSchema mods use an
    // enabled.txt toggle too (same convention as UE4SS), so it can't discriminate. A real UE4SS
    // mod always carries scripts/, dlls/, main.lua, or a .lua/.dll; those still catch it.
    const looksLikeUe4ss = entries.some(({ rel }) => {
      const low = rel.toLowerCase()
      return (
        low.startsWith('scripts/') ||
        low.startsWith('dlls/') ||
        low === 'main.lua' ||
        low.endsWith('.lua') ||
        low.endsWith('.dll')
      )
    })
    if (looksLikeUe4ss) {
      throw new Error(
        'This looks like a standard UE4SS mod (has scripts/dlls), not a PalSchema mod. Use the UE4SS mod-install section above.',
      )
    }
    if (!entries.some(({ rel }) => /\.jsonc?$/i.test(rel))) {
      throw new Error(`"${name}" has no JSON/JSONC content — a PalSchema mod's data files are .json/.jsonc.`)
    }
    const targetDir = join(modsDir, name)
    if (!replace) {
      try {
        await stat(targetDir)
        throw new Error(`A PalSchema mod named "${name}" already exists — remove it first to replace it.`)
      } catch (err) {
        if (err instanceof Error && err.message.includes('already exists')) throw err
      }
    }
    for (const { rel } of entries) {
      const dest = join(targetDir, rel)
      if (dest !== targetDir && !dest.startsWith(targetDir + sep)) {
        throw new Error(`Refusing to install: entry "${rel}" would extract outside the mod folder`)
      }
    }
  }

  // Write the mod folder(s).
  const names: string[] = []
  for (const [name, entries] of mods) {
    const targetDir = join(modsDir, name)
    await mkdir(targetDir, { recursive: true })
    for (const { rel, f } of entries) {
      const dest = join(targetDir, rel)
      await mkdir(dirname(dest), { recursive: true })
      await writeFile(dest, f.getData())
    }
    names.push(name)
  }

  // Split pak-family assets out to the pak-mod path (never inside a JSON mod).
  const pakFiles: string[] = []
  if (pakEntries.length) {
    await mkdir(pakModsDir(), { recursive: true })
    for (const f of pakEntries) {
      const name = basename(normalize(f.name))
      if (!SAFE_ASSET_NAME.test(name)) continue
      const dest = join(pakModsDir(), name)
      if (dest !== pakModsDir() && !dest.startsWith(pakModsDir() + sep)) continue
      await writeFile(dest, f.getData())
      pakFiles.push(name)
    }
  }

  return { name: names.join(', '), names, hybrid: pakFiles.length > 0, pakFiles }
}

// Remove a PalSchema sub-mod. Snapshots the folder to the backups area first
// (palschema-<name>-<stamp>.tar.gz) so removal is reversible by hand — the same
// snapshot-before-destructive-action discipline as config writes.
export async function removePalSchemaSubmod(name: string): Promise<{ backup: string }> {
  if (!isSafeModFolderName(name)) throw new Error('Invalid mod name')
  const modsDir = await resolvePalSchemaModsDir()
  if (!modsDir) throw new Error('PalSchema is not installed')
  const dir = join(modsDir, name)
  await stat(dir) // throws if absent

  await mkdir(backupDir(), { recursive: true })
  // Folder names may contain spaces/punctuation; sanitize only the backup FILE name
  // (the tar still archives the real folder via -C).
  const safe = name.replace(/[^A-Za-z0-9_-]+/g, '_')
  const backup = `palschema-${safe}-${stamp()}.tar.gz`
  await execFileP('tar', ['-czf', join(backupDir(), backup), '-C', modsDir, name])
  await rm(dir, { recursive: true, force: true })
  return { backup }
}

// ── Loader install ────────────────────────────────────────────────────────────

// PalSchema pins to one specific linked UE4SS build. 0.6.1 pairs with the
// Okaetsu experimental-palworld build the loader installs. Bump both together.
export const PALSCHEMA_PINNED_TAG = '0.6.1'
const PALSCHEMA_RELEASE_API = `https://api.github.com/repos/Okaetsu/PalSchema/releases/tags/${PALSCHEMA_PINNED_TAG}`

export async function downloadPalSchemaRelease(): Promise<Buffer> {
  const rel = await fetch(PALSCHEMA_RELEASE_API, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'palworld-dashboard' },
    cache: 'no-store',
    signal: AbortSignal.timeout(15_000),
  })
  if (!rel.ok) throw new Error(`GitHub release lookup failed (${rel.status})`)
  const data = (await rel.json()) as { assets?: { name: string; browser_download_url: string }[] }
  // Prefer the STANDARD edition; the release also ships a *_Dev.zip (hot reload /
  // schema generation) that the server does not run (spec §4). Exclude it
  // explicitly rather than trusting asset order.
  const assets = (data.assets ?? []).filter((a) => /\.zip$/i.test(a.name) && !/dev/i.test(a.name))
  const asset = assets.find((a) => /palschema/i.test(a.name)) ?? assets[0]
  if (!asset) throw new Error('No standard PalSchema zip found in the release')
  const dl = await fetch(asset.browser_download_url, {
    headers: { 'User-Agent': 'palworld-dashboard' },
    cache: 'no-store',
    signal: AbortSignal.timeout(120_000),
  })
  if (!dl.ok) throw new Error(`Download failed (${dl.status})`)
  return Buffer.from(await dl.arrayBuffer())
}

// Install PalSchema (the loader) as a UE4SS mod folder <modsDir>/PalSchema and
// register it in mods.txt. Flatten-aware so a wrapper-folder zip doesn't nest.
export async function installPalSchemaLoader(
  buffer: Buffer,
  version?: string,
): Promise<{ version: string | null }> {
  const modsDir = await resolveUe4ssModsDir()
  if (!modsDir) throw new Error('UE4SS Mods directory not found — install/enable UE4SS first.')

  let zip: AdmZip
  try {
    zip = new AdmZip(buffer)
  } catch {
    throw new Error('Not a valid zip file')
  }
  const files: ZipFile[] = zip
    .getEntries()
    .filter((e) => !e.isDirectory)
    .map((e) => ({ name: e.entryName, getData: () => e.getData(), size: e.header.size }))
  if (!files.length) throw new Error('The zip is empty')

  // Anchor the PalSchema root on dlls/main.dll (the C++ mod's entry) rather than
  // the generic single-child descent — that descent is for the Mod/Mod sub-mod
  // trap and would wrongly dive INTO dlls/ when it's the only child. Everything
  // above dlls/main.dll is the wrapper (PalSchema/, or nested), and is stripped
  // so the contents land directly in <modsDir>/PalSchema.
  const mainDll = files.find((f) => /(^|\/)dlls\/main\.dll$/i.test(normalize(f.name)))
  if (!mainDll) {
    throw new Error(
      'This does not look like PalSchema (expected dlls/main.dll). If it is a PalSchema *mod*, use the sub-mod install below.',
    )
  }
  const anchor = normalize(mainDll.name)
  const prefix = anchor.slice(0, anchor.toLowerCase().lastIndexOf('dlls/main.dll'))
  const content = files
    .map((f) => ({ f, rel: normalize(f.name) }))
    .filter((x) => x.rel.startsWith(prefix) && x.rel.length > prefix.length)
    .map((x) => ({ f: x.f, rel: x.rel.slice(prefix.length) }))

  const targetDir = join(modsDir, PALSCHEMA_FOLDER)
  // Validate destinations before writing (fail closed).
  for (const { rel } of content) {
    const dest = join(targetDir, rel)
    if (dest !== targetDir && !dest.startsWith(targetDir + sep)) {
      throw new Error(`Refusing to install: entry "${rel}" would extract outside PalSchema/`)
    }
  }
  // Replace an existing install cleanly, but keep any operator sub-mods (the
  // release ships an empty mods/). Snapshot whichever case is on disk and restore
  // under the shipped lowercase `mods/`.
  let savedMods: { rel: string; data: Buffer }[] = []
  for (const caseName of ['mods', 'Mods']) {
    try {
      const existing = join(targetDir, caseName)
      await stat(existing)
      savedMods = await snapshotDir(existing, 'mods')
      break
    } catch {
      /* not this case */
    }
  }
  await rm(targetDir, { recursive: true, force: true })
  await mkdir(targetDir, { recursive: true })
  for (const { f, rel } of content) {
    const dest = join(targetDir, rel)
    await mkdir(dirname(dest), { recursive: true })
    await writeFile(dest, f.getData())
  }
  // Restore preserved sub-mods (the release ships an empty mods/).
  for (const { rel, data } of savedMods) {
    const dest = join(targetDir, rel)
    await mkdir(dirname(dest), { recursive: true })
    await writeFile(dest, data)
  }
  // The release's empty mods/ folder isn't among the zip's file entries (AdmZip
  // omits bare directories), so create it explicitly — that's PalSchema's sub-mod
  // scan folder, and it keeps the on-disk layout identical to a manual extract.
  await mkdir(join(targetDir, 'mods'), { recursive: true })

  // Register PalSchema in mods.txt as enabled (belt-and-suspenders — the release
  // also ships enabled.txt, which UE4SS honours on its own).
  const modsTxtPath = join(modsDir, 'mods.txt')
  const active = await readModsTxt(modsDir)
  active.set(PALSCHEMA_FOLDER, true)
  const tmp = `${modsTxtPath}.tmp`
  await writeFile(tmp, serializeModsTxt(active), 'utf8')
  await rename(tmp, modsTxtPath)

  const finalVersion = version ?? null
  await writeMeta({ version: finalVersion ?? undefined })
  return { version: finalVersion }
}

// Read every file under `dir` into memory, keyed by a path relative to `asRel`.
async function snapshotDir(dir: string, asRel: string): Promise<{ rel: string; data: Buffer }[]> {
  const out: { rel: string; data: Buffer }[] = []
  const walk = async (d: string, rel: string) => {
    let dirents
    try {
      dirents = await readdir(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of dirents) {
      const full = join(d, ent.name)
      const childRel = join(rel, ent.name)
      if (ent.isDirectory()) {
        await walk(full, childRel)
      } else {
        try {
          out.push({ rel: childRel, data: await readFile(full) })
        } catch {
          /* skip */
        }
      }
    }
  }
  await walk(dir, asRel)
  return out
}
