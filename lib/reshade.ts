// SERVER-ONLY. PATCH (not upstream): optional ReShade in the client loadout (docs/specs/
// reshade-loadout.md). ReShade is a client-side DirectX post-processing injector — it never
// touches the game server. When enabled, the loadout drops an operator-supplied ReShade "base"
// (the dxgi.dll injector + reshade-shaders/ + ReShade.ini) plus any preset .ini files into the
// bundle's Pal/Binaries/Win64/, so friends get the exact look in one install. UE4SS uses the
// dwmapi.dll proxy and ReShade uses dxgi.dll, so they coexist.
//
// Clean-room / licensing: NOTHING ships in the repo. The ReShade injector is BSD-3-Clause
// (redistributable WITH its notice) but the SHADERS are separately + variably licensed, so the
// base bundle is OPERATOR-SUPPLIED (uploaded once, stored in the data volume). Presets are tiny
// recipe .ini files added by upload or URL.
import AdmZip from 'adm-zip'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { normalizeArchiveToZip } from '@/lib/archive'
import { overlayShaderLibraryInto, resolvePresetShaders, type ShaderResolution } from '@/lib/reshade-shaders'

const DATA_DIR = resolve(process.env.DASHBOARD_DATA_DIR ?? './data')
const RESHADE_DIR = join(DATA_DIR, 'reshade')
const BASE_ZIP = join(RESHADE_DIR, 'base.zip')
const PRESETS_DIR = join(RESHADE_DIR, 'presets')
const CONFIG_FILE = join(DATA_DIR, 'reshade.json')

export type ReshadePreset = {
  file: string
  name: string
  source: string
  addedAt: number
  shaders?: ShaderResolution // dependency resolution report (resolved / missing / where-from)
}
export type ReshadeConfig = {
  enabled: boolean
  base: { name: string; sizeBytes: number; fileCount: number; addedAt: number } | null
  presets: ReshadePreset[]
}

const DEFAULT: ReshadeConfig = { enabled: false, base: null, presets: [] }

async function ensureDirs(): Promise<void> {
  await mkdir(PRESETS_DIR, { recursive: true })
}

export async function readReshadeConfig(): Promise<ReshadeConfig> {
  try {
    const c = JSON.parse(await readFile(CONFIG_FILE, 'utf8')) as Partial<ReshadeConfig>
    return {
      enabled: Boolean(c.enabled),
      base: c.base ?? null,
      presets: Array.isArray(c.presets) ? c.presets : [],
    }
  } catch {
    return { ...DEFAULT }
  }
}

async function writeReshadeConfig(c: ReshadeConfig): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true })
  await writeFile(CONFIG_FILE, JSON.stringify(c, null, 2), 'utf8')
}

export async function setReshadeEnabled(enabled: boolean): Promise<ReshadeConfig> {
  const c = await readReshadeConfig()
  c.enabled = enabled
  await writeReshadeConfig(c)
  return c
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9._ -]+/g, '_').replace(/^[_ ]+|[_ ]+$/g, '') || 'preset'

// Save the ReShade base bundle. Accepts any archive (normalized to zip); it must contain the
// Win64-relative injector layout (dxgi.dll + reshade-shaders/, etc.). Stored verbatim as base.zip.
export async function saveReshadeBase(buffer: Buffer, name: string): Promise<ReshadeConfig> {
  await ensureDirs()
  let zipBuf: Buffer
  try {
    zipBuf = await normalizeArchiveToZip(buffer)
  } catch {
    throw new Error('Could not read that as an archive — upload the ReShade base as a .zip/.7z of the Win64 files.')
  }
  let entries
  try {
    entries = new AdmZip(zipBuf).getEntries().filter((e) => !e.isDirectory)
  } catch {
    throw new Error('The ReShade base must be a zip archive.')
  }
  const names = entries.map((e) => e.entryName.replace(/\\/g, '/').toLowerCase())
  // Sanity: a working base needs an injector DLL. Warn-hard rather than ship a dud.
  const hasInjector = names.some((n) => /(^|\/)(dxgi|d3d1[012]|reshade64|reshade32|opengl32|dinput8)\.dll$/i.test(n))
  if (!hasInjector) {
    throw new Error(
      'No ReShade injector DLL found in the base (expected dxgi.dll or similar). Upload a full portable ReShade folder (DLL + reshade-shaders/ + ReShade.ini).',
    )
  }
  await writeFile(BASE_ZIP, zipBuf)
  const c = await readReshadeConfig()
  c.base = { name, sizeBytes: zipBuf.length, fileCount: entries.length, addedAt: Date.now() }
  await writeReshadeConfig(c)
  return c
}

export async function clearReshadeBase(): Promise<ReshadeConfig> {
  await rm(BASE_ZIP, { force: true }).catch(() => {})
  const c = await readReshadeConfig()
  c.base = null
  await writeReshadeConfig(c)
  return c
}

