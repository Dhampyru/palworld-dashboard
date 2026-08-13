// SERVER-ONLY. PATCH (not upstream): "Extra files" for a client mod — operator-supplied files
// (audio, textures, sounds, data packs …) dropped into a chosen subfolder INSIDE a folder-based
// client mod, injected into the client loadout at build time (overlayClientModFilesInto, called
// from lib/client-loadout). Non-destructive: the mod's payload is never repacked; files overlay
// onto the produced mod folder. Delivery is client-only (rides install.bat). This is the general
// primitive; the motivating case is PalworldAreaMusic's music/<Category> + ambience/<Category>
// "bring your own music" folders, but it works for any BYO-content mod. Pairs with the config
// override overlay (which edits config files; this adds files).
import AdmZip from 'adm-zip'
import { cp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { clientModStorePath, listClientMods, type ClientMod } from '@/lib/client-mods'

export const MAX_FILE_BYTES = 50 * 1024 * 1024 // ~50 MB/file (owner's choice)

function storeRoot(): string {
  return join(process.env.DASHBOARD_DATA_DIR ?? './data', 'client-mod-files')
}

// Only folder-based mods (a Lua/ue4ss mod, or an unknown-zip that produces a Mods folder) have a
// destination folder to receive files. A bare pak has none.
export function canReceiveFiles(m: ClientMod): boolean {
  return m.kind === 'ue4ss' || m.kind === 'unknown'
}

// Relative destination path within the mod: no absolute, no traversal, forward-slash normalized.
export function safeRel(rel: string): string {
  const norm = rel.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '').trim()
  if (!norm) return '' // root of the mod folder
  for (const p of norm.split('/')) {
    if (p === '' || p === '.' || p === '..') throw new Error('Invalid destination path')
  }
  return norm
}

function safeFileName(filename: string): string {
  const b = basename(filename).replace(/[\r\n\t]/g, '').replace(/[\\/]/g, '_').trim()
  if (!b || b.startsWith('.')) throw new Error('Invalid filename')
  return b
}

// If EVERY zip entry sits under a single top-level directory, that's a wrapper folder (usually the
// mod's own name) — strip it so destination paths are relative to the mod ROOT (matching how the
// loadout places the mod). Returns '' when there's no single common wrapper.
function commonWrapper(dirs: string[]): string {
  const tops = new Set(dirs.map((d) => d.split('/')[0]).filter(Boolean))
  return tops.size === 1 ? [...tops][0]! : ''
}

