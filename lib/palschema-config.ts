import { cp, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { currentGameDir, currentInstanceId, DEFAULT_INSTANCE_ID } from '@/lib/instances'
import { writeConfigFileWithBackup } from '@/lib/config-write'
import { validateConfigContent, type ModConfigFormat } from '@/lib/mod-config'

// PATCH (not upstream): edit ANY installed PalSchema mod's DATA files (items/raw/blueprints
// *.jsonc) with CLIENT PARITY. PalSchema data (tech tree, recipes, items, …) is read by the
// CLIENT too, so an edit must reach clients. Each save writes the live SERVER file AND stores
// an OVERLAY; the loadout generator applies the overlay onto the client-placed submod, so one
// edit keeps the server and every client bundle in sync. See docs/specs/palschema-editor.md.

const DATA_DIR = resolve(process.env.DASHBOARD_DATA_DIR ?? './data')
// Per-instance overlay store (default keeps the base name, like other dashboard state).
function overlayDir(): string {
  return currentInstanceId() === DEFAULT_INSTANCE_ID
    ? join(DATA_DIR, 'palschema-overlays')
    : join(DATA_DIR, `palschema-overlays.${currentInstanceId()}`)
}
// Live server PalSchema submods dir (proxy layout).
function submodsDir(): string {
  return join(currentGameDir(), 'Pal', 'Binaries', 'Win64', 'ue4ss', 'Mods', 'PalSchema', 'mods')
}

const EDITABLE_EXT = /\.jsonc?$/i
const safeSeg = (s: string) => /^[^/\\]+$/.test(s) && s !== '.' && s !== '..'
// The loadout places PalSchema submods under a safeName'd folder (must match client-loadout's
// safeName() — spaces → underscores, hyphens kept), so the overlay target maps the same way.
const safeName = (n: string) => n.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'Mod'
const fmtOf = (p: string): ModConfigFormat => (p.toLowerCase().endsWith('.jsonc') ? 'jsonc' : 'json')

// Recursively list editable file paths (relative) under a dir.
async function walk(dir: string, rel = ''): Promise<string[]> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...(await walk(join(dir, e.name), r)))
    else if (EDITABLE_EXT.test(e.name)) out.push(r)
  }
  return out
}

// Resolve `<base>/<submod>/<rel>` and confirm it stays under the submod dir (path guard).
function resolveWithin(base: string, submod: string, rel: string): string | null {
  if (!safeSeg(submod)) return null
  const root = resolve(join(base, submod))
  const abs = resolve(join(base, submod, rel))
  if (abs !== root && !abs.startsWith(root + sep)) return null
  return abs
}

export type PalSchemaSubmod = { name: string; fileCount: number }
export async function listPalSchemaSubmods(): Promise<PalSchemaSubmod[]> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(submodsDir(), { withFileTypes: true })
  } catch {
    return []
  }
  const out: PalSchemaSubmod[] = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    out.push({ name: e.name, fileCount: (await walk(join(submodsDir(), e.name))).length })
  }
  return out.filter((s) => s.fileCount > 0).sort((a, b) => a.name.localeCompare(b.name))
}

export type PalSchemaFile = { rel: string; format: ModConfigFormat; overridden: boolean }
export async function listPalSchemaFiles(submod: string): Promise<PalSchemaFile[]> {
  if (!safeSeg(submod)) return []
  const rels = await walk(join(submodsDir(), submod))
  const out: PalSchemaFile[] = []
  for (const rel of rels) {
    let overridden = false
    const ov = resolveWithin(overlayDir(), submod, rel)
    if (ov) {
      try {
        await stat(ov)
        overridden = true
      } catch {
        /* no overlay */
      }
    }
    out.push({ rel, format: fmtOf(rel), overridden })
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel))
}

export async function readPalSchemaFile(
  submod: string,
  rel: string,
): Promise<{ content: string; format: ModConfigFormat } | null> {
  const abs = resolveWithin(submodsDir(), submod, rel)
  if (!abs || !EDITABLE_EXT.test(abs)) return null
  try {
    return { content: await readFile(abs, 'utf8'), format: fmtOf(abs) }
  } catch {
    return null
  }
}

export async function writePalSchemaFile(submod: string, rel: string, content: string): Promise<void> {
  const abs = resolveWithin(submodsDir(), submod, rel)
  if (!abs || !EDITABLE_EXT.test(abs)) throw new Error('File not found')
  try {
    await stat(abs) // only edit a file discovery actually produced
  } catch {
    throw new Error('File not found')
  }
  const normalized = validateConfigContent(fmtOf(abs), content)
  // 1. live server file — backed up + atomic; server applies it on next restart.
  await writeConfigFileWithBackup(abs, normalized)
  // 2. overlay copy so the loadout ships the same edit to clients (parity).
  const ov = resolveWithin(overlayDir(), submod, rel)
  if (ov) {
    await mkdir(join(ov, '..'), { recursive: true })
    const tmp = `${ov}.${process.pid}.tmp`
    await writeFile(tmp, normalized, 'utf8')
    await rename(tmp, ov)
  }
}

// Loadout hook: apply stored PalSchema edits onto the submods placed in the bundle, so the
// client gets the same data as the server. Only touches submods actually present in the
// bundle (client-only sets skip server-only edits). Returns the number of files overlaid.
export async function overlayPalSchemaInto(bundleSubmodsDir: string): Promise<number> {
  const ov = overlayDir()
  let submods: import('node:fs').Dirent[]
  try {
    submods = await readdir(ov, { withFileTypes: true })
  } catch {
    return 0
  }
  let n = 0
  for (const s of submods) {
    if (!s.isDirectory()) continue
    const target = join(bundleSubmodsDir, safeName(s.name)) // bundle uses the safeName'd folder
    try {
      await stat(target)
    } catch {
      continue // this submod isn't in the bundle
    }
    for (const rel of await walk(join(ov, s.name))) {
      const dst = join(target, rel)
      if (dst !== target && !dst.startsWith(target + sep)) continue
      await mkdir(join(dst, '..'), { recursive: true })
      await cp(join(ov, s.name, rel), dst)
      n++
    }
  }
  return n
}
