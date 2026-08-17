import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { extractZipTolerant } from '@/lib/archive'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { currentGameDir, currentRestConfig } from '@/lib/instances'
import { serializeModsTxt } from '@/lib/game-mods'
import { UE4SS_FRAMEWORK_DEFAULTS } from '@/lib/ue4ss-framework-defaults'
import { clientModStorePath, listClientMods, type ClientMod } from '@/lib/client-mods'
import { readClientModConfigOverrides } from '@/lib/client-mod-config'
import { overlayClientConfigsInto } from '@/lib/client-configs'
import { overlayPalSchemaInto } from '@/lib/palschema-config'
import { overlayClientModFilesInto } from '@/lib/client-mod-files'
import { overlayReshadeInto } from '@/lib/reshade'
import { resolveConnectString } from '@/lib/loadout-connect'

const execFileP = promisify(execFile)

// PATCH (not upstream): the client-loadout generator (docs/specs/client-mod-sync.md §2c,
// Phase 2). Turns the KEPT staged client mods into a self-contained **Classic-UE4SS**
// bundle a friend extracts over their Palworld install — so they don't touch Steam
// Workshop, Nexus, or any directory layout. Reuses the SERVER's placement conventions
// (ue4ss/Mods for Lua, ~mods for paks, InstallRule for Workshop items) + the UE4SS
// framework from the live install. Assembled ON DISK and zipped via the `zip` CLI so the
// ~1GB set never sits in a Node buffer; big archive payloads are unpacked with `unar`.
//
// HONEST BOUNDARY: this verifies + assembles the correct on-disk layout. Whether a
// friend's game actually LOADS every mod can only be confirmed on a real client — we
// can't run one here. Uncertain mods are recorded in the bundle manifest, not dropped.

// Framework Mods to ENABLE in the generated mods.txt (load-bearing for other mods). Other
// bundled framework defaults (dev/diagnostic tools) are included but left disabled.
const ENABLED_FRAMEWORK = new Set(['BPModLoaderMod', 'BPML_GenericFunctions', 'Keybinds', 'ConsoleEnablerMod'])

export type LoadoutMod = { name: string; kind: string; source: string; placed: string[] }
export type LoadoutSkip = { name: string; reason: string }
export type LoadoutSummary = {
  includedUe4ss: boolean
  luaMods: string[]
  pakFiles: string[]
  logicMods: string[]
  mods: LoadoutMod[]
  skipped: LoadoutSkip[]
  totalKept: number
  configOverrides: number // admin config edits shipped into the bundle
  extraFiles: number // operator files added to client mods (music/textures/data) overlaid in
  parityPaks: number // server ~mods/LogicMods paks folded in for client-server parity
  palSchemaMods: number // PalSchema submods shipped (server parity + client-only payloads)
  preConfigFiles: number // admin-captured runtime config files overlaid into the game tree
  palSchemaEdits: number // admin PalSchema data edits overlaid onto client submods (parity)
  engineTweaks: string[] // mods whose Engine.ini settings were folded into recommended-engine-ini.txt
  reshade: { files: number; presets: string[] } // ReShade injector+shaders+presets overlaid into Win64 (if enabled)
  sizeBytes: number
  generatedAt: string
}
export type LoadoutResult = {
  zipPath: string
  bundleDir: string // the assembled tree (contains game/ + INSTALL.txt + …) — for FSA per-file serving
  fileName: string
  summary: LoadoutSummary
  cleanup: () => Promise<void>
}

function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'Mod'
}

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

// Recursively list absolute file paths under dir (dir itself must exist).
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

// A directory that IS a UE4SS Lua mod: it directly contains Scripts/ or dlls/ or
// enabled.txt or main.dll (mirrors game-mods.ts dirIsMod). A NESTED script doesn't count
// — that would make an outer wrapper folder look like a mod.
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

const PAK_RE = /\.(pak|utoc|ucas)$/i

// Copy every pak/utoc/ucas found anywhere under `roots` into destDir (flat). Returns the
// .pak basenames placed (for the summary). Deduped by basename. Explicit dest.
async function collectPaks(roots: string[], destDir: string, seen: Set<string>): Promise<string[]> {
  const placed: string[] = []
  for (const root of roots) {
    for (const f of await walkFiles(root)) {
      if (!PAK_RE.test(f)) continue
      const name = basename(f)
      if (seen.has(name.toLowerCase())) continue
      seen.add(name.toLowerCase())
      await mkdir(destDir, { recursive: true })
      await cp(f, join(destDir, name))
      if (/\.pak$/i.test(name)) placed.push(name)
    }
  }
  return placed
}

// Like collectPaks but ROUTES each pak by its path: a pak under a LogicMods/ folder is a
// Blueprint LogicMod (→ Content/Paks/LogicMods), everything else → ~mods. This is what a
// bare Nexus/upload archive needs (Steam items are routed by their InstallRule instead).
async function collectPaksRouted(
  roots: string[],
  pakDir: string,
  logicDir: string,
  seen: Set<string>,
): Promise<{ paks: string[]; logic: string[]; dupes: number }> {
  const paks: string[] = []
  const logic: string[] = []
  let dupes = 0 // pak(s) present but already placed by an earlier mod (a staged duplicate)
  for (const root of roots) {
    for (const f of await walkFiles(root)) {
      if (!PAK_RE.test(f)) continue
      const name = basename(f)
      if (seen.has(name.toLowerCase())) {
        if (/\.pak$/i.test(name)) dupes++
        continue
      }
      seen.add(name.toLowerCase())
      const isLogic = /(^|\/)logicmods\//i.test(f.replace(/\\/g, '/'))
      const dest = isLogic ? logicDir : pakDir
      await mkdir(dest, { recursive: true })
      await cp(f, join(dest, name))
      if (/\.pak$/i.test(name)) (isLogic ? logic : paks).push(name)
    }
  }
  return { paks, logic, dupes }
}

// Find the Lua/BP mod dir(s) inside an extracted archive, at ANY depth. Handles: the mod
// folder at the root, several mod folders, guts-at-root (Scripts/ at the root), AND the
// common Nexus packaging that ships the whole game path
// (`Pal/Binaries/Win64/ue4ss/Mods/<name>/…`). A dir that IS a mod isn't descended into,
// so we never mistake a mod's own Scripts/dlls subfolder for another mod.
// A path segment naming a NON-Windows/Steam platform variant. Many Nexus archives ship both
// a Steam/Win64 build and an Xbox/Gamepass (WinGDK) build side by side, e.g.
// `(STEAM)/…/Win64/…/<mod>` + `(XBOX)/…/WinGDK/…/<mod>`. Placing both gives a duplicate mod
// (e.g. UniPalUI + UniPalUI-2) — and a duplicated C++ mod double-registers native hooks and
// crashes the client on launch. We keep the Windows/Steam side and skip these.
const NON_WINDOWS_VARIANT = /(?:^|[^a-z0-9])(xbox|wingdk|win_?gdk|gamepass|gdk)(?:[^a-z0-9]|$)/i

async function findLuaModRoots(scratch: string, fallbackName: string): Promise<{ name: string; dir: string }[]> {
  if (await dirIsMod(scratch)) return [{ name: safeName(fallbackName), dir: scratch }]
  const mods: { name: string; dir: string }[] = []
  const rec = async (dir: string): Promise<void> => {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      if (NON_WINDOWS_VARIANT.test(e.name)) continue // skip Xbox/GDK/Gamepass platform variants
      const full = join(dir, e.name)
      if (await dirIsMod(full)) mods.push({ name: safeName(e.name), dir: full })
      else await rec(full)
    }
  }
  await rec(scratch)
  return mods
}

// Unpack an archive to destDir without loading it into a Node buffer (`unar`, no wrapper
// dir). Big paks (500MB+) never touch process memory this way.
async function unpack(archivePath: string, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true })
  // Zips: extract per-entry with adm-zip (mirrors the SERVER installer). This is robust to
  // archives with malformed directory entries — e.g. a 0-byte "Pal" entry WITHOUT a trailing
  // slash that unar turns into a FILE, then fails every subdir with "Could not create
  // directory" AND still exits 0 (so the loadout couldn't even detect it). OathrBGM ships
  // exactly this on both its steam and gamepass files. unar stays the fallback for rar/7z,
  // which adm-zip can't read (client payloads are normalized to zip on staging, so the zip
  // path is the norm).
  if (/\.zip$/i.test(archivePath)) {
    await extractZipTolerant(archivePath, destDir)
    return
  }
  await execFileP('unar', ['-D', '-f', '-o', destDir, archivePath], { maxBuffer: 8 * 1024 * 1024 })
}

