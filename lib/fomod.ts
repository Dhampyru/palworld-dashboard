import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import AdmZip from 'adm-zip'
import { XMLParser } from 'fast-xml-parser'
import { currentGameDir } from '@/lib/instances'

// PATCH (not upstream): FOMOD variant picker (docs/specs/client-mod-sync.md §2c). A FOMOD
// is a Nexus installer whose `fomod/ModuleConfig.xml` offers mutually-exclusive variant
// options. The generic contingency (lib/archive.isFomodArchive) just flags it; this parses
// the options so the admin can PICK one and we install the chosen file(s) to the mod's own
// declared destinations (game-relative paths). MVP: groups + plugins + files/folders +
// requiredInstallFiles. Not handled: flag conditions / conditionalFileInstalls / step
// visibility — uncommon in Palworld FOMODs; the picker installs the selected plugins as-is.

export type FomodFile = { source: string; destination: string; isFolder: boolean }
export type FomodPlugin = { name: string; description: string; recommended: boolean; files: FomodFile[] }
export type FomodGroup = { name: string; type: string; plugins: FomodPlugin[] }
export type FomodConfig = { moduleName: string; requiredFiles: FomodFile[]; groups: FomodGroup[] }

const arr = <T>(x: T | T[] | undefined | null): T[] => (x == null ? [] : Array.isArray(x) ? x : [x])
const norm = (s: string) => String(s ?? '').replace(/\\/g, '/').replace(/^\/+/, '')

// The ModuleConfig.xml entry (case-insensitive), decoded from UTF-16LE/UTF-8/BOM.
function readModuleConfig(zip: AdmZip): string | null {
  const entry = zip.getEntries().find((e) => /(^|\/)fomod\/moduleconfig\.xml$/i.test(e.entryName.replace(/\\/g, '/')))
  if (!entry) return null
  const buf = entry.getData()
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le').replace(/^﻿/, '')
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.slice(3).toString('utf8')
  return buf.toString('utf8')
}

function parseFiles(filesNode: unknown): FomodFile[] {
  const node = filesNode as { file?: unknown; folder?: unknown } | undefined
  const out: FomodFile[] = []
  for (const f of arr(node?.file) as { '@_source'?: string; '@_destination'?: string }[])
    out.push({ source: norm(f['@_source'] ?? ''), destination: norm(f['@_destination'] ?? ''), isFolder: false })
  for (const f of arr(node?.folder) as { '@_source'?: string; '@_destination'?: string }[])
    out.push({ source: norm(f['@_source'] ?? ''), destination: norm(f['@_destination'] ?? ''), isFolder: true })
  return out.filter((f) => f.source && f.destination)
}

// Parse a FOMOD from a normalized zip buffer. Returns null if it isn't a FOMOD.
export function parseFomodConfig(zipBuffer: Buffer): FomodConfig | null {
  let zip: AdmZip
  try {
    zip = new AdmZip(zipBuffer)
  } catch {
    return null
  }
  const xml = readModuleConfig(zip)
  if (!xml) return null
  let doc: { config?: Record<string, unknown> }
  try {
    doc = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseAttributeValue: false }).parse(xml)
  } catch {
    return null
  }
  const config = doc.config
  if (!config) return null

  const mn = config.moduleName
  const moduleName =
    typeof mn === 'string' ? mn : mn && typeof mn === 'object' && '#text' in mn ? String((mn as { '#text': unknown })['#text']) : 'FOMOD mod'

  const requiredFiles = parseFiles((config as { requiredInstallFiles?: unknown }).requiredInstallFiles)

  const groups: FomodGroup[] = []
  const steps = arr((config.installSteps as { installStep?: unknown } | undefined)?.installStep) as Record<string, unknown>[]
  for (const step of steps) {
    const grps = arr((step.optionalFileGroups as { group?: unknown } | undefined)?.group) as Record<string, unknown>[]
    for (const g of grps) {
      const plugins: FomodPlugin[] = []
      const plugs = arr((g.plugins as { plugin?: unknown } | undefined)?.plugin) as Record<string, unknown>[]
      for (const p of plugs) {
        const type = String(
          (((p.typeDescriptor as { type?: { '@_name'?: string } } | undefined)?.type)?.['@_name']) ?? '',
        )
        plugins.push({
          name: String(p['@_name'] ?? 'Option'),
          description: String((p.description as string) ?? '').trim(),
          recommended: /recommended/i.test(type),
          files: parseFiles(p.files),
        })
      }
      groups.push({ name: String(g['@_name'] ?? 'Options'), type: String(g['@_type'] ?? 'SelectExactlyOne'), plugins })
    }
  }
  return { moduleName, requiredFiles, groups }
}

// Copy one FOMOD file/folder from the archive to its game-relative destination (path-safe).
async function placeFile(zip: AdmZip, f: FomodFile, gameDir: string): Promise<string[]> {
  const gameRoot = resolve(gameDir)
  const placed: string[] = []
  const entries = zip.getEntries()
  if (f.isFolder) {
    const prefix = f.source.replace(/\/?$/, '/').toLowerCase()
    for (const e of entries) {
      if (e.isDirectory) continue
      const name = e.entryName.replace(/\\/g, '/')
      if (!name.toLowerCase().startsWith(prefix)) continue
      const rel = name.slice(prefix.length)
      const dest = resolve(join(gameDir, f.destination, rel))
      if (dest !== gameRoot && !dest.startsWith(gameRoot + sep)) throw new Error(`Refusing to write outside the game dir: ${f.destination}/${rel}`)
      await mkdir(dirname(dest), { recursive: true })
      await writeFile(dest, e.getData())
      placed.push(join(f.destination, rel).replace(/\\/g, '/'))
    }
  } else {
    const entry = entries.find((e) => e.entryName.replace(/\\/g, '/').toLowerCase() === f.source.toLowerCase())
    if (!entry) throw new Error(`FOMOD file not found in archive: ${f.source}`)
    const dest = resolve(join(gameDir, f.destination))
    if (!dest.startsWith(gameRoot + sep)) throw new Error(`Refusing to write outside the game dir: ${f.destination}`)
    await mkdir(dirname(dest), { recursive: true })
    await writeFile(dest, entry.getData())
    placed.push(f.destination)
  }
  return placed
}

// Install the required files + the selected plugins' files. `selections` = per group index,
// the chosen plugin indices. Returns the destination paths written (game-relative).
export async function installFomodSelections(
  zipBuffer: Buffer,
  config: FomodConfig,
  selections: Record<number, number[]>,
): Promise<{ moduleName: string; installed: string[] }> {
  const zip = new AdmZip(zipBuffer)
  const gameDir = currentGameDir()
  const files: FomodFile[] = [...config.requiredFiles]
  for (const [gi, plugIdxs] of Object.entries(selections)) {
    const group = config.groups[Number(gi)]
    if (!group) continue
    for (const pi of plugIdxs) {
      const plugin = group.plugins[pi]
      if (plugin) files.push(...plugin.files)
    }
  }
  const installed: string[] = []
  for (const f of files) installed.push(...(await placeFile(zip, f, gameDir)))
  return { moduleName: config.moduleName, installed }
}