// Pull preset .ini file(s) out of a raw .ini or an archive. Returns [{name, content}].
function extractPresets(buffer: Buffer, filename: string): { name: string; content: string }[] {
  const looksIni = /\.ini$/i.test(filename) || buffer.slice(0, 4096).toString('utf8').includes('Techniques=')
  if (looksIni && buffer[0] !== 0x50 /* not 'PK' */ && buffer[0] !== 0x37 /* not 7z */) {
    return [{ name: filename.replace(/\.ini$/i, ''), content: buffer.toString('utf8') }]
  }
  // Archive → grab every .ini that looks like a ReShade preset.
  try {
    const zip = new AdmZip(buffer)
    const out: { name: string; content: string }[] = []
    for (const e of zip.getEntries()) {
      if (e.isDirectory) continue
      const n = e.entryName.replace(/\\/g, '/')
      if (!/\.ini$/i.test(n)) continue
      const content = e.getData().toString('utf8')
      if (/Techniques=|PreprocessorDefinitions=|\bTechnique\b/i.test(content)) {
        out.push({ name: n.split('/').pop()!.replace(/\.ini$/i, ''), content })
      }
    }
    return out
  } catch {
    return []
  }
}

// Add preset(s) from an uploaded buffer (raw .ini or archive). `source` is a label for the UI.
export async function addReshadePresetFromBuffer(buffer: Buffer, filename: string, source: string): Promise<ReshadeConfig> {
  await ensureDirs()
  // .7z/.rar → normalize so the zip extractor can read it; a raw .ini is left as-is.
  let buf = buffer
  if (buffer[0] === 0x37 || buffer[0] === 0x52 /* 7z / Rar */) buf = await normalizeArchiveToZip(buffer).catch(() => buffer)
  const found = extractPresets(buf, filename)
  if (!found.length) throw new Error('No ReShade preset (.ini with Techniques=) found in that upload.')
  const c = await readReshadeConfig()
  // The archive may bundle the preset's own shaders (e.g. Subtle Outline ships all its .fx) —
  // pass it to the resolver, which prefers bundled, then the library, then the known repos.
  const bundledZip = buffer[0] === 0x50 ? buffer : buf[0] === 0x50 ? buf : undefined
  for (const p of found) {
    const file = `${safe(p.name)}.ini`
    await writeFile(join(PRESETS_DIR, file), p.content, 'utf8')
    const shaders = await resolvePresetShaders(p.content, bundledZip).catch(() => undefined)
    c.presets = c.presets.filter((x) => x.file !== file)
    c.presets.push({ file, name: p.name, source, addedAt: Date.now(), shaders })
  }
  await writeReshadeConfig(c)
  return c
}

// Re-run shader resolution for all presets (e.g. after adding gap shaders or a repo comes online).
export async function reresolveAllPresets(): Promise<ReshadeConfig> {
  const c = await readReshadeConfig()
  for (const p of c.presets) {
    const content = await readFile(join(PRESETS_DIR, p.file), 'utf8').catch(() => '')
    if (content) p.shaders = await resolvePresetShaders(content).catch(() => p.shaders)
  }
  await writeReshadeConfig(c)
  return c
}

export async function removeReshadePreset(file: string): Promise<ReshadeConfig> {
  if (file.includes('/') || file.includes('..')) throw new Error('Invalid preset name')
  await rm(join(PRESETS_DIR, file), { force: true }).catch(() => {})
  const c = await readReshadeConfig()
  c.presets = c.presets.filter((p) => p.file !== file)
  await writeReshadeConfig(c)
  return c
}

// Loadout hook: overlay ReShade into the bundle's Win64 dir. No-op unless enabled + a base is
// present. Returns a summary { files, presets } (0 files → nothing shipped). Path-guarded so a
// crafted base zip can't escape Win64.
export async function overlayReshadeInto(win64Dir: string): Promise<{ files: number; presets: string[] }> {
  const c = await readReshadeConfig()
  if (!c.enabled || !c.base || !existsSync(BASE_ZIP)) return { files: 0, presets: [] }
  const root = resolve(win64Dir)
  let files = 0
  // 1. Extract the base (injector + shaders + ReShade.ini) into Win64.
  const zip = new AdmZip(await readFile(BASE_ZIP))
  for (const e of zip.getEntries()) {
    if (e.isDirectory) continue
    const rel = e.entryName.replace(/\\/g, '/')
    const dest = resolve(join(win64Dir, rel))
    if (dest !== root && !dest.startsWith(root + sep)) continue // path-escape guard
    await mkdir(join(dest, '..'), { recursive: true })
    await writeFile(dest, e.getData())
    files++
  }
  // 2. Overlay the resolved shader library (bundled + fetched .fx/.fxh + textures) into
  // reshade-shaders/ — this is what makes preset-only uploads actually work.
  files += await overlayShaderLibraryInto(win64Dir)
  // 3. Drop preset .ini files next to the DLL.
  const presets: string[] = []
  for (const p of c.presets) {
    const src = join(PRESETS_DIR, p.file)
    if (!existsSync(src)) continue
    await writeFile(join(win64Dir, p.file), await readFile(src))
    presets.push(p.name)
    files++
  }
  return { files, presets }
}

// For GET: current config + whether a base is actually on disk.
export async function reshadeStatus(): Promise<ReshadeConfig & { basePresent: boolean }> {
  const c = await readReshadeConfig()
  return { ...c, basePresent: c.base != null && existsSync(BASE_ZIP) }
}