// Structure-based placement for a Workshop item with NO Info.json (mirrors the server's
// installWorkshopByStructure): Scripts/dlls/enabled.txt → a ue4ss/Mods/<pkg> folder, and
// paks routed by path (LogicMods/ → LogicMods, else → ~mods). Without this a no-manifest
// Workshop mod installs on the server but is silently dropped from the client bundle.
async function placeWorkshopByStructure(
  contentDir: string,
  pkg: string,
  paths: { modsDir: string; pakDir: string; logicDir: string },
  luaMods: string[],
  seenPaks: Set<string>,
  uniqueMod: (base: string) => string,
  produced: string[],
): Promise<string[]> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(contentDir, { withFileTypes: true })
  } catch {
    return []
  }
  const META = new Set(['thumbnail.png', '.workshop.json', 'info.json'])
  const SUBDIRS = new Set(['logicmods', 'palschema']) // paks routed below; PalSchema via collectSteamPalSchema
  const placed: string[] = []

  const codeEntries = entries.filter((e) => {
    const low = e.name.toLowerCase()
    if (e.isDirectory()) return !SUBDIRS.has(low)
    return !META.has(low) && !PAK_RE.test(e.name)
  })
  const hasLua = codeEntries.some((e) => {
    const low = e.name.toLowerCase()
    return (
      (e.isDirectory() && (low === 'scripts' || low === 'dlls')) ||
      /\.lua$/i.test(e.name) ||
      low === 'enabled.txt' ||
      low === 'main.dll'
    )
  })
  if (hasLua) {
    const name = uniqueMod(safeName(pkg))
    const dest = join(paths.modsDir, name)
    await mkdir(dest, { recursive: true })
    for (const e of codeEntries) await cp(join(contentDir, e.name), join(dest, e.name), { recursive: true })
    luaMods.push(name)
    produced.push(name)
    placed.push(`ue4ss/Mods/${name}`)
  }

  const routed = await collectPaksRouted([contentDir], paths.pakDir, paths.logicDir, seenPaks)
  if (routed.paks.length) placed.push(`~mods (${routed.paks.length})`)
  if (routed.logic.length) placed.push(`LogicMods (${routed.logic.length})`)
  return placed
}

// Steam Workshop InstallRule placement for a client (mirrors game-mods.installWorkshop
// PackageToProxy, but CLIENT rules and into the bundle). Returns where things landed.
async function placeWorkshop(
  contentDir: string,
  pkg: string,
  paths: { modsDir: string; pakDir: string; logicDir: string },
  luaMods: string[],
  seenPaks: Set<string>,
  uniqueMod: (base: string) => string,
  produced: string[],
): Promise<string[]> {
  let info: { InstallRule?: unknown; PackageName?: string }
  try {
    info = JSON.parse((await readFile(join(contentDir, 'Info.json'), 'utf8')).replace(/^\uFEFF/, ''))
  } catch {
    // No Info.json manifest — place by STRUCTURE (mirrors the server's fallback) so a
    // no-manifest Workshop mod still ships to clients instead of being silently dropped.
    return placeWorkshopByStructure(contentDir, pkg, paths, luaMods, seenPaks, uniqueMod, produced)
  }
  // Prefer the item's own PackageName for the mod folder (ASCII, stable) over the display
  // name (which may be non-ASCII → a generic folder name).
  const pkgName = typeof info.PackageName === 'string' && info.PackageName.trim() ? info.PackageName.trim() : pkg
  const rules = (Array.isArray(info.InstallRule) ? info.InstallRule : []) as {
    Type?: string
    Targets?: unknown
    IsServer?: boolean
  }[]
  // For a CLIENT bundle prefer the non-server rules; fall back to all if none are marked.
  const clientRules = rules.filter((r) => r?.IsServer !== true)
  const use = clientRules.length ? clientRules : rules
  const placed: string[] = []
  const resolveTargets = (t: unknown): string[] =>
    Array.isArray(t) && t.length ? (t as unknown[]).map(String) : ['.']
  for (const r of use) {
    const type = String(r?.Type ?? '')
    const targets = resolveTargets(r?.Targets)
    const roots = targets.map((t) => {
      const c = t.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
      return c === '' || c === '.' ? contentDir : join(contentDir, c)
    })
    if (type === 'Lua') {
      const name = uniqueMod(safeName(pkgName))
      const dest = join(paths.modsDir, name)
      for (const root of roots) {
        if (root !== contentDir && !root.startsWith(contentDir + sep)) continue
        if (!(await isDir(root))) continue
        // A NAMED target folder (e.g. ./Scripts) must keep its name under the mod dir so
        // UE4SS finds Mods/<pkg>/Scripts/main.lua. Copying its CONTENTS into the mod root
        // (the old behavior) left main.lua at Mods/<pkg>/main.lua, which UE4SS never loads
        // — so the mod's Lua silently didn't run on clients. A '.' target copies the
        // content root (which already contains Scripts/) into the mod dir.
        const dst = root === contentDir ? dest : join(dest, basename(root))
        await cp(root, dst, { recursive: true })
      }
      luaMods.push(name)
      produced.push(name)
      placed.push(`ue4ss/Mods/${name}`)
    } else if (type === 'Paks') {
      const p = await collectPaks(roots, paths.pakDir, seenPaks)
      if (p.length) placed.push(`~mods (${p.length})`)
    } else if (type === 'LogicMods') {
      const p = await collectPaks(roots, paths.logicDir, seenPaks)
      if (p.length) placed.push(`LogicMods (${p.length})`)
    }
    // PalSchema / UE4SS rules are server-side / framework — skipped for a client.
  }
  return placed
}

// Copy the UE4SS framework (loader + core + framework-default Mods) from the LIVE install
// into the bundle, so it's self-contained. Returns false if UE4SS isn't found on disk.
async function includeFramework(win64Dest: string, modsDir: string): Promise<boolean> {
  const liveWin64 = join(currentGameDir(), 'Pal', 'Binaries', 'Win64')
  const liveUe4ss = join(liveWin64, 'ue4ss')
  if (!(await exists(join(liveWin64, 'dwmapi.dll'))) || !(await isDir(liveUe4ss))) return false
  await mkdir(join(win64Dest, 'ue4ss'), { recursive: true })
  await cp(join(liveWin64, 'dwmapi.dll'), join(win64Dest, 'dwmapi.dll'))
  // ue4ss/ core: everything except the Mods tree (handled below), the log, and crash
  // artifacts. Crash dumps (crash_*.dmp) + logs accumulate in the live server's ue4ss dir
  // and must NEVER ship to clients — that dragged 150+ server dumps into friend bundles.
  for (const e of await readdir(liveUe4ss, { withFileTypes: true })) {
    if (e.name === 'Mods' || e.name === 'UE4SS.log') continue
    if (/\.(dmp|log)$/i.test(e.name)) continue // crash dumps / logs — server junk, not client files
    await cp(join(liveUe4ss, e.name), join(win64Dest, 'ue4ss', e.name), { recursive: true })
  }
  // Framework Mods the client needs: `shared` (runtime lib) + the bundled defaults.
  await mkdir(modsDir, { recursive: true })
  for (const name of ['shared', ...UE4SS_FRAMEWORK_DEFAULTS.keys()]) {
    const src = join(liveUe4ss, 'Mods', name)
    if (await isDir(src)) await cp(src, join(modsDir, name), { recursive: true })
  }
  return true
}

// Copy ONLY the PalSchema loader framework (dlls/config/enabled.txt — NOT its mods/ subtree)
// from the live install into the bundle, so the client-relevant PalSchema submods we placed
// have a loader. Server-only PalSchema mods are intentionally NOT bulk-copied — clients get
// only the PalSchema submods that belong to the curated client set. Returns false if
// PalSchema isn't installed server-side.
async function includePalSchemaFramework(modsDir: string): Promise<boolean> {
  const livePS = join(currentGameDir(), 'Pal', 'Binaries', 'Win64', 'ue4ss', 'Mods', 'PalSchema')
  if (!(await isDir(livePS))) return false
  const destPS = join(modsDir, 'PalSchema')
  await mkdir(destPS, { recursive: true })
  for (const e of await readdir(livePS, { withFileTypes: true })) {
    if (e.name === 'mods') continue // submods are placed per client mod, not bulk-copied
    await cp(join(livePS, e.name), join(destPS, e.name), { recursive: true })
  }
  return true
}