async function walkDirsFs(base: string, rel: string, out: Set<string>): Promise<void> {
  let entries
  try {
    entries = await readdir(join(base, rel), { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const r = rel ? `${rel}/${e.name}` : e.name
    out.add(r)
    await walkDirsFs(base, r, out)
  }
}

// Destination subfolders inside a client mod (relative to its mod root), for the picker. Sourced
// from the stash payload (a zip, or the steam `content` dir). Empty is fine — the UI also allows a
// typed path.
export async function listModFolders(modId: string): Promise<string[]> {
  const m = (await listClientMods()).find((x) => x.id === modId)
  if (!m) return []
  const store = clientModStorePath(modId)
  const dirs = new Set<string>()
  try {
    if (m.payload === 'content') {
      await walkDirsFs(join(store, 'content'), '', dirs)
    } else if (m.payload === 'payload.zip') {
      const zip = new AdmZip(join(store, 'payload.zip'))
      for (const e of zip.getEntries()) {
        const p = e.entryName.replace(/\\/g, '/')
        const dirPart = e.isDirectory ? p.replace(/\/+$/, '') : p.slice(0, p.lastIndexOf('/'))
        if (!dirPart) continue
        // add every ancestor directory
        const parts = dirPart.split('/')
        for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join('/'))
      }
    }
  } catch {
    return []
  }
  const all = [...dirs]
  const wrap = commonWrapper(all)
  const rel = wrap
    ? all.filter((d) => d === wrap || d.startsWith(`${wrap}/`)).map((d) => (d === wrap ? '' : d.slice(wrap.length + 1)))
    : all
  return [...new Set(rel.filter(Boolean))].sort((a, b) => a.localeCompare(b))
}

// `duplicate` = a file the mod ALREADY ships at the same relative path (so overlaying it just
// re-ships the mod's own file — usually an accidental whole-folder upload). Informational only.
export type OverlayFile = { rel: string; name: string; bytes: number; duplicate?: boolean }

// Relative file paths (mod-root-relative, wrapper-stripped) the mod's payload already ships —
// used to flag overlay duplicates. Mirrors listModFolders' enumeration.
async function listModFiles(modId: string): Promise<Set<string>> {
  const m = (await listClientMods()).find((x) => x.id === modId)
  if (!m) return new Set()
  const store = clientModStorePath(modId)
  const out = new Set<string>()
  try {
    if (m.payload === 'content') {
      const base = join(store, 'content')
      const walk = async (rel: string): Promise<void> => {
        let entries
        try {
          entries = await readdir(join(base, rel), { withFileTypes: true })
        } catch {
          return
        }
        for (const e of entries) {
          const r = rel ? `${rel}/${e.name}` : e.name
          if (e.isDirectory()) await walk(r)
          else out.add(r)
        }
      }
      await walk('')
    } else if (m.payload === 'payload.zip') {
      const zip = new AdmZip(join(store, 'payload.zip'))
      const all = zip.getEntries().filter((e) => !e.isDirectory).map((e) => e.entryName.replace(/\\/g, '/'))
      const tops = new Set(all.map((p) => p.split('/')[0]).filter(Boolean))
      const wrap = tops.size === 1 ? [...tops][0]! : ''
      for (const p of all) out.add(wrap && (p === wrap || p.startsWith(`${wrap}/`)) ? p.slice(wrap.length + 1) : p)
    }
  } catch {
    /* ignore */
  }
  return out
}

// List the operator's stored extra files for a mod (relpath + filename + size + duplicate flag).
export async function listOverlay(modId: string): Promise<{ files: OverlayFile[]; totalBytes: number; duplicates: number }> {
  const root = join(storeRoot(), modId)
  const modFiles = await listModFiles(modId)
  const files: OverlayFile[] = []
  const walk = async (rel: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(join(root, rel), { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) await walk(r)
      else {
        const info = await stat(join(root, r)).catch(() => null)
        const slash = r.lastIndexOf('/')
        const relDir = slash >= 0 ? r.slice(0, slash) : ''
        files.push({ rel: relDir, name: e.name, bytes: info?.size ?? 0, duplicate: modFiles.has(r) })
      }
    }
  }
  await walk('')
  files.sort((a, b) => (a.rel + '/' + a.name).localeCompare(b.rel + '/' + b.name))
  return { files, totalBytes: files.reduce((s, f) => s + f.bytes, 0), duplicates: files.filter((f) => f.duplicate).length }
}

export async function addFile(modId: string, rel: string, filename: string, data: Buffer): Promise<OverlayFile> {
  const m = (await listClientMods()).find((x) => x.id === modId)
  if (!m) throw new Error('Unknown mod')
  if (!canReceiveFiles(m)) throw new Error('This mod type has no folder to add files to')
  if (data.length === 0) throw new Error('Empty file')
  if (data.length > MAX_FILE_BYTES) throw new Error(`File exceeds the ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB limit`)
  const relSafe = safeRel(rel)
  const name = safeFileName(filename)
  const dir = join(storeRoot(), m.id, relSafe)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, name), data)
  return { rel: relSafe, name, bytes: data.length }
}

