import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { currentGameDir } from '@/lib/instances'
import { serializeModsTxt } from '@/lib/game-mods'
import { UE4SS_FRAMEWORK_DEFAULTS } from '@/lib/ue4ss-framework-defaults'
import { clientModStorePath, listClientMods, type ClientMod } from '@/lib/client-mods'
import { readClientModConfigOverrides } from '@/lib/client-mod-config'

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
  sizeBytes: number
  generatedAt: string
}
export type LoadoutResult = {
  zipPath: string
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
  await execFileP('unar', ['-D', '-f', '-o', destDir, archivePath], { maxBuffer: 8 * 1024 * 1024 })
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
    info = JSON.parse(await readFile(join(contentDir, 'Info.json'), 'utf8'))
  } catch {
    return []
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
        if (await isDir(root)) await cp(root, dest, { recursive: true })
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
  // ue4ss/ core: everything except the Mods tree (handled below) and the log.
  for (const e of await readdir(liveUe4ss, { withFileTypes: true })) {
    if (e.name === 'Mods' || e.name === 'UE4SS.log') continue
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

function installTxt(s: LoadoutSummary, includedUe4ss: boolean): string {
  return [
    'Palworld — Client Mods Loadout',
    '================================',
    `Generated: ${s.generatedAt}`,
    `Mods: ${s.mods.length} (${s.luaMods.length} UE4SS/Lua, ${s.pakFiles.length} pak, ${s.logicMods.length} LogicMods)`,
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
    '  3. Right-click install.ps1 -> "Run with PowerShell" and follow the prompt, OR do it',
    '     manually (below).',
    '',
    'INSTALL (manual)',
    '  1. Close Palworld.',
    '  2. Open your Palworld install folder, e.g.:',
    '       ...\\Steam\\steamapps\\common\\Palworld\\',
    '  3. Copy EVERYTHING inside this bundle\'s  game\\  folder into that Palworld folder,',
    '     merging/overwriting when asked.',
    '  4. Launch Palworld. UE4SS loads the mods ~1-2 minutes into the world.',
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
  return [
    '# Palworld client-mods installer (best-effort).',
    '$ErrorActionPreference = "Stop"',
    'Write-Host "Palworld client-mods installer" -ForegroundColor Cyan',
    '$bundleGame = Join-Path $PSScriptRoot "game"',
    'if (-not (Test-Path $bundleGame)) { Write-Error "This script must sit next to the game\\ folder."; exit 1 }',
    'function Find-Palworld {',
    '  try {',
    '    $steam = (Get-ItemProperty "HKCU:\\Software\\Valve\\Steam" -EA SilentlyContinue).SteamPath',
    '    if ($steam) {',
    '      $libs = @((Join-Path $steam "steamapps"))',
    '      $vdf = Join-Path $steam "steamapps\\libraryfolders.vdf"',
    '      if (Test-Path $vdf) {',
    '        Select-String -Path $vdf -Pattern \'"path"\\s+"(.+?)"\' -AllMatches | ForEach-Object {',
    '          $_.Matches | ForEach-Object { $libs += (Join-Path ($_.Groups[1].Value -replace "\\\\\\\\","\\") "steamapps") }',
    '        }',
    '      }',
    '      foreach ($l in $libs) {',
    '        $p = Join-Path $l "common\\Palworld"',
    '        if (Test-Path (Join-Path $p "Pal\\Binaries\\Win64")) { return $p }',
    '      }',
    '    }',
    '  } catch {}',
    '  return $null',
    '}',
    '$pal = Find-Palworld',
    'if (-not $pal) { $pal = Read-Host "Couldn\'t auto-find Palworld. Paste your Palworld folder path" }',
    'if (-not (Test-Path (Join-Path $pal "Pal\\Binaries\\Win64"))) { Write-Error "That doesn\'t look like a Palworld install."; exit 1 }',
    'Write-Host "Installing into: $pal"',
    '$ans = Read-Host "Copy the mods in now? (y/n)"',
    'if ($ans -ne "y") { Write-Host "Cancelled."; exit 0 }',
    'Copy-Item -Path (Join-Path $bundleGame "*") -Destination $pal -Recurse -Force',
    'Write-Host "Done. Launch Palworld — mods load ~1-2 min into the world." -ForegroundColor Green',
    '',
  ].join('\r\n')
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
    const pakDir = join(bundle, 'game', 'Pal', 'Content', 'Paks', '~mods')
    const logicDir = join(bundle, 'game', 'Pal', 'Content', 'Paks', 'LogicMods')
    for (const d of [modsDir, pakDir, logicDir]) await mkdir(d, { recursive: true })

    let includedUe4ss = false
    if (includeUe4ss) includedUe4ss = await includeFramework(win64, modsDir)

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
          if (!roots.length && !paks.length && !logic.length && !dupes) skipped.push({ name: m.name, reason: 'no Lua mod folder or pak found' })
        } else if (m.kind === 'pak' || m.kind === 'palschema') {
          await unpack(join(store, 'payload.zip'), scratch)
          const { paks, logic, dupes } = await collectPaksRouted([scratch], pakDir, logicDir, seenPaks)
          if (paks.length) placed.push(`~mods (${paks.length})`)
          if (logic.length) placed.push(`LogicMods (${logic.length})`)
          if (dupes && !paks.length && !logic.length) placed.push('already in loadout (duplicate)')
          if (!paks.length && !logic.length && !dupes) {
            skipped.push({
              name: m.name,
              reason: m.kind === 'palschema' ? 'PalSchema data is server-side; no client pak' : 'no pak found in archive',
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
          if (!roots.length && !paks.length && !logic.length && !dupes) {
            // Some Nexus "mods" are just Engine.ini text tweaks (no installable files).
            const files = await walkFiles(scratch)
            const engineTweak = files.length > 0 && files.every((f) => /engine\.ini|\.txt$/i.test(f))
            skipped.push({
              name: m.name,
              reason: engineTweak
                ? 'Engine.ini tweak (text only) — not an installable mod; apply to Engine.ini manually'
                : 'could not classify — add manually',
            })
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
      const folders = producedFolders.get(m.id)
      if (!folders || folders.length !== 1) continue
      const overrides = await readClientModConfigOverrides(m.id).catch(() => [])
      for (const ov of overrides) {
        const dest = join(modsDir, folders[0], ov.relWithin)
        await mkdir(dirname(dest), { recursive: true })
        await cp(ov.absPath, dest)
        configOverrides++
      }
    }

    // Authoritative pak/LogicMods counts — walk the actual output dirs (the per-mod
    // `placed` accounting doesn't tally Workshop InstallRule paks into these arrays).
    pakFiles.length = 0
    for (const f of await walkFiles(pakDir)) if (/\.pak$/i.test(f)) pakFiles.push(basename(f))
    for (const f of await walkFiles(logicDir)) if (/\.pak$/i.test(f)) logicMods.push(basename(f))

    // Generate mods.txt: enabled framework defaults + every client Lua mod.
    const active = new Map<string, boolean>()
    if (includedUe4ss) for (const name of UE4SS_FRAMEWORK_DEFAULTS.keys()) active.set(name, ENABLED_FRAMEWORK.has(name))
    for (const name of [...new Set(luaMods)]) active.set(name, true)
    if (active.size) await writeFile(join(modsDir, 'mods.txt'), serializeModsTxt(active), 'utf8')

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
      sizeBytes: 0,
      generatedAt,
    }
    await writeFile(join(bundle, 'manifest.json'), JSON.stringify(summary, null, 2), 'utf8')
    await writeFile(join(bundle, 'INSTALL.txt'), installTxt(summary, includedUe4ss), 'utf8')
    await writeFile(join(bundle, 'install.ps1'), installPs1(), 'utf8')

    // Zip the bundle contents (game/, INSTALL.txt, install.ps1, manifest.json) at the
    // zip root. Streaming CLI zip — the ~1GB tree never sits in a Node buffer.
    const fileName = `palworld-client-loadout-${generatedAt.replace(/[:.]/g, '-')}.zip`
    const zipPath = join(work, fileName)
    await execFileP('zip', ['-r', '-q', '-X', zipPath, '.'], { cwd: bundle, maxBuffer: 8 * 1024 * 1024, timeout: 600_000 })
    summary.sizeBytes = (await stat(zipPath)).size

    return { zipPath, fileName, summary, cleanup }
  } catch (e) {
    await cleanup()
    throw e
  }
}