// A Steam Workshop client mod can carry PalSchema data as a `./PalSchema/` wrapper whose
// CONTENTS are the submod (blueprints/, buildings/, resources/, …) — cf. Glider Restoration,
// Palvolve. Flatten that wrapper into PalSchema/mods/<PackageName>/. Returns the folder name
// placed, or null if there's no PalSchema wrapper. Deduped by name via `seen`.
async function collectSteamPalSchema(
  contentDir: string,
  fallbackName: string,
  destModsDir: string,
  seen: Set<string>,
): Promise<string | null> {
  const wrapper = join(contentDir, 'PalSchema')
  if (!(await isDir(wrapper))) return null
  let pkg = safeName(fallbackName)
  try {
    const info = JSON.parse((await readFile(join(contentDir, 'Info.json'), 'utf8')).replace(/^\uFEFF/, '')) as { PackageName?: unknown }
    if (typeof info.PackageName === 'string' && info.PackageName.trim()) pkg = safeName(info.PackageName.trim())
  } catch {
    /* fall back to the mod name */
  }
  if (seen.has(pkg.toLowerCase())) return null
  seen.add(pkg.toLowerCase())
  const dest = join(destModsDir, pkg)
  await mkdir(dest, { recursive: true })
  for (const e of await readdir(wrapper, { withFileTypes: true })) {
    await cp(join(wrapper, e.name), join(dest, e.name), { recursive: true })
  }
  return pkg
}

// PalSchema submod content dirs (mirrors the real layout: items/raw/blueprints/pals/skins/…
// each holding .json). Used to recognize a PalSchema submod folder in an arbitrary payload.
const PS_CONTENT_DIRS = new Set([
  'items', 'raw', 'blueprints', 'pals', 'skins', 'palskins', 'appearance', 'humans', 'monsters',
  'translations', 'meshes', 'maps', 'movesets', 'passives',
])

// Does `dir` look like a PalSchema submod folder — i.e. it directly contains a PalSchema
// content subdir (items/raw/…) with a .json inside? Excludes SwapJSON (the Altermatic
// recolor framework's config dir, which also holds .json but is NOT PalSchema).
async function looksLikePalSchemaSubmod(dir: string): Promise<boolean> {
  if (basename(dir).toLowerCase() === 'swapjson') return false
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return false
  }
  for (const e of entries) {
    if (!e.isDirectory() || !PS_CONTENT_DIRS.has(e.name.toLowerCase())) continue
    for (const f of await walkFiles(join(dir, e.name))) if (/\.jsonc?$/i.test(f)) return true
  }
  return false
}

// Find genuine PalSchema submod folder(s) in an extracted payload, at any depth. Handles the
// explicit `…/PalSchema/mods/<name>/…` layout AND a bare mod folder whose contents are
// PalSchema data (e.g. Food Expansion's `NewFoodRecipes/items/*.json`). Skips SwapJSON.
async function findPalSchemaSubmods(scratch: string): Promise<{ name: string; dir: string }[]> {
  const out: { name: string; dir: string }[] = []
  const rec = async (dir: string): Promise<void> => {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    // Explicit `PalSchema/mods/<name>/` — each child dir is a submod.
    if (basename(dir).toLowerCase() === 'mods' && basename(dirname(dir)).toLowerCase() === 'palschema') {
      for (const e of entries) if (e.isDirectory()) out.push({ name: safeName(e.name), dir: join(dir, e.name) })
      return
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const full = join(dir, e.name)
      if (await looksLikePalSchemaSubmod(full)) out.push({ name: safeName(e.name), dir: full })
      else await rec(full)
    }
  }
  await rec(scratch)
  return out
}

// Place any genuine PalSchema submods from `scratch` into the bundle's PalSchema/mods dir,
// deduped by folder name against what's already there. `placed` = newly copied (client-only
// PalSchema not on the server); `covered` = found but already shipped via server parity.
async function collectPalSchemaSubmods(
  scratch: string,
  destModsDir: string,
  seen: Set<string>,
): Promise<{ placed: string[]; covered: string[] }> {
  const placed: string[] = []
  const covered: string[] = []
  for (const { name, dir } of await findPalSchemaSubmods(scratch)) {
    if (seen.has(name.toLowerCase())) {
      covered.push(name)
      continue
    }
    seen.add(name.toLowerCase())
    await mkdir(destModsDir, { recursive: true })
    await cp(dir, join(destModsDir, name), { recursive: true })
    placed.push(name)
  }
  return { placed, covered }
}

// Merge the [SystemSettings] tweaks a friend must paste into their client Engine.ini
// (mods that ship only Engine.ini text — e.g. the FPS boosters — can't be auto-installed
// because a client's Engine.ini lives in %LOCALAPPDATA%, outside the game folder we overlay).
function recommendedEngineIni(tweaks: { name: string; text: string }[]): string {
  const settings = new Map<string, string>() // key(lower) -> full line; last source wins
  const sources: string[] = []
  for (const t of tweaks) {
    let any = false
    for (const raw of t.text.split(/\r?\n/)) {
      const line = raw.trim()
      if (!line || line.startsWith(';') || line.startsWith('#') || line.startsWith('[')) continue
      const m = line.match(/^([\w.]+)\s*=/)
      if (m) {
        settings.set(m[1].toLowerCase(), line)
        any = true
      }
    }
    if (any) sources.push(t.name)
  }
  const body = [
    'Recommended Engine.ini performance settings',
    '===========================================',
    'These come from mods that are just Engine.ini tweaks (not installable files):',
    ...sources.map((s) => `  - ${s}`),
    '',
    'HOW TO APPLY (optional, improves FPS):',
    '  1. Close Palworld.',
    '  2. Open (create the file if missing):',
    '       %LOCALAPPDATA%\\Pal\\Saved\\Config\\Windows\\Engine.ini',
    '  3. Paste the block below at the end. If you already have a [SystemSettings]',
    '     section, merge these lines into it (do not add a second header).',
    '  4. Save, then launch Palworld.',
    '',
    '[SystemSettings]',
    ...[...settings.values()],
    '',
  ].join('\r\n')
  return body
}

function installTxt(s: LoadoutSummary, includedUe4ss: boolean, connect: string | null): string {
  return [
    'Palworld — Client Mods Loadout',
    '================================',
    `Generated: ${s.generatedAt}`,
    ...(connect
      ? [
          '',
          'HOW TO JOIN',
          `  After installing, open Palworld → Join Multiplayer (Dedicated Server) → Connect,`,
          `  and enter this address:`,
          `      ${connect}`,
        ]
      : []),
    `Mods: ${s.mods.length} (${s.luaMods.length} UE4SS/Lua, ${s.pakFiles.length} pak, ${s.logicMods.length} LogicMods)`,
    s.parityPaks ? `Includes ${s.parityPaks} server-parity pak(s) so your content matches the server.` : '',
    s.palSchemaMods ? `Includes PalSchema + ${s.palSchemaMods} client PalSchema mod(s) (custom items/recipes/icons).` : '',
    s.preConfigFiles ? `Includes ${s.preConfigFiles} pre-set mod config file(s) — mods come pre-configured.` : '',
    s.engineTweaks.length
      ? `Engine.ini tweaks from ${s.engineTweaks.length} mod(s) are in recommended-engine-ini.txt (optional, apply manually).`
      : '',
    '',
    'WHAT THIS IS',
    '  The client-side mods for this server, laid out the way Palworld expects.',
    includedUe4ss
      ? '  UE4SS (the mod loader) is INCLUDED — this bundle is self-contained.'
      : '  NOTE: UE4SS is NOT included — install Classic UE4SS first (https://github.com/UE4SS-RE/RE-UE4SS/releases).',
    '',
    'INSTALL (easy)',
    '  1. Close Palworld completely.',
    '  2. Make sure your Palworld is the SAME version as the server (update via Steam).',
    '  3. From the zip ROOT, DOUBLE-CLICK  "Palworld Mod Manager.bat"  and choose  [1] Install / Update.',
    '     (This file — INSTALL.txt — is only the manual fallback.)',
    '',
    'INSTALL (manual — always works)',
    '  1. Close Palworld.',
    '  2. Open your Palworld install folder, e.g.:',
    '       ...\\Steam\\steamapps\\common\\Palworld\\',
    '  3. Copy EVERYTHING inside this bundle\'s  game\\  folder into that Palworld folder,',
    '     merging/overwriting when asked (you\'ll be merging a  Pal  folder into the one',
    '     already there — that\'s expected).',
    '  4. Launch Palworld. UE4SS loads the mods ~1-2 minutes into the world.',
    '',
    'UNINSTALL',
    '  Keep this extracted folder. Open "Palworld Mod Manager.bat" and choose [4] Uninstall —',
    '  it removes the mods this bundle installed (their folders, including any config/cache they',
    '  wrote after launch) and nothing else — your other mods are left alone.',
    '  (This also removes UE4SS; if you run other UE4SS mods, reinstall your loader afterward.)',
    '',
    'MODS IN THIS LOADOUT',
    ...s.mods.map((m) => `  - ${m.name}  [${m.kind}]  -> ${m.placed.join(', ') || 'nothing placed'}`),
    ...(s.skipped.length
      ? ['', 'SKIPPED (add manually if you need them)', ...s.skipped.map((k) => `  - ${k.name}: ${k.reason}`)]
      : []),
    '',
  ].join('\n')
}