// Bulk upload: a .zip whose internal structure mirrors the mod's folders (e.g. music/Caelid/
// track.mp3). Extract each file into the overlay at its relative path (optionally under `destRel`
// as a prefix). A single top-level WRAPPER dir that isn't one of the mod's real top-level folders
// (e.g. "PalworldAreaMusic/…" around the tree) is stripped, so both "zip the mod folder" and "zip
// the music/ambience folders" work. The zip is never written to disk — only the extracted files
// are kept — so there's nothing to clean up. Returns placement counts.
export async function addZipBulk(
  modId: string,
  destRel: string,
  zipBuffer: Buffer,
): Promise<{ count: number; totalBytes: number; skipped: number }> {
  const m = (await listClientMods()).find((x) => x.id === modId)
  if (!m) throw new Error('Unknown mod')
  if (!canReceiveFiles(m)) throw new Error('This mod type has no folder to add files to')
  const base = safeRel(destRel)

  let zip: AdmZip
  try {
    zip = new AdmZip(zipBuffer)
  } catch {
    throw new Error('Not a valid .zip file')
  }
  const fileEntries = zip.getEntries().filter((e) => !e.isDirectory)
  if (!fileEntries.length) throw new Error('The zip has no files')

  // Wrapper stripping only when NO destination prefix is given (then the zip is treated as
  // relative to the mod root, and a single non-mod top folder like "PalworldAreaMusic/" is a
  // wrapper). With a prefix, the zip is placed verbatim under it — never strip.
  let wrapper = ''
  if (!base) {
    const knownTop = new Set((await listModFolders(modId)).map((d) => d.split('/')[0]))
    const tops = new Set(fileEntries.map((e) => e.entryName.replace(/\\/g, '/').split('/')[0]).filter(Boolean))
    wrapper = tops.size === 1 && !knownTop.has([...tops][0]!) ? [...tops][0]! : ''
  }

  let count = 0
  let totalBytes = 0
  let skipped = 0
  for (const e of fileEntries) {
    let p = e.entryName.replace(/\\/g, '/')
    if (wrapper && (p === wrapper || p.startsWith(`${wrapper}/`))) p = p.slice(wrapper.length + 1)
    const name = basename(p)
    if (!name || name.startsWith('.')) {
      skipped++
      continue
    }
    const dir = p.slice(0, Math.max(0, p.length - name.length)).replace(/\/+$/, '')
    let relDir: string
    let safeN: string
    try {
      relDir = safeRel(base ? (dir ? `${base}/${dir}` : base) : dir)
      safeN = safeFileName(name)
    } catch {
      skipped++
      continue
    }
    const data = e.getData()
    if (!data.length || data.length > MAX_FILE_BYTES) {
      skipped++
      continue
    }
    const outDir = join(storeRoot(), m.id, relDir)
    await mkdir(outDir, { recursive: true })
    await writeFile(join(outDir, safeN), data)
    count++
    totalBytes += data.length
  }
  if (count === 0) throw new Error('Nothing placed — check the zip is structured like the mod folders')
  return { count, totalBytes, skipped }
}

export async function removeFile(modId: string, rel: string, filename: string): Promise<void> {
  const relSafe = safeRel(rel)
  const name = safeFileName(filename)
  // modId is a slug (store subdir); basename-guard it too.
  await rm(join(storeRoot(), basename(modId), relSafe, name), { force: true })
}

// Bulk remove: delete each listed file (each individually path-guarded). Best-effort.
export async function removeFiles(modId: string, items: { rel: string; filename: string }[]): Promise<number> {
  let removed = 0
  for (const it of items) {
    try {
      await removeFile(modId, it.rel ?? '', it.filename)
      removed++
    } catch {
      /* skip a bad entry */
    }
  }
  return removed
}

// Wipe every extra file for a mod (the whole overlay subtree). basename-guarded.
export async function clearOverlay(modId: string): Promise<void> {
  await rm(join(storeRoot(), basename(modId)), { recursive: true, force: true })
}

// Loadout hook: copy each mod's stored extra files into its produced bundle folder(s). `produced`
// maps client-mod id → the ue4ss/Mods folder name(s) it created. Returns the total files placed.
export async function overlayClientModFilesInto(modsDir: string, produced: Map<string, string[]>): Promise<number> {
  let placed = 0
  for (const [modId, folders] of produced) {
    if (!folders.length) continue
    const { files } = await listOverlay(modId)
    if (!files.length) continue
    for (const f of files) {
      for (const folder of folders) {
        const destDir = join(modsDir, folder, f.rel)
        await mkdir(destDir, { recursive: true })
        await cp(join(storeRoot(), modId, f.rel, f.name), join(destDir, f.name))
        placed += 1
      }
    }
  }
  return placed
}