// A best-effort PowerShell installer. Locates Palworld via the Steam registry +
// libraryfolders.vdf, falls back to prompting, then copies the game/ overlay in.
function installPs1(): string {
  // String.raw so backslashes stay literal — the old regex-escaping was the fragile part.
  // Everything is wrapped in try/catch so an error PRINTS (red) instead of slamming the
  // window shut; the copy uses robocopy (reliable merge). Meant to be launched by
  // install.bat (bypasses execution policy + keeps the window open).
  const s = String.raw`# Palworld client-mods installer. Easiest: double-click install.bat instead.
try {
  $ErrorActionPreference = "Stop"
  Write-Host "Palworld client-mods installer" -ForegroundColor Cyan
  $bundleGame = Join-Path $PSScriptRoot "game"
  if (-not (Test-Path $bundleGame)) { throw "Run this next to the game\ folder (extract the WHOLE zip first)." }
  function Find-Palworld {
    $cands = @()
    try {
      $steam = (Get-ItemProperty "HKCU:\Software\Valve\Steam" -EA SilentlyContinue).SteamPath
      if ($steam) {
        $cands += (Join-Path $steam "steamapps\common\Palworld")
        $vdf = Join-Path $steam "steamapps\libraryfolders.vdf"
        if (Test-Path $vdf) {
          foreach ($line in Get-Content $vdf) {
            if ($line -match '"path"\s+"(.+?)"') { $cands += (Join-Path ($Matches[1] -replace '\\\\','\') "steamapps\common\Palworld") }
          }
        }
      }
    } catch {}
    $cands += "C:\Program Files (x86)\Steam\steamapps\common\Palworld"
    foreach ($c in $cands) { if (Test-Path (Join-Path $c "Pal\Binaries\Win64")) { return $c } }
    return $null
  }
  $pal = Find-Palworld
  if (-not $pal) { $pal = Read-Host "Could not auto-find Palworld. Paste your Palworld folder (the one containing Pal\Binaries)" }
  if (-not (Test-Path (Join-Path $pal "Pal\Binaries\Win64"))) { throw "That folder is not a Palworld install (no Pal\Binaries\Win64)." }
  Write-Host "Installing into: $pal" -ForegroundColor Cyan
  robocopy "$bundleGame" "$pal" /E /IS /IT /NFL /NDL /NJH /NJS /NC /NS | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "Copy failed (robocopy code $LASTEXITCODE) - see INSTALL.txt to copy manually." }
  Write-Host "Done! Launch Palworld - mods load ~1-2 min into the world." -ForegroundColor Green
} catch {
  Write-Host ""
  Write-Host ("ERROR: " + $_.Exception.Message) -ForegroundColor Red
  Write-Host "You can install manually instead - see INSTALL.txt (copy the game\ folder's CONTENTS into your Palworld folder)." -ForegroundColor Yellow
}
`
  return s.replace(/\r?\n/g, '\r\n')
}

// Double-click launcher: bypasses PowerShell execution policy + the downloaded-file block
// (Mark-of-the-Web), and pauses so any message stays readable — the two reasons a bare
// .ps1 "flashes red and closes".
function installBat(): string {
  const s = String.raw`@echo off
REM Double-click me to install. This bypasses PowerShell's script block and keeps the window open.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
echo.
pause
`
  return s.replace(/\r?\n/g, '\r\n')
}

// Uninstaller: removes EXACTLY the files this bundle installed (from installed-files.txt),
// then prunes any mod dirs it emptied — so it reverses the install without touching the
// friend's other files or save data. Same robust shape as install.ps1.
function uninstallPs1(): string {
  const s = String.raw`# Palworld client-mods UNINSTALLER. Easiest: double-click uninstall.bat.
try {
  $ErrorActionPreference = "Stop"
  Write-Host "Palworld client-mods uninstaller" -ForegroundColor Cyan
  $listFile = Join-Path $PSScriptRoot "installed-files.txt"
  if (-not (Test-Path $listFile)) { throw "installed-files.txt not found next to this script (keep the extracted folder)." }
  function Find-Palworld {
    $cands = @()
    try {
      $steam = (Get-ItemProperty "HKCU:\Software\Valve\Steam" -EA SilentlyContinue).SteamPath
      if ($steam) {
        $cands += (Join-Path $steam "steamapps\common\Palworld")
        $vdf = Join-Path $steam "steamapps\libraryfolders.vdf"
        if (Test-Path $vdf) {
          foreach ($line in Get-Content $vdf) {
            if ($line -match '"path"\s+"(.+?)"') { $cands += (Join-Path ($Matches[1] -replace '\\\\','\') "steamapps\common\Palworld") }
          }
        }
      }
    } catch {}
    $cands += "C:\Program Files (x86)\Steam\steamapps\common\Palworld"
    foreach ($c in $cands) { if (Test-Path (Join-Path $c "Pal\Binaries\Win64")) { return $c } }
    return $null
  }
  $pal = Find-Palworld
  if (-not $pal) { $pal = Read-Host "Could not auto-find Palworld. Paste your Palworld folder (with Pal\Binaries)" }
  if (-not (Test-Path (Join-Path $pal "Pal\Binaries\Win64"))) { throw "That folder is not a Palworld install (no Pal\Binaries\Win64)." }
  Write-Host "Close Palworld first, then this removes the bundle's files from: $pal" -ForegroundColor Cyan
  $ans = Read-Host "Remove now? (y/n)"
  if ($ans -ne "y") { Write-Host "Cancelled."; return }
  $removed = 0
  foreach ($line in Get-Content $listFile) {
    $rel = $line.Trim(); if (-not $rel) { continue }
    $p = Join-Path $pal ($rel -replace '/','\')
    if (Test-Path $p -PathType Leaf) { Remove-Item -LiteralPath $p -Force; $removed++ }
  }
  # Remove the mod FOLDERS this bundle created wholesale — even if a mod wrote runtime files
  # (caches, configs, generated JSON) into them after launch, which aren't in the manifest and
  # would otherwise leave the folder behind. Covers UE4SS Lua/C++ mods under ue4ss\Mods
  # (incl. PalSchema and its mods\ submods) AND folder-based LogicMods. Only names listed in
  # installed-files.txt are touched, so the player's OTHER mods are never removed.
  $roots = @{}
  foreach ($line in Get-Content $listFile) {
    $rel = $line.Trim() -replace '/','\'
    if ($rel -match '^(Pal\\Binaries\\Win64\\ue4ss\\Mods|Pal\\Content\\Paks\\LogicMods)\\([^\\]+)\\') {
      $roots[(Join-Path $Matches[1] $Matches[2])] = $true
    }
  }
  foreach ($r in $roots.Keys) {
    $p = Join-Path $pal $r
    if (Test-Path $p -PathType Container) { Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue }
  }
  foreach ($d in @("Pal\Binaries\Win64\ue4ss","Pal\Content\Paks\~mods","Pal\Content\Paks\LogicMods")) {
    $dir = Join-Path $pal $d
    if (Test-Path $dir) {
      Get-ChildItem -LiteralPath $dir -Recurse -Directory | Sort-Object FullName -Descending | ForEach-Object {
        if (-not (Get-ChildItem -LiteralPath $_.FullName -Force)) { Remove-Item -LiteralPath $_.FullName -Force }
      }
      if (-not (Get-ChildItem -LiteralPath $dir -Force)) { Remove-Item -LiteralPath $dir -Force }
    }
  }
  Write-Host "Removed $removed file(s). The mods are uninstalled." -ForegroundColor Green
  Write-Host "Note: this also removed UE4SS (dwmapi.dll + ue4ss) - if you run OTHER UE4SS mods, reinstall your loader." -ForegroundColor Yellow
} catch {
  Write-Host ""
  Write-Host ("ERROR: " + $_.Exception.Message) -ForegroundColor Red
  Write-Host "You can remove manually - delete the files listed in installed-files.txt from your Palworld folder." -ForegroundColor Yellow
}
`
  return s.replace(/\r?\n/g, '\r\n')
}

function uninstallBat(): string {
  const s = String.raw`@echo off
REM Double-click me to REMOVE the mods this bundle installed. Keeps the window open.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1"
echo.
pause
`
  return s.replace(/\r?\n/g, '\r\n')
}

// ── Mod Manager (single clickable launcher) ──────────────────────────────────────────────
// Replaces the loose install/uninstall .bat/.ps1 with ONE console-menu app. All the real
// scripts live in _manager\ so the zip root is just the launcher + READ-ME + game\.
// docs/specs/client-mod-sync.md §9.

// Which shipped mods are performance-heavy → what Performance Mode disables. DERIVED by
// scanning the assembled bundle by folder/pak name (no hardcoded per-mod list, so it's
// correct for any operator's mod set). MAIN/booster mods are untouched.
async function heavyPerfTargets(gameRoot: string): Promise<{ mods: string[]; paks: string[]; reshade: boolean }> {
  // Heavy UE4SS Lua mods by FOLDER name. "Fix" in a name never overrides these (so "Extreme
  // Foliage Draw Distance and Tree Pop-in Fix" is correctly heavy, not a booster).
  const HEAVY_FOLDER = /ultra.?graphic|ultra.?weather|volumetric|foliage|draw.?distance|culling.?disabl|light.?cull/i
  const HEAVY_PAK = /hd.?map|hd.?tex|bloodfx|_blood|blood_|plaster|texture.?swap|4k|high.?res|volumetric.?cloud/i
  const mods: string[] = []
  try {
    for (const e of await readdir(join(gameRoot, 'Pal/Binaries/Win64/ue4ss/Mods'), { withFileTypes: true })) {
      if (e.isDirectory() && HEAVY_FOLDER.test(e.name)) mods.push(e.name)
    }
  } catch {
    /* no ue4ss mods */
  }
  const paks: string[] = []
  for (const sub of ['Pal/Content/Paks/~mods', 'Pal/Content/Paks/LogicMods']) {
    try {
      for (const e of await readdir(join(gameRoot, sub), { withFileTypes: true })) {
        if (e.isFile() && /\.pak$/i.test(e.name) && HEAVY_PAK.test(e.name)) paks.push(`${sub}/${e.name}`)
      }
    } catch {
      /* dir absent */
    }
  }
  const reshade = await exists(join(gameRoot, 'Pal/Binaries/Win64/dxgi.dll'))
  return { mods, paks, reshade }
}

function perfTargetsTxt(t: { mods: string[]; paks: string[]; reshade: boolean }): string {
  const lines = [
    '# Auto-generated — the performance-heavy items Performance Mode toggles. Do not edit.',
    ...t.mods.map((m) => `MODTXT ${m}`),
    ...t.paks.map((p) => `PAK ${p}`),
    ...(t.reshade ? ['RESHADE'] : []),
  ]
  return lines.join('\r\n') + '\r\n'
}

function keybindsTxt(): string {
  const s = [
    'PALWORLD — CONTROLS (this server\u2019s mods)',
    '=========================================',
    '',
    '  E .................. throw a sphere / summon your active Pal',
    '  F .................. partner skill (Full Sphere Summon)',
    '  F2 ................. quick-stack loot + eggs into nearby chests',
    '  F5 ................. reveal a Pal\u2019s hidden potential / IVs (look at it)',
    '  F6 ................. guild overlay: members + territory (GuildSight)',
    '  F7 ................. toggle accessories on/off',
    '  F8 / F9 / F10 ...... Smart Condenser: pick best passives / open / clear',
    '  Left-Alt (hold) .... inspect a Pal (Pal Insight)',
    '  B .................. free-camera build mode',
    '  G .................. Blueprint mode (save & stamp builds)',
    '  Numpad 1-9 ......... swap saved Palbox party presets',
    '  Numpad + / - ....... widen / narrow FOV + camera distance',
    '',
    'Ctrl combos (safe to type the plain letter):',
    '  Ctrl+Y ............. confirm Evolve in a Pal\u2019s radial menu (Palvolve)',
    '  Ctrl+O ............. Pal Insight settings',
    '  Ctrl+C ............. copy a base layout (Base Automation)',
    '  Ctrl+F9 ............ hide/show what you already own (OwnedIndicator)',
    '  Ctrl+F7 ............ OwnedIndicator re-check',
    '',
  ]
  return s.join('\r\n') + '\r\n'
}

function readMeFirst(connect: string | null, serverName: string | null): string {
  const s = [
    'PALWORLD — MODS (READ ME FIRST)',
    '===============================',
    '',
    serverName ? `Server:  ${serverName}` : '',
    connect ? `Join at: ${connect}` : '',
    '',
    'You only need ONE thing here:',
    '',
    '    ▶  Double-click  "Palworld Mod Manager.bat"',
    '',
    'It opens a small menu with everything:',
    '  [1] Install / Update mods   — run this any time the host says mods changed',
    '  [2] Performance Mode        — laptop or crashing? turns off the heavy visual mods',
    '  [3] Restore Full Graphics   — puts them back',
    '  [4] Uninstall everything',
    '  [5] Show controls / keybinds',
    '',
    'Notes:',
    '  • Close Palworld before Install / Performance / Uninstall.',
    '  • Install / Update is smart — it adds, updates AND removes to match the host,',
    '    so you always just click [1]; you never need to know what changed.',
    '  • Everything else (the actual scripts) is tucked in the _manager folder —',
    '    you can ignore it.',
    '',
  ]
  return s.filter((l) => l !== '').join('\r\n') + '\r\n'
}

function managerBat(): string {
  const s = String.raw`@echo off
title Palworld Mod Manager
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0_manager\manager.ps1"
`
  return s.replace(/\r?\n/g, '\r\n')
}

function managerPs1(connect: string | null, serverName: string | null): string {
  const s = String.raw`# Palworld Mod Manager. Launch via "Palworld Mod Manager.bat" (double-click).
$ErrorActionPreference = "Stop"
$Root       = Split-Path -Parent $PSScriptRoot
$BundleGame = Join-Path $Root "game"
$ListFile   = Join-Path $Root "installed-files.txt"
$Targets    = Join-Path $PSScriptRoot "performance-targets.txt"
$Keybinds   = Join-Path $PSScriptRoot "keybinds.txt"
$Connect    = "__CONNECT__"
$ServerName = "__SERVER__"
$Stash      = ".palworld-loadout-manifest.txt"

function Find-Palworld {
  $cands = @()
  try {
    $steam = (Get-ItemProperty "HKCU:\Software\Valve\Steam" -EA SilentlyContinue).SteamPath
    if ($steam) {
      $cands += (Join-Path $steam "steamapps\common\Palworld")
      $vdf = Join-Path $steam "steamapps\libraryfolders.vdf"
      if (Test-Path $vdf) {
        foreach ($line in Get-Content $vdf) {
          if ($line -match '"path"\s+"(.+?)"') { $cands += (Join-Path ($Matches[1] -replace '\\\\','\') "steamapps\common\Palworld") }
        }
      }
    }
  } catch {}
  $cands += "C:\Program Files (x86)\Steam\steamapps\common\Palworld"
  foreach ($c in $cands) { if (Test-Path (Join-Path $c "Pal\Binaries\Win64")) { return $c } }
  return $null
}
function Get-Pal {
  $pal = Find-Palworld
  if (-not $pal) { $pal = Read-Host "Could not auto-find Palworld. Paste your Palworld folder (the one with Pal\Binaries)" }
  if (-not (Test-Path (Join-Path $pal "Pal\Binaries\Win64"))) { throw "That folder is not a Palworld install (no Pal\Binaries\Win64)." }
  return $pal
}
function Prune-Empty($pal) {
  foreach ($d in @("Pal\Binaries\Win64\ue4ss","Pal\Content\Paks\~mods","Pal\Content\Paks\LogicMods")) {
    $dir = Join-Path $pal $d
    if (Test-Path $dir) {
      Get-ChildItem -LiteralPath $dir -Recurse -Directory -EA SilentlyContinue | Sort-Object FullName -Descending | ForEach-Object {
        if (-not (Get-ChildItem -LiteralPath $_.FullName -Force -EA SilentlyContinue)) { Remove-Item -LiteralPath $_.FullName -Force -EA SilentlyContinue }
      }
    }
  }
}
function Do-Install {
  if (-not (Test-Path $BundleGame)) { throw "The game\ folder is missing - extract the WHOLE zip first." }
  $pal = Get-Pal
  Write-Host "Syncing mods into: $pal" -ForegroundColor Cyan
  $new = @(Get-Content $ListFile -EA SilentlyContinue | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  $stashPath = Join-Path $pal $Stash
  $old = @()
  if (Test-Path $stashPath) { $old = @(Get-Content $stashPath -EA SilentlyContinue | ForEach-Object { $_.Trim() } | Where-Object { $_ }) }
  $newSet = @{}; foreach ($n in $new) { $newSet[$n] = $true }
  $removed = 0
  foreach ($rel in $old) {
    if (-not $newSet.ContainsKey($rel)) {
      $p = Join-Path $pal ($rel -replace '/','\')
      if (Test-Path $p -PathType Leaf) { Remove-Item -LiteralPath $p -Force -EA SilentlyContinue; $removed++ }
    }
  }
  robocopy "$BundleGame" "$pal" /E /IS /IT /NFL /NDL /NJH /NJS /NC /NS | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "Copy failed (robocopy code $LASTEXITCODE)." }
  Prune-Empty $pal
  Set-Content -LiteralPath $stashPath -Value $new -Encoding ASCII
  $msg = "Done. " + $new.Count + " files in sync"
  if ($removed -gt 0) { $msg += " (" + $removed + " no-longer-included removed)" }
  Write-Host $msg -ForegroundColor Green
  Write-Host "Launch Palworld - mods load ~1-2 min into the world." -ForegroundColor Green
}
function Do-Uninstall {
  $pal = Get-Pal
  if ((Read-Host "Remove ALL mods this bundle installed from $pal ? (y/n)") -ne "y") { Write-Host "Cancelled."; return }
  $list = @(Get-Content $ListFile -EA SilentlyContinue | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  $removed = 0
  foreach ($rel in $list) { $p = Join-Path $pal ($rel -replace '/','\'); if (Test-Path $p -PathType Leaf) { Remove-Item -LiteralPath $p -Force -EA SilentlyContinue; $removed++ } }
  $roots = @{}
  foreach ($rel in $list) {
    $r = $rel -replace '/','\'
    if ($r -match '^(Pal\\Binaries\\Win64\\ue4ss\\Mods|Pal\\Content\\Paks\\LogicMods)\\([^\\]+)\\') { $roots[(Join-Path $Matches[1] $Matches[2])] = $true }
  }
  foreach ($r in $roots.Keys) { $p = Join-Path $pal $r; if (Test-Path $p -PathType Container) { Remove-Item -LiteralPath $p -Recurse -Force -EA SilentlyContinue } }
  Prune-Empty $pal
  $stashPath = Join-Path $pal $Stash; if (Test-Path $stashPath) { Remove-Item -LiteralPath $stashPath -Force -EA SilentlyContinue }
  Write-Host "Removed $removed file(s). The mods are uninstalled." -ForegroundColor Green
  Write-Host "(This also removed UE4SS. If you run OTHER UE4SS mods, reinstall your loader.)" -ForegroundColor Yellow
}
function Set-Perf($enable) {
  if (-not (Test-Path $Targets)) { Write-Host "No performance targets shipped." -ForegroundColor Yellow; return }
  $items = @(Get-Content $Targets | Where-Object { $_ -and -not $_.StartsWith('#') })
  if (-not $items) { Write-Host "This bundle has no performance-heavy mods to toggle." -ForegroundColor Yellow; return }
  $pal = Get-Pal
  $modsTxt = Join-Path $pal "Pal\Binaries\Win64\ue4ss\Mods\mods.txt"
  $n = 0
  foreach ($it in $items) {
    $sp = $it -split ' ', 2
    $kind = $sp[0]; $arg = if ($sp.Count -gt 1) { $sp[1].Trim() } else { "" }
    if ($kind -eq 'MODTXT' -and (Test-Path $modsTxt)) {
      $val = if ($enable) { '0' } else { '1' }
      $out = foreach ($ln in (Get-Content $modsTxt)) {
        if ($ln -match ('^\s*' + [regex]::Escape($arg) + '\s*:\s*[01]\s*$')) { $n++; ('{0} : {1}' -f $arg, $val) } else { $ln }
      }
      Set-Content -LiteralPath $modsTxt -Value $out
    } elseif ($kind -eq 'PAK') {
      $p = Join-Path $pal ($arg -replace '/','\'); $off = "$p.off"
      if ($enable) { if (Test-Path $p) { Move-Item -LiteralPath $p -Destination $off -Force; $n++ } }
      else        { if (Test-Path $off) { Move-Item -LiteralPath $off -Destination $p -Force; $n++ } }
    } elseif ($kind -eq 'RESHADE') {
      $dll = Join-Path $pal "Pal\Binaries\Win64\dxgi.dll"; $off = "$dll.off"
      if ($enable) { if (Test-Path $dll) { Move-Item -LiteralPath $dll -Destination $off -Force; $n++ } }
      else        { if (Test-Path $off) { Move-Item -LiteralPath $off -Destination $dll -Force; $n++ } }
    }
  }
  if ($enable) { Write-Host "Performance Mode ON - disabled $n heavy item(s). Restart Palworld to apply." -ForegroundColor Green }
  else         { Write-Host "Full Graphics restored - re-enabled $n item(s). Restart Palworld to apply." -ForegroundColor Green }
}
function Show-Menu {
  Clear-Host
  Write-Host ""
  Write-Host "  ==================================================" -ForegroundColor DarkCyan
  Write-Host "            PALWORLD  -  MOD MANAGER" -ForegroundColor Cyan
  if ($ServerName) { Write-Host ("            Server: " + $ServerName) -ForegroundColor Gray }
  if ($Connect)    { Write-Host ("            Join:   " + $Connect) -ForegroundColor Gray }
  Write-Host "  ==================================================" -ForegroundColor DarkCyan
  Write-Host ""
  Write-Host "     [1]  Install / Update mods"
  Write-Host "     [2]  Performance Mode   (laptop / crashing)" -ForegroundColor DarkYellow
  Write-Host "     [3]  Restore Full Graphics"
  Write-Host "     [4]  Uninstall everything"
  Write-Host "     [5]  Show controls / keybinds"
  Write-Host "     [0]  Exit"
  Write-Host ""
}
$running = $true
while ($running) {
  Show-Menu
  $c = Read-Host "  Choose"
  Write-Host ""
  try {
    switch ($c) {
      '1' { Do-Install }
      '2' { Set-Perf $true }
      '3' { Set-Perf $false }
      '4' { Do-Uninstall }
      '5' { if (Test-Path $Keybinds) { Get-Content $Keybinds | ForEach-Object { Write-Host $_ } } else { Write-Host "No keybinds file shipped." -ForegroundColor Yellow } }
      '0' { $running = $false }
      default { Write-Host "Pick a number 0-5." -ForegroundColor Yellow }
    }
  } catch {
    Write-Host ("ERROR: " + $_.Exception.Message) -ForegroundColor Red
    Write-Host "See _manager\INSTALL.txt to do it manually." -ForegroundColor Yellow
  }
  if ($running) { Write-Host ""; Read-Host "  Press Enter to return to the menu" | Out-Null }
}
`
  // Strip chars that would break a PowerShell double-quoted string ("$` and newlines) — the
  // server name is game-settings text, so it's untrusted.
  const psSafe = (v: string | null) => (v ?? '').replace(/["$`\r\n]/g, '').trim()
  return s
    .replace(/__CONNECT__/g, psSafe(connect))
    .replace(/__SERVER__/g, psSafe(serverName))
    .replace(/\r?\n/g, '\r\n')
}

// Best-effort server name via the game REST (same source as the manifest). Null if the
// server is down — the manager just omits the "Server:" line then.
async function fetchServerName(): Promise<string | null> {
  try {
    const { restUrl, adminPassword: pw } = currentRestConfig()
    const res = await fetch(new URL('/v1/api/info', new URL(restUrl)), {
      headers: { Accept: 'application/json', Authorization: `Basic ${Buffer.from(`admin:${pw}`).toString('base64')}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return null
    const j = (await res.json()) as { servername?: string }
    return j.servername?.trim() || null
  } catch {
    return null
  }
}

// Build the bundle. `includeUe4ss` (default true) ships the loader for a self-contained
// bundle; set false to ship mods only (friend supplies UE4SS).
export async function buildClientLoadout(opts?: { includeUe4ss?: boolean }): Promise<LoadoutResult> {
  const includeUe4ss = opts?.includeUe4ss !== false
  const kept = (await listClientMods()).filter((m) => m.keep)

  const work = await mkdtemp(join(tmpdir(), 'client-loadout-'))
  const cleanup = async () => {
    await rm(work, { recursive: true, force: true }).catch(() => {})
  }
  try {
    const bundle = join(work, 'bundle')
    const win64 = join(bundle, 'game', 'Pal', 'Binaries', 'Win64')
    const modsDir = join(win64, 'ue4ss', 'Mods')
    const palSchemaModsDir = join(modsDir, 'PalSchema', 'mods')
    const pakDir = join(bundle, 'game', 'Pal', 'Content', 'Paks', '~mods')
    const logicDir = join(bundle, 'game', 'Pal', 'Content', 'Paks', 'LogicMods')
    for (const d of [modsDir, pakDir, logicDir]) await mkdir(d, { recursive: true })

    let includedUe4ss = false
    if (includeUe4ss) includedUe4ss = await includeFramework(win64, modsDir)

    // PalSchema: ship only the submods that belong to the curated CLIENT mods (extracted from
    // their payloads / Steam content below) — NOT the host's server-only PalSchema mods. The
    // loader framework is added afterwards, only if a client mod contributed a submod.
    const seenPalSchema = new Set<string>()
    let palSchemaMods = 0
    let preConfigFiles = 0
    let palSchemaEdits = 0
    const engineIniTweaks: { name: string; text: string }[] = []

    const luaMods: string[] = []
    const pakFiles: string[] = []
    const logicMods: string[] = []
    const seenPaks = new Set<string>()
    const mods: LoadoutMod[] = []
    const skipped: LoadoutSkip[] = []
    // client-mod id → the ue4ss/Mods folder name(s) it produced, so admin config overrides
    // can be overlaid onto the right folder after assembly.
    const producedFolders = new Map<string, string[]>()

    // Unique mod-folder names — a safeName() collision (e.g. two non-ASCII names both
    // reducing to the same slug) must not let one mod overwrite another. Seed with the
    // framework folder names so a client mod can't clobber a framework component.
    const usedMods = new Set<string>()
    if (includedUe4ss) for (const n of ['shared', ...UE4SS_FRAMEWORK_DEFAULTS.keys()]) usedMods.add(n.toLowerCase())
    const uniqueMod = (base: string): string => {
      let n = base
      for (let i = 2; usedMods.has(n.toLowerCase()); i++) n = `${base}-${i}`
      usedMods.add(n.toLowerCase())
      return n
    }

    for (const m of kept) {
      const store = clientModStorePath(m.id)
      const scratch = join(work, 'scratch', m.id)
      const placed: string[] = []
      const producedForMod: string[] = []
      try {
        if (m.source === 'steam' || (m.kind === 'unknown' && (await exists(join(store, 'content'))))) {
          // Steam Workshop item — place by its Info.json InstallRule.
          const where = await placeWorkshop(join(store, 'content'), m.name, { modsDir, pakDir, logicDir }, luaMods, seenPaks, uniqueMod, producedForMod)
          placed.push(...where)
          // …and its PalSchema data, if any (a ./PalSchema wrapper — e.g. Palvolve, Glider Restoration).
          const psSteam = await collectSteamPalSchema(join(store, 'content'), m.name, palSchemaModsDir, seenPalSchema)
          if (psSteam) {
            placed.push('PalSchema/mods (1)')
            palSchemaMods += 1
          }
          if (!where.length && !psSteam)
            skipped.push({ name: m.name, reason: 'server-side (UE4SS) or no client files — nothing to install on a client' })
        } else if (m.payload === 'payload.pak') {
          // Bare uploaded pak — name from the mod (original filename wasn't retained).
          const name = `${safeName(m.name)}.pak`
          await cp(join(store, 'payload.pak'), join(pakDir, name))
          if (!seenPaks.has(name.toLowerCase())) {
            seenPaks.add(name.toLowerCase())
            pakFiles.push(name)
          }
          placed.push('~mods')
        } else if (m.kind === 'ue4ss') {
          await unpack(join(store, 'payload.zip'), scratch)
          const roots = await findLuaModRoots(scratch, m.name)
          for (const r of roots) {
            const name = uniqueMod(r.name)
            await cp(r.dir, join(modsDir, name), { recursive: true })
            luaMods.push(name)
            producedForMod.push(name)
            placed.push(`ue4ss/Mods/${name}`)
          }
          // hybrid: any paks shipped alongside → ~mods / LogicMods (by path)
          const { paks, logic, dupes } = await collectPaksRouted([scratch], pakDir, logicDir, seenPaks)
          if (paks.length) placed.push(`~mods (${paks.length})`)
          if (logic.length) placed.push(`LogicMods (${logic.length})`)
          if (dupes && !paks.length && !logic.length) placed.push('already in loadout (duplicate)')
          // combined Lua+PalSchema mod: ship its PalSchema companion too
          const ps = await collectPalSchemaSubmods(scratch, palSchemaModsDir, seenPalSchema)
          if (ps.placed.length) {
            placed.push(`PalSchema/mods (${ps.placed.length})`)
            palSchemaMods += ps.placed.length
          } else if (ps.covered.length) placed.push('PalSchema data (already in loadout)')
          if (!roots.length && !paks.length && !logic.length && !dupes && !ps.placed.length && !ps.covered.length)
            skipped.push({ name: m.name, reason: 'no Lua mod folder or pak found' })
        } else if (m.kind === 'pak' || m.kind === 'palschema') {
          await unpack(join(store, 'payload.zip'), scratch)
          const { paks, logic, dupes } = await collectPaksRouted([scratch], pakDir, logicDir, seenPaks)
          if (paks.length) placed.push(`~mods (${paks.length})`)
          if (logic.length) placed.push(`LogicMods (${logic.length})`)
          if (dupes && !paks.length && !logic.length) placed.push('already in loadout (duplicate)')
          // real PalSchema data (e.g. Food Expansion) — ship it, or note it's covered by parity
          const ps = await collectPalSchemaSubmods(scratch, palSchemaModsDir, seenPalSchema)
          if (ps.placed.length) {
            placed.push(`PalSchema/mods (${ps.placed.length})`)
            palSchemaMods += ps.placed.length
          } else if (ps.covered.length) placed.push('PalSchema data (already in loadout)')
          if (!paks.length && !logic.length && !dupes && !ps.placed.length && !ps.covered.length) {
            skipped.push({
              name: m.name,
              reason:
                m.kind === 'palschema'
                  ? 'PalSchema data not found in payload — add manually'
                  : 'no pak found in archive',
            })
          }
        } else {
          // unknown from a zip payload — best effort: mod folder → Mods, paks → ~mods/LogicMods.
          await unpack(join(store, 'payload.zip'), scratch)
          const roots = await findLuaModRoots(scratch, m.name)
          for (const r of roots) {
            const name = uniqueMod(r.name)
            await cp(r.dir, join(modsDir, name), { recursive: true })
            luaMods.push(name)
            producedForMod.push(name)
            placed.push(`ue4ss/Mods/${name}`)
          }
          const { paks, logic, dupes } = await collectPaksRouted([scratch], pakDir, logicDir, seenPaks)
          if (paks.length) placed.push(`~mods (${paks.length})`)
          if (logic.length) placed.push(`LogicMods (${logic.length})`)
          if (dupes && !paks.length && !logic.length) placed.push('already in loadout (duplicate)')
          const ps = await collectPalSchemaSubmods(scratch, palSchemaModsDir, seenPalSchema)
          if (ps.placed.length) {
            placed.push(`PalSchema/mods (${ps.placed.length})`)
            palSchemaMods += ps.placed.length
          } else if (ps.covered.length) placed.push('PalSchema data (already in loadout)')
          if (!roots.length && !paks.length && !logic.length && !dupes && !ps.placed.length && !ps.covered.length) {
            // Some Nexus "mods" are just Engine.ini text tweaks (no installable files) — fold
            // their settings into recommended-engine-ini.txt instead of dropping them.
            const files = await walkFiles(scratch)
            const engineTweak = files.length > 0 && files.every((f) => /engine\.ini|\.txt$/i.test(f))
            if (engineTweak) {
              const text = (
                await Promise.all(files.filter((f) => /\.txt$/i.test(f)).map((f) => readFile(f, 'utf8')))
              ).join('\n')
              engineIniTweaks.push({ name: m.name, text })
              placed.push('Engine.ini tweak → recommended-engine-ini.txt')
            } else {
              skipped.push({ name: m.name, reason: 'could not classify — add manually' })
            }
          }
        }
      } catch (e) {
        skipped.push({ name: m.name, reason: e instanceof Error ? e.message : 'failed to place' })
      } finally {
        await rm(scratch, { recursive: true, force: true }).catch(() => {})
      }
      if (producedForMod.length) producedFolders.set(m.id, producedForMod)
      if (placed.length) mods.push({ name: m.name, kind: m.kind, source: m.source, placed })
    }

    // Overlay the admin's config edits onto the placed mods so every client ships the
    // host's config. Applied only when a mod produced exactly ONE folder (the common case;
    // ambiguous multi-folder mods are left with their shipped config).
    let configOverrides = 0
    for (const m of kept) {
      const overrides = await readClientModConfigOverrides(m.id).catch(() => [])
      if (!overrides.length) continue
      const folders = producedFolders.get(m.id)
      for (const ov of overrides) {
        // A Mod Config Menu file (…​.modconfig.json) belongs in the client's LogicMods dir
        // (basename only), NOT nested inside the ue4ss/Mods folder — route it there so the
        // edit actually applies on the client. An in-folder config (e.g. a Lua mod's
        // config.lua) goes under the produced mod folder (only when it produced exactly one).
        let dest: string | null = null
        if (/\.modconfig\.json$/i.test(ov.relWithin)) dest = join(logicDir, basename(ov.relWithin))
        else if (folders && folders.length === 1) dest = join(modsDir, folders[0], ov.relWithin)
        if (!dest) continue
        await mkdir(dirname(dest), { recursive: true })
        await cp(ov.absPath, dest)
        configOverrides++
      }
    }

    // Extra operator files added to a client mod (music tracks, textures, data packs, …) —
    // overlay them onto the mod's produced folder(s) so they ride the loadout to friends.
    const extraFiles = await overlayClientModFilesInto(modsDir, producedFolders)

    // Server-parity paks: what the SERVER actually runs in ~mods / LogicMods. A joining
    // client needs these to match the server's content, regardless of what was staged as a
    // client mod — so fold them into the bundle (deduped against the staged client paks via
    // seenPaks; `.pak.disabled` auto-skips since it fails PAK_RE). This makes the loadout the
    // single complete download (replaces the Invite tab's per-pak list).
    const liveMods = join(currentGameDir(), 'Pal', 'Content', 'Paks', '~mods')
    const liveLogic = join(currentGameDir(), 'Pal', 'Content', 'Paks', 'LogicMods')
    const parityMain = await collectPaks([liveMods], pakDir, seenPaks)
    const parityLogic = await collectPaks([liveLogic], logicDir, seenPaks)
    const parityPaks = parityMain.length + parityLogic.length

    // Authoritative pak/LogicMods counts — walk the actual output dirs (the per-mod
    // `placed` accounting doesn't tally Workshop InstallRule / parity paks into these arrays).
    pakFiles.length = 0
    for (const f of await walkFiles(pakDir)) if (/\.pak$/i.test(f)) pakFiles.push(basename(f))
    for (const f of await walkFiles(logicDir)) if (/\.pak$/i.test(f)) logicMods.push(basename(f))

    // PalSchema loader framework — shipped only if a client mod contributed a submod, so we
    // never ship an empty/orphan PalSchema (and never the host's server-only submods).
    if (palSchemaMods > 0) {
      await includePalSchemaFramework(modsDir)
      // CLIENT PARITY: apply admin PalSchema data edits onto the placed submods, so the
      // client bundle carries the same tech-tree/recipe/item data as the server (matched by
      // submod name; only submods present in this bundle are touched).
      palSchemaEdits = await overlayPalSchemaInto(palSchemaModsDir)
      preConfigFiles += palSchemaEdits
    }

    // Generate mods.txt: enabled framework defaults + every client Lua mod + PalSchema.
    const active = new Map<string, boolean>()
    if (includedUe4ss) for (const name of UE4SS_FRAMEWORK_DEFAULTS.keys()) active.set(name, ENABLED_FRAMEWORK.has(name))
    for (const name of [...new Set(luaMods)]) active.set(name, true)
    // Enable PalSchema so it loads and applies its own submods.
    if (await isDir(join(modsDir, 'PalSchema'))) active.set('PalSchema', true)
    // Keybinds MUST be the last entry — it registers other mods' keybindings, UE4SS's own
    // default marks it "do not move up", and native C++ mods explicitly require being ABOVE
    // it (anything after Keybinds may not load). Move it to the end regardless of where the
    // framework-default order placed it.
    if (active.has('Keybinds')) {
      const v = active.get('Keybinds') ?? false
      active.delete('Keybinds')
      active.set('Keybinds', v)
    }
    if (active.size) await writeFile(join(modsDir, 'mods.txt'), serializeModsTxt(active), 'utf8')

    // Pre-config overlays: runtime config files an admin captured from a configured client
    // (NOT shipped in the mod download — e.g. YetAnotherMinimap's
    // Pal/Content/Paks/LogicMods/YetAnotherMinimap.modconfig.json). Each kept client mod's
    // data/client-mods/<id>/extra/ tree mirrors game-relative paths and is copied verbatim
    // into game/, so every client installs pre-configured. Path-guarded to stay under game/.
    {
      const gameRoot = join(bundle, 'game')
      for (const m of kept) {
        const extra = join(clientModStorePath(m.id), 'extra')
        if (!(await isDir(extra))) continue
        for (const f of await walkFiles(extra)) {
          const dest = join(gameRoot, relative(extra, f))
          if (dest !== gameRoot && !dest.startsWith(gameRoot + sep)) continue
          await mkdir(dirname(dest), { recursive: true })
          await cp(f, dest)
          preConfigFiles++
        }
      }
      // Managed DekModConfigMenu client configs (edited via the dashboard) → LogicMods.
      preConfigFiles += await overlayClientConfigsInto(logicDir)
    }

    // ReShade (optional, operator-toggled): drop the injector + shaders + presets into Win64,
    // next to the game exe. Client-side visual layer only; no server involvement. UE4SS (dwmapi)
    // and ReShade (dxgi) use different proxies, so they coexist. Files land under game/ so the
    // installed-files walk below tracks them for a clean uninstall.
    const reshade = await overlayReshadeInto(win64).catch(() => ({ files: 0, presets: [] as string[] }))

    const generatedAt = new Date().toISOString()
    const summary: LoadoutSummary = {
      includedUe4ss,
      luaMods: [...new Set(luaMods)],
      pakFiles,
      logicMods,
      mods,
      skipped,
      totalKept: kept.length,
      configOverrides,
      extraFiles,
      parityPaks,
      palSchemaMods,
      preConfigFiles,
      palSchemaEdits,
      engineTweaks: engineIniTweaks.map((t) => t.name),
      reshade,
      sizeBytes: 0,
      generatedAt,
    }
    // Record every file the bundle installs (relative to game/) so uninstall.ps1 can
    // reverse EXACTLY this install without touching the friend's other files.
    const gameRoot = join(bundle, 'game')
    const installedFiles = (await walkFiles(gameRoot))
      .map((f) => relative(gameRoot, f).replace(/\\/g, '/'))
      .sort()
    await writeFile(join(bundle, 'installed-files.txt'), installedFiles.join('\n') + '\n', 'utf8')

    // ONE clickable launcher at the root; every real script tucked into _manager\ so the zip
    // root is just the launcher + READ-ME + game\. installed-files.txt STAYS at root (the FSA
    // per-file serving reads it there). See docs/specs/client-mod-sync.md §9.
    const connect = await resolveConnectString()
    const serverName = await fetchServerName()
    const mgr = join(bundle, '_manager')
    await mkdir(mgr, { recursive: true })
    await writeFile(join(mgr, 'manifest.json'), JSON.stringify(summary, null, 2), 'utf8')
    await writeFile(join(mgr, 'INSTALL.txt'), installTxt(summary, includedUe4ss, connect), 'utf8')
    if (engineIniTweaks.length)
      await writeFile(join(mgr, 'recommended-engine-ini.txt'), recommendedEngineIni(engineIniTweaks), 'utf8')
    await writeFile(join(mgr, 'performance-targets.txt'), perfTargetsTxt(await heavyPerfTargets(gameRoot)), 'utf8')
    await writeFile(join(mgr, 'keybinds.txt'), keybindsTxt(), 'utf8')
    await writeFile(join(mgr, 'manager.ps1'), managerPs1(connect, serverName), 'utf8')
    await writeFile(join(bundle, 'Palworld Mod Manager.bat'), managerBat(), 'utf8')
    await writeFile(join(bundle, 'READ-ME-FIRST.txt'), readMeFirst(connect, serverName), 'utf8')

    // Zip the bundle contents (game/, INSTALL.txt, install.ps1, manifest.json) at the
    // zip root. Streaming CLI zip — the ~1GB tree never sits in a Node buffer.
    const fileName = `palworld-client-loadout-${generatedAt.replace(/[:.]/g, '-')}.zip`
    const zipPath = join(work, fileName)
    await execFileP('zip', ['-r', '-q', '-X', zipPath, '.'], { cwd: bundle, maxBuffer: 8 * 1024 * 1024, timeout: 600_000 })
    summary.sizeBytes = (await stat(zipPath)).size

    return { zipPath, bundleDir: bundle, fileName, summary, cleanup }
  } catch (e) {
    await cleanup()
    throw e
  }
}
