import { cp, mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, sep } from 'node:path'
import { writeConfigFileWithBackup } from '@/lib/config-write'
import { currentGameDir, currentInstanceId, DEFAULT_INSTANCE_ID, resolveLifecyclePaths } from '@/lib/instances'
import { nexusKeysForModId, nexusModIdForKey, removeNexusAssoc } from '@/lib/nexus'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import AdmZip from 'adm-zip'

const execFileP = promisify(execFile)

// PATCH (not upstream): shared by every route that touches mod files directly,
// so path construction and mods.txt parsing can't drift between them. See
// app/api/game-mods/route.ts for why this bypasses the Palworld REST API.
// Multi-instance (#7): every path resolves to the active instance (routes wrap
// in runWithInstance); `default` resolves to today's env values. Per-instance
// dashboard state files get an id suffix (default keeps the original filename).
const gameDir = () => currentGameDir()
function dataFile(base: string, envOverride?: string): string {
  if (currentInstanceId() === DEFAULT_INSTANCE_ID) return envOverride ?? `./data/${base}.json`
  return `./data/${base}.${currentInstanceId()}.json`
}
const win64Dir = () => join(gameDir(), 'Pal', 'Binaries', 'Win64')
export const pakModsDir = () => join(gameDir(), 'Pal', 'Content', 'Paks', '~mods')

export async function resolveUe4ssModsDir(): Promise<string | null> {
  // Regime-aware (spec official-workshop-mods.md §4): the Workshop layout keeps
  // UE4SS under Mods/NativeMods/UE4SS; the proxy layout under Win64/ue4ss (modern)
  // or Win64/Mods (flat/stable). In proxy regime the candidate list is exactly the
  // historical one, so behavior is unchanged.
  const regime = await activeRegime()
  const candidates =
    regime === 'workshop'
      ? [join(gameDir(), 'Mods', 'NativeMods', 'UE4SS', 'Mods')]
      : [join(win64Dir(), 'ue4ss', 'Mods'), join(win64Dir(), 'Mods')]
  for (const dir of candidates) {
    try {
      await stat(dir)
      return dir
    } catch {
      // doesn't exist, try next
    }
  }
  return null
}

export function parseModsTxt(content: string): Map<string, boolean> {
  const active = new Map<string, boolean>()
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith(';') || line.startsWith('#')) continue
    const match = line.match(/^([^:]+):\s*(\d+)\s*$/)
    if (match) {
      active.set(match[1].trim(), match[2].trim() !== '0')
    }
  }
  return active
}

export function serializeModsTxt(active: Map<string, boolean>): string {
  return (
    Array.from(active.entries())
      .map(([name, enabled]) => `${name} : ${enabled ? 1 : 0}`)
      .join('\n') + '\n'
  )
}

export async function readModsTxt(modsDir: string): Promise<Map<string, boolean>> {
  try {
    return parseModsTxt(await readFile(join(modsDir, 'mods.txt'), 'utf8'))
  } catch {
    return new Map()
  }
}

// Strict allowlists — used to validate both uploaded filenames and derived mod
// folder names before they ever touch a filesystem path. Anything not matching
// is rejected outright rather than sanitized-and-continued, since silently
// "fixing" an unexpected name is how path-traversal bugs slip through.
export const SAFE_MOD_NAME = /^[A-Za-z0-9_-]+$/
export const SAFE_PAK_FILENAME = /^[A-Za-z0-9_-]+\.pak$/i

// A mod folder name from a mod author's zip may legitimately contain spaces and
// punctuation (e.g. "ZZZ_MelwenMods - Better Lucky Pals"). The real risk is path
// traversal, covered separately by the per-file zip-slip guards — so this only
// blocks separators, control chars, '.'/'..', untrimmed, empty, and over-long.
export function isSafeModFolderName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 120 &&
    name === name.trim() &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !/[\u0000-\u001f]/.test(name)
  )
}

// ── UE4SS loader (spec docs/specs/ue4ss-loader.md) ──────────────────────────
// UE4SS injects via the Win64/dwmapi.dll proxy (WINEDLLOVERRIDES dwmapi=n,b).
// Disable = rename that proxy aside; the loaded version comes from the log banner.
const ue4ssDir = () => join(win64Dir(), 'ue4ss')
const ue4ssLog = () => join(ue4ssDir(), 'UE4SS.log')
const dwmapiDll = () => join(win64Dir(), 'dwmapi.dll')
const DWMAPI_DISABLED = `${dwmapiDll()}.disabled`

// ── Active mod regime (spec docs/specs/official-workshop-mods.md §4) ─────────
// Two injection regimes; only ONE is ever live. 'proxy' = community dwmapi proxy
// (Win64/ue4ss); 'workshop' = official loader (Mods/NativeMods/UE4SS driven by
// PalModSettings). Every mod-path consumer resolves through here so no layout is
// hardcoded. The active regime is a dashboard-owned marker with a disk-detection
// fallback, so status is never blank and pre-existing installs classify correctly.
export type ModRegime = 'proxy' | 'workshop'
export interface RegimePaths {
  regime: ModRegime
  ue4ssRoot: string
  ue4ssModsDir: string
  palSchemaModsDir: string
  pakModsDir: string
  injection: 'dwmapi' | 'official'
  enable: 'mods.txt' | 'palmodsettings'
}
const modRegimeFile = () => dataFile('mod-regime', process.env.MOD_REGIME_FILE)
const nativemodsUe4ssDir = () => join(gameDir(), 'Mods', 'NativeMods', 'UE4SS')

export async function activeRegime(): Promise<ModRegime> {
  try {
    const j = JSON.parse(await readFile(modRegimeFile(), 'utf8')) as { regime?: string }
    if (j.regime === 'workshop' || j.regime === 'proxy') return j.regime
  } catch {
    /* no marker — fall back to disk detection */
  }
  // A dwmapi proxy present (enabled or disabled) => proxy regime.
  for (const p of [dwmapiDll(), DWMAPI_DISABLED]) {
    try {
      await stat(p)
      return 'proxy'
    } catch {
      /* next */
    }
  }
  // No proxy but the official UE4SS tree exists => workshop regime.
  try {
    await stat(nativemodsUe4ssDir())
    return 'workshop'
  } catch {
    /* neither — nothing installed; default to proxy */
  }
  return 'proxy'
}

export async function recordRegime(regime: ModRegime): Promise<void> {
  await mkdir(dirname(modRegimeFile()), { recursive: true })
  const tmp = `${modRegimeFile()}.tmp`
  await writeFile(tmp, JSON.stringify({ regime, setAt: new Date().toISOString() }, null, 2), 'utf8')
  await rename(tmp, modRegimeFile())
}

export async function clearRegime(): Promise<void> {
  try {
    await unlink(modRegimeFile())
  } catch {
    /* already absent — disk detection takes over */
  }
}

// Single source of truth for every mod path, by active (or explicit) regime.
export async function resolveRegimePaths(r?: ModRegime): Promise<RegimePaths> {
  const regime = r ?? (await activeRegime())
  if (regime === 'workshop') {
    return {
      regime,
      ue4ssRoot: nativemodsUe4ssDir(),
      ue4ssModsDir: join(nativemodsUe4ssDir(), 'Mods'),
      palSchemaModsDir: join(nativemodsUe4ssDir(), 'Mods', 'PalSchema', 'mods'),
      // Paks stay in ~mods in BOTH regimes: it's an engine-level auto-mount, not
      // UE4SS-dependent, so our managed paks load unchanged after a swap. The
      // official ~WorkshopMods is only where the loader deploys workshop-sourced
      // paks — not a path we manage.
      pakModsDir: pakModsDir(),
      injection: 'official',
      enable: 'palmodsettings',
    }
  }
  return {
    regime: 'proxy',
    ue4ssRoot: ue4ssDir(),
    ue4ssModsDir: join(ue4ssDir(), 'Mods'),
    palSchemaModsDir: join(ue4ssDir(), 'Mods', 'PalSchema', 'mods'),
    pakModsDir: pakModsDir(),
    injection: 'dwmapi',
    enable: 'mods.txt',
  }
}

// Regime-aware pak dir (~mods proxy | ~WorkshopMods workshop). Consumers still
// importing the pakModsDir() const are proxy-only and migrate when workshop pak
// management lands (spec §4).
export async function resolvePakModsDir(r?: ModRegime): Promise<string> {
  return (await resolveRegimePaths(r)).pakModsDir
}

// Known short-SHA -> source. The experimental-palworld tag moves; bump this when
// its SHA changes (like PSP_SHA in the Dockerfile). Unknown SHAs report 'unknown'.
const UE4SS_KNOWN_SHAS: Record<string, Ue4ssSource> = {
  c2ac246: 'official', // RE-UE4SS v3.0.1 stable (what shipped here)
  c838a8a: 'experimental-palworld', // Okaetsu build PalSchema 0.6.1 pairs with
}

export type Ue4ssSource = 'official' | 'experimental-palworld' | 'beta' | 'unknown'
export type Ue4ssStatus = {
  installed: boolean // ue4ss present (proxy: ue4ss/ + dwmapi; workshop: NativeMods/UE4SS or staged pkg)
  enabled: boolean // proxy: dwmapi.dll active; workshop: bGlobalEnableMod=True
  running: boolean // the game container is running (from metrics.json)
  regime: ModRegime // which injection regime is active (spec official-workshop-mods.md)
  injection: 'dwmapi' | 'official' // how UE4SS is injected in the active regime
  // STAGED — what a swap wrote to disk / what will load next boot. Drives the
  // "which build is selected" UI so a swap reflects immediately, before restart.
  stagedSource: Ue4ssSource | null
  stagedVersion: string | null
  // LOADED — the live boot banner, but ONLY trusted when it post-dates the
  // current container boot (otherwise it's a stale banner from a previous boot,
  // e.g. UE4SS silently failed to inject). `loaded` gates that trust.
  loaded: boolean
  source: Ue4ssSource | null
  version: string | null
  sha: string | null
  buildConfig: string | null
  // Staged build isn't what's actually loaded (not restarted yet, or it failed
  // to inject) — the cue that a restart is needed to apply a swap.
  pendingRestart: boolean
}

// Staged-build marker (dashboard-owned, ./data volume): records what the last
// swap installed, since the on-disk DLLs don't expose their build cheaply and the
// boot banner only reflects the LAST BOOT. Normalized to Ue4ssSource vocabulary.
const ue4ssStagedFile = () => dataFile('ue4ss-staged', process.env.UE4SS_STAGED_FILE)
const ue4ssMetricsFile = () => resolveLifecyclePaths(currentInstanceId()).metrics

export async function recordStagedUe4ss(source: Ue4ssSource, version: string | null): Promise<void> {
  try {
    await mkdir(dirname(ue4ssStagedFile()), { recursive: true })
    await writeFile(
      ue4ssStagedFile(),
      JSON.stringify({ source, version, installedAt: new Date().toISOString() }, null, 2),
      'utf8',
    )
  } catch {
    /* best-effort — the badge degrades to the loaded build if this is missing */
  }
}

// Forget the staged marker (e.g. after a rollback, whose restored build we don't
// classify) so status falls back to the live banner rather than a stale claim.
export async function clearStagedUe4ss(): Promise<void> {
  try {
    await unlink(ue4ssStagedFile())
  } catch {
    /* already absent */
  }
}

async function readStagedUe4ss(): Promise<{ source: Ue4ssSource; version: string | null } | null> {
  try {
    const j = JSON.parse(await readFile(ue4ssStagedFile(), 'utf8')) as {
      source?: Ue4ssSource
      version?: string | null
    }
    return j.source ? { source: j.source, version: j.version ?? null } : null
  } catch {
    return null
  }
}

// The game container's run state + boot time, from the host metrics publisher —
// lets us tell a live banner from a stale one without docker access.
async function readGameRuntime(): Promise<{ running: boolean; startedAt: Date | null }> {
  try {
    const m = JSON.parse(await readFile(ue4ssMetricsFile(), 'utf8')) as {
      status?: string
      startedAt?: string
    }
    const startedAt = m.startedAt ? new Date(m.startedAt) : null
    return { running: m.status === 'running', startedAt: startedAt && !isNaN(+startedAt) ? startedAt : null }
  } catch {
    return { running: false, startedAt: null }
  }
}

// Whether the official loader's global switch is on (workshop-regime "enabled").
async function readGlobalEnableMod(): Promise<boolean> {
  try {
    const ini = await readFile(palModSettingsFile(), 'utf8')
    return /^\s*bGlobalEnableMod\s*=\s*true\s*$/im.test(ini)
  } catch {
    return false
  }
}

export async function readUe4ssStatus(): Promise<Ue4ssStatus> {
  // Regime-aware (spec official-workshop-mods.md): the workshop layout injects via
  // the official loader (no dwmapi) with UE4SS under NativeMods/UE4SS, so presence,
  // enable, and the log all move. Proxy regime is unchanged.
  const regime = await activeRegime()
  const paths = await resolveRegimePaths(regime)

  let enabled = false
  let hasProxy = false
  let ue4ssPresent = false
  let logCandidates: string[]

  if (regime === 'workshop') {
    // UE4SS deployed by the loader under NativeMods/UE4SS (after first boot), or
    // still staged as the workshop package before that. "enabled" = loader switch.
    for (const p of [paths.ue4ssRoot, join(workshopContentDir(), UE4SS_SYNTH_ID)]) {
      try {
        await stat(p)
        ue4ssPresent = true
        break
      } catch {
        /* next */
      }
    }
    hasProxy = ue4ssPresent // no dwmapi in this regime — presence stands in for it
    enabled = await readGlobalEnableMod()
    logCandidates = [join(paths.ue4ssRoot, 'UE4SS.log')]
  } else {
    // Proxy regime (community dwmapi). MODERN install lives under ue4ss/, FLAT
    // (stable) puts UE4SS.dll + its log at the Win64 root — check both.
    try {
      await stat(dwmapiDll())
      enabled = true
      hasProxy = true
    } catch {
      try {
        await stat(DWMAPI_DISABLED)
        hasProxy = true // present but renamed aside = disabled
      } catch {
        /* no proxy at all */
      }
    }
    for (const p of [ue4ssDir(), join(win64Dir(), 'UE4SS.dll')]) {
      try {
        await stat(p)
        ue4ssPresent = true
        break
      } catch {
        /* try next layout */
      }
    }
    logCandidates = [ue4ssLog(), join(win64Dir(), 'UE4SS.log')]
  }

  let version: string | null = null
  let sha: string | null = null
  let buildConfig: string | null = null
  let bannerTs: Date | null = null
  try {
    let log = ''
    for (const p of logCandidates) {
      try {
        log = await readFile(p, 'utf8')
        break
      } catch {
        /* try the next candidate */
      }
    }
    if (!log) throw new Error('no log')
    // Capture the leading `[YYYY-MM-DD HH:MM:SS.sss]` timestamp too (log TZ is
    // UTC — "local disabled due to wine") so we can tell this boot's banner from
    // a stale one.
    const banners = [
      ...log.matchAll(/\[([\d-]+ [\d:.]+)\][^\n]*?UE4SS - (v[\d.]+[^-\n]*?) - Git SHA #(\w+)/g),
    ]
    if (banners.length) {
      const last = banners[banners.length - 1]
      const t = new Date(`${last[1].replace(' ', 'T')}Z`)
      bannerTs = isNaN(+t) ? null : t
      version = last[2].trim()
      sha = last[3]
    }
    const cfg = [...log.matchAll(/UE4SS Build Configuration:\s*(.+)/g)]
    if (cfg.length) buildConfig = cfg[cfg.length - 1][1].trim()
  } catch {
    /* never loaded / no log */
  }

  // The log's short SHA length varies (7 or 8 chars), so match by prefix
  // either direction rather than exact key lookup.
  const classify = (s: string | null): Ue4ssSource | null => {
    if (!s) return null
    const hit = Object.entries(UE4SS_KNOWN_SHAS).find(
      ([known]) => s.startsWith(known) || known.startsWith(s),
    )
    return hit ? hit[1] : 'unknown'
  }
  const source = classify(sha)

  // loaded-truth: a banner alone is not proof UE4SS is running NOW — it may be
  // from a previous boot (a silent injection failure leaves the old banner). So
  // when the container is running with a known boot time, require the banner to
  // post-date it; if the container is stopped, nothing is loaded.
  const { running, startedAt } = await readGameRuntime()
  let loaded = false
  if (version !== null) {
    if (!running) loaded = false
    else if (startedAt && bannerTs) loaded = bannerTs.getTime() >= startedAt.getTime() - 5000
    else loaded = true // running but no boot time to check against — trust the banner
  }

  // Staged build (what a swap wrote). Falls back to the loaded build for installs
  // that predate the marker, so the UI is never blank.
  const staged = await readStagedUe4ss()
  const stagedSource = staged?.source ?? source
  const stagedVersion = staged?.version ?? version
  const pendingRestart =
    stagedSource != null && (!loaded || (source != null && stagedSource !== source))

  return {
    installed: ue4ssPresent && hasProxy,
    enabled,
    running,
    regime,
    injection: paths.injection,
    stagedSource,
    stagedVersion,
    loaded,
    source,
    version,
    sha,
    buildConfig,
    pendingRestart,
  }
}

// Toggle the whole loader by renaming the proxy (reversible; next-restart effect).
export async function setUe4ssEnabled(enabled: boolean): Promise<void> {
  if (enabled) {
    try {
      await stat(DWMAPI_DISABLED)
      await rename(DWMAPI_DISABLED, dwmapiDll())
    } catch {
      /* already enabled or nothing to enable */
    }
  } else {
    try {
      await stat(dwmapiDll())
      await rename(dwmapiDll(), DWMAPI_DISABLED)
    } catch {
      /* already disabled */
    }
  }
}

// ── UE4SS install / swap engine (spec §2) ───────────────────────────────────
// A swap REWRITES the injection layer, so it: (1) refuses unless the server is
// stopped [caller-enforced], (2) tars the current UE4SS to backups first
// (rollback point), (3) validates the incoming zip is a UE4SS build (not a mod),
// (4) extracts it — flattening a single wrapper folder — preserving the
// operator's UE4SS-settings.ini. Rollback restores the tarball.
const ue4ssBackupDir = () => join(gameDir(), 'backups')
const DWMAPI_DISABLED_DLL = `${dwmapiDll()}.disabled`
const ue4ssSettings = () => join(ue4ssDir(), 'UE4SS-settings.ini')

// official/beta = RE-UE4SS releases; palschema = the Okaetsu fork PalSchema needs
// (Palworld-specific experimental build). A generic upload path covers anything else.
export type Ue4ssDownloadSource = 'official' | 'beta' | 'palschema'
const UE4SS_RELEASE_API: Record<Ue4ssDownloadSource, string> = {
  official: 'https://api.github.com/repos/UE4SS-RE/RE-UE4SS/releases/latest',
  beta: 'https://api.github.com/repos/UE4SS-RE/RE-UE4SS/releases/tags/experimental-latest',
  palschema: 'https://api.github.com/repos/Okaetsu/RE-UE4SS/releases/tags/experimental-palworld',
}

function ue4ssStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '')
}

export type Ue4ssBackup = { file: string; sizeBytes: number; modifiedAt: string | null }

export async function listUe4ssBackups(): Promise<Ue4ssBackup[]> {
  try {
    const names = await readdir(ue4ssBackupDir())
    const out: Ue4ssBackup[] = []
    for (const name of names) {
      if (!/^ue4ss-.*\.tar\.gz$/.test(name)) continue
      const s = await stat(join(ue4ssBackupDir(), name))
      out.push({ file: name, sizeBytes: s.size, modifiedAt: s.mtime.toISOString() })
    }
    return out.sort((a, b) => (b.modifiedAt ?? '').localeCompare(a.modifiedAt ?? ''))
  } catch {
    return []
  }
}

// UE4SS artifacts that sit at the Win64 ROOT in a FLAT install (the stock RE-UE4SS
// layout: UE4SS.dll + Mods/ beside dwmapi.dll), vs the modern layout where they
// live under ue4ss/. Listed so a swap can back up and clean-wipe a flat install —
// leaving PalDefender/d3d9/steam/game files at that root untouched.
const FLAT_UE4SS_ARTIFACTS = [
  'ue4ss',
  'dwmapi.dll',
  'dwmapi.dll.disabled',
  'UE4SS.dll',
  'UE4SS-settings.ini',
  'MemberVariableLayout.ini',
  'Changelog.md',
  'README.md',
  'Mods',
]

// Remove BOTH possible UE4SS layouts (modern ue4ss/ + flat root files) + the
// dwmapi proxy, and nothing else — so a cross-layout swap can't leave a remnant
// install that shadows the new one (the failure mode that broke a Stable swap).
async function wipeUe4ssLayouts(): Promise<void> {
  for (const name of FLAT_UE4SS_ARTIFACTS) {
    await rm(join(win64Dir(), name), { recursive: true, force: true })
  }
}

// Read every file under `dir` into memory keyed relative to `dir` (for carrying
// operator config + custom mods across a layout change).
async function snapshotTree(dir: string): Promise<{ rel: string; data: Buffer }[]> {
  const out: { rel: string; data: Buffer }[] = []
  const walk = async (d: string, base: string) => {
    let ents
    try {
      ents = await readdir(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of ents) {
      const full = join(d, e.name)
      const rel = base ? `${base}/${e.name}` : e.name
      if (e.isDirectory()) await walk(full, rel)
      else {
        try {
          out.push({ rel, data: await readFile(full) })
        } catch {
          /* skip */
        }
      }
    }
  }
  await walk(dir, '')
  return out
}

// Tar the current UE4SS install (either layout) + dwmapi proxy so a swap is
// reversible. Includes the flat-root artifacts, so a flat install rolls back too.
export async function backupUe4ss(): Promise<string> {
  await mkdir(ue4ssBackupDir(), { recursive: true })
  const status = await readUe4ssStatus()
  const tag =
    (status.version ?? 'unknown').replace(/[^\w.]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown'
  const file = `ue4ss-${tag}-${ue4ssStamp()}.tar.gz`
  const items: string[] = []
  for (const name of FLAT_UE4SS_ARTIFACTS) {
    try {
      await stat(join(win64Dir(), name))
      items.push(name)
    } catch {
      /* skip absent */
    }
  }
  if (!items.length) throw new Error('Nothing to back up (no ue4ss/ or dwmapi.dll present)')
  await execFileP('tar', ['-czf', join(ue4ssBackupDir(), file), '-C', win64Dir(), ...items])
  return file
}

// Validate + extract a UE4SS build zip into Win64/. Backs up first. Returns the
// backup name so the caller can offer a rollback.
export async function installUe4ssZip(buffer: Buffer): Promise<{ backup: string; preservedSettings: boolean }> {
  let zip: AdmZip
  try {
    zip = new AdmZip(buffer)
  } catch {
    throw new Error('Not a valid zip file')
  }
  const files = zip.getEntries().filter((e) => !e.isDirectory)
  if (!files.length) throw new Error('The zip is empty')

  // Flatten a single wrapper folder (the nested-zip trap): strip a common top
  // segment only if the payload (dwmapi.dll / UE4SS.dll / ue4ss/) lives under it.
  const topSegs = new Set(files.map((e) => e.entryName.replace(/\\/g, '/').split('/')[0]))
  let strip = ''
  if (topSegs.size === 1) {
    const only = [...topSegs][0].toLowerCase()
    const under = files.some((e) => {
      const n = e.entryName.replace(/\\/g, '/').toLowerCase()
      return n === `${only}/dwmapi.dll` || n === `${only}/ue4ss.dll` || n.startsWith(`${only}/ue4ss/`)
    })
    if (under) strip = `${[...topSegs][0]}/`
  }
  // strip the wrapper + normalize a capitalized UE4SS/ prefix
  const stripped = (name: string) => {
    let n = name.replace(/\\/g, '/')
    if (strip && n.startsWith(strip)) n = n.slice(strip.length)
    return n.replace(/^UE4SS\//, 'ue4ss/')
  }
  const strippedNames = files.map((e) => stripped(e.entryName))
  const hasDwmapi = strippedNames.some((n) => n.toLowerCase() === 'dwmapi.dll')
  // Two release layouts: MODERN (files already under ue4ss/, like the PalSchema
  // build + our install) vs FLAT (UE4SS.dll + Mods/ at the zip root, like the
  // stock RE-UE4SS release). For a flat zip we nest everything-but-dwmapi.dll
  // under ue4ss/ to match this install — extracting flat would strand a legacy
  // Win64/Mods next to the modern Win64/ue4ss (the remnant PalSchema warns of).
  const isModern = strippedNames.some((n) => /^ue4ss\//i.test(n))
  const hasFlatUe4ss = strippedNames.some((n) => /^UE4SS\.dll$/i.test(n))
  if (!hasDwmapi || (!isModern && !hasFlatUe4ss)) {
    throw new Error(
      'This does not look like a UE4SS build (needs dwmapi.dll + UE4SS.dll). If it is a MOD, use the mod-install section instead.',
    )
  }

  // Install each build in its NATIVE layout — flat stays at the Win64 root, modern
  // stays under ue4ss/. (The old code force-nested flat builds under ue4ss/, which
  // broke the flat build's dwmapi proxy: it looks for UE4SS.dll beside itself and
  // couldn't find it under ue4ss/, so UE4SS silently never injected — the Stable
  // swap that came up dead.)
  const rel = stripped
  const newModsDir = isModern ? join(ue4ssDir(), 'Mods') : join(win64Dir(), 'Mods')
  const newSettings = isModern ? ue4ssSettings() : join(win64Dir(), 'UE4SS-settings.ini')

  // Framework mod folders the incoming build ships — everything ELSE in the
  // current Mods dir is an operator/custom mod to carry across the swap.
  const incomingMods = new Set<string>()
  for (const n of strippedNames) {
    const m = n.match(/^(?:ue4ss\/)?Mods\/([^/]+)\//i)
    if (m) incomingMods.add(m[1].toLowerCase())
  }

  const backup = await backupUe4ss()

  // Snapshot the operator's config + custom mods from the CURRENT install
  // (whatever layout) BEFORE the wipe, so they survive a cross-layout swap.
  const curModsDir = await resolveUe4ssModsDir()
  let savedModsTxt: string | null = null
  let savedEnabledTxt: string | null = null
  let savedSettings: string | null = null
  const savedCustomMods: { rel: string; data: Buffer }[] = []
  const skippedCppMods = new Set<string>() // ABI-locked C++ mods not carried across the swap
  for (const p of [ue4ssSettings(), join(win64Dir(), 'UE4SS-settings.ini')]) {
    try {
      savedSettings = await readFile(p, 'utf8')
      break
    } catch {
      /* try next location */
    }
  }
  if (curModsDir) {
    try {
      savedModsTxt = await readFile(join(curModsDir, 'mods.txt'), 'utf8')
    } catch {
      /* none */
    }
    try {
      savedEnabledTxt = await readFile(join(curModsDir, 'enabled.txt'), 'utf8')
    } catch {
      /* none */
    }
    let folders: string[] = []
    try {
      folders = (await readdir(curModsDir, { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
    } catch {
      /* none */
    }
    for (const folder of folders) {
      const low = folder.toLowerCase()
      if (low === 'shared' || incomingMods.has(low)) continue // UE4SS runtime / framework — comes from the zip
      // C++ mods (a dlls/*.dll) are ABI-locked to their UE4SS build: their DLL
      // imports functions from a specific UE4SS.dll, so carrying one onto a
      // different build makes UE4SS abort on load and the game crash on boot
      // (PalSchema's main.dll on the Stable build did exactly this). Skip them —
      // they're preserved in the pre-swap backup and reinstalled for the target
      // build (e.g. PalSchema via its own section) — and drop their mods.txt line
      // so UE4SS doesn't look for a now-absent mod.
      let isCppMod = false
      try {
        const dlls = await readdir(join(curModsDir, folder, 'dlls'))
        isCppMod = dlls.some((f) => f.toLowerCase().endsWith('.dll'))
      } catch {
        /* no dlls/ — a Lua/Blueprint mod, safe to migrate */
      }
      if (isCppMod) {
        skippedCppMods.add(low)
        continue
      }
      for (const f of await snapshotTree(join(curModsDir, folder))) {
        savedCustomMods.push({ rel: `${folder}/${f.rel}`, data: f.data })
      }
    }
  }

  // Clean-wipe BOTH layouts, then extract the new build natively.
  await wipeUe4ssLayouts()
  for (const entry of files) {
    const dest = join(win64Dir(), rel(entry.entryName))
    if (dest !== win64Dir() && !dest.startsWith(win64Dir() + sep)) continue // path-traversal guard
    await mkdir(dirname(dest), { recursive: true })
    await writeFile(dest, entry.getData())
  }
  // A fresh dwmapi.dll was just written; clear any leftover .disabled marker.
  try {
    await unlink(DWMAPI_DISABLED_DLL)
  } catch {
    /* none */
  }

  // Restore config + custom mods into the NEW layout's Mods dir (operator's
  // enable states win over the zip's shipped defaults; custom mods migrate over).
  await mkdir(newModsDir, { recursive: true })
  if (savedSettings != null) {
    await mkdir(dirname(newSettings), { recursive: true })
    await writeFile(newSettings, savedSettings)
  }
  if (savedModsTxt != null) {
    // Drop the enable lines for skipped C++ mods so UE4SS doesn't try to load a
    // now-absent (and incompatible) mod on the new build.
    const filtered = skippedCppMods.size
      ? savedModsTxt
          .split(/\r?\n/)
          .filter((line) => !skippedCppMods.has(line.split(':')[0].trim().toLowerCase()))
          .join('\n')
      : savedModsTxt
    await writeFile(join(newModsDir, 'mods.txt'), filtered)
  }
  if (savedEnabledTxt != null) await writeFile(join(newModsDir, 'enabled.txt'), savedEnabledTxt)
  for (const { rel: r, data } of savedCustomMods) {
    const dest = join(newModsDir, r)
    await mkdir(dirname(dest), { recursive: true })
    await writeFile(dest, data)
  }

  return { backup, preservedSettings: savedSettings != null }
}

// Fetch the standard (non-dev) UE4SS build zip from a RE-UE4SS release.
export async function downloadUe4ssRelease(source: Ue4ssDownloadSource): Promise<Buffer> {
  const rel = await fetch(UE4SS_RELEASE_API[source], {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'palworld-dashboard' },
    cache: 'no-store',
    signal: AbortSignal.timeout(15_000),
  })
  if (!rel.ok) throw new Error(`GitHub release lookup failed (${rel.status})`)
  const data = (await rel.json()) as { assets?: { name: string; browser_download_url: string }[] }
  const asset = (data.assets ?? []).find(
    (a) => /^UE4SS.*\.zip$/i.test(a.name) && !/zdev|_dev|dev-/i.test(a.name),
  )
  if (!asset) throw new Error('No standard UE4SS build zip found in the release')
  const dl = await fetch(asset.browser_download_url, {
    headers: { 'User-Agent': 'palworld-dashboard' },
    cache: 'no-store',
    signal: AbortSignal.timeout(120_000),
  })
  if (!dl.ok) throw new Error(`Download failed (${dl.status})`)
  return Buffer.from(await dl.arrayBuffer())
}

// Restore a ue4ss backup tarball (rollback). Clean-wipes BOTH layouts first so a
// flat backup restores as cleanly as a modern one (the tarball now carries the
// flat-root artifacts too).
export async function rollbackUe4ss(backupFile: string): Promise<void> {
  if (!/^ue4ss-[\w.-]+\.tar\.gz$/.test(backupFile)) throw new Error('Invalid backup file name')
  const full = join(ue4ssBackupDir(), backupFile)
  await stat(full)
  await wipeUe4ssLayouts()
  await execFileP('tar', ['-xzf', full, '-C', win64Dir()])
}

// PalDefender is NOT a UE4SS mod: it's the standalone d3d9 injection. Wine loads
// Win64/d3d9.dll (the loader), which reads d3d9_config.json and loads the DLLs
// listed in `load_dlls` (PalDefender.dll here). So we toggle PalDefender by
// adding/removing PalDefender.dll from that list -- the loader's own mechanism,
// which avoids the missing-DLL errors renaming PalDefender.dll would cause.
// Takes effect on the next server restart, like every other mod toggle.
export const D3D9_CONFIG_PATH = join(win64Dir(), 'd3d9_config.json')
export const PALDEFENDER_DLL = 'PalDefender.dll'
const paldefenderDllPath = () => join(win64Dir(), PALDEFENDER_DLL)

function loadDllsFrom(cfg: unknown): string[] {
  const list = (cfg as { load_dlls?: unknown } | null)?.load_dlls
  return Array.isArray(list) ? list.filter((d): d is string => typeof d === 'string') : []
}

// installed = the PalDefender DLL is present at all; enabled = it's in load_dlls.
export async function readPalDefenderState(): Promise<{ installed: boolean; enabled: boolean }> {
  try {
    await stat(paldefenderDllPath())
  } catch {
    return { installed: false, enabled: false }
  }
  let enabled = false
  try {
    const cfg = JSON.parse(await readFile(D3D9_CONFIG_PATH, 'utf8'))
    enabled = loadDllsFrom(cfg).some((d) => d.toLowerCase() === PALDEFENDER_DLL.toLowerCase())
  } catch {
    enabled = false // missing/invalid loader config → treat as disabled
  }
  return { installed: true, enabled }
}

export async function setPalDefenderEnabled(enabled: boolean): Promise<void> {
  let cfg: Record<string, unknown> = {}
  try {
    cfg = JSON.parse(await readFile(D3D9_CONFIG_PATH, 'utf8')) as Record<string, unknown>
  } catch {
    cfg = {} // start fresh if the loader config is absent/corrupt
  }
  // Preserve any other loaded DLLs + config keys; only add/remove PalDefender.
  const without = loadDllsFrom(cfg).filter((d) => d.toLowerCase() !== PALDEFENDER_DLL.toLowerCase())
  cfg.load_dlls = enabled ? [...without, PALDEFENDER_DLL] : without
  const tmp = `${D3D9_CONFIG_PATH}.tmp`
  await writeFile(tmp, JSON.stringify(cfg, null, 4) + '\n', 'utf8')
  await rename(tmp, D3D9_CONFIG_PATH) // atomic — never leaves the loader config half-written
}

// ── Archive install routing (Nexus Phase 2) ─────────────────────────────────
// Nexus mods are zips of varying kinds; auto-detect from the content so an
// install-from-URL doesn't need the admin to pick a type. PalSchema is routed to
// its own installer (lib/palschema); pak/UE4SS use the small helpers below.
export type DetectedKind = 'palschema' | 'ue4ss' | 'pak' | null

export function detectModKind(buffer: Buffer): DetectedKind {
  let zip: AdmZip
  try {
    zip = new AdmZip(buffer)
  } catch {
    return null
  }
  const names = zip
    .getEntries()
    .filter((e) => !e.isDirectory)
    .map((e) => e.entryName.replace(/\\/g, '/'))
  // PalSchema counts only when there's REAL data (a .json/.jsonc UNDER PalSchema/
  // mods/), not just a placeholder folder. Some Lua mods ship an empty
  // PalSchema/mods/<name>/raw/keep.txt scaffold; that must NOT hijack the Lua mod
  // into the PalSchema installer (which then errors "no JSON content"). (mod 3546)
  const hasPalSchemaData = names.some((n) => /(^|\/)PalSchema\/mods\/.+\.jsonc?$/i.test(n))
  const hasJson = names.some((n) => /\.jsonc?$/i.test(n))
  const hasLua = names.some((n) => {
    const l = n.toLowerCase()
    return l.includes('/scripts/') || l.startsWith('scripts/') || l.includes('/dlls/') || l.startsWith('dlls/') || l.endsWith('.lua') || l.endsWith('/main.dll')
  })
  const hasPak = names.some((n) => /\.(pak|utoc|ucas)$/i.test(n))
  // Lua wins over a bare-json heuristic: a Lua mod may carry config.json/Json.lua at
  // its root (mods 4547/3546). A zip that ALSO has real PalSchema data (a genuine
  // combined mod) gets its PalSchema part installed too — see installModFile.
  if (hasLua) return 'ue4ss'
  if (hasPalSchemaData || hasJson) return 'palschema'
  if (hasPak) return 'pak'
  return null
}

// Does this archive carry real PalSchema data (a .json/.jsonc under PalSchema/mods/)?
// Lets the install pipeline place the PalSchema half of a combined Lua+PalSchema mod
// even when detectModKind classified it 'ue4ss'.
export function archiveHasPalSchemaData(buffer: Buffer): boolean {
  try {
    return new AdmZip(buffer)
      .getEntries()
      .some((e) => !e.isDirectory && /(^|\/)PalSchema\/mods\/.+\.jsonc?$/i.test(e.entryName.replace(/\\/g, '/')))
  } catch {
    return false
  }
}

// Extract pak-family assets from a zip into ~mods (a plain pak mod delivered as a zip).
export async function installPakArchive(buffer: Buffer): Promise<string[]> {
  const zip = new AdmZip(buffer)
  const paks = zip.getEntries().filter((e) => !e.isDirectory && /\.(pak|utoc|ucas)$/i.test(e.entryName))
  if (!paks.length) throw new Error('No pak files found in the archive')
  await mkdir(pakModsDir(), { recursive: true })
  const out: string[] = []
  for (const e of paks) {
    let name = basename(e.entryName.replace(/\\/g, '/'))
    if (!/\.(pak|utoc|ucas)$/i.test(name)) continue
    // Some authors ship paks with spaces/parens in the filename (e.g. mods 3658,
    // 3434: "358 GuildChest Slots_P.pak"). Map anything outside the safe set to
    // '_' so they install instead of being skipped — the pak still loads (~mods
    // scans by extension, not name). basename() already stripped any path.
    name = name.replace(/[^A-Za-z0-9_.-]/g, '_')
    const dest = join(pakModsDir(), name)
    if (dest !== pakModsDir() && !dest.startsWith(pakModsDir() + sep)) continue
    await writeFile(dest, e.getData())
    out.push(name)
  }
  if (!out.length) throw new Error('No pak files found in the archive')
  return out
}

// Install UE4SS mod(s) delivered as a zip, robust to the layouts seen in the wild:
//  - split pak-family assets to ~mods (Lua+pak HYBRIDS ship a .pak too),
//  - anchor the mod folder on a .../ue4ss/Mods/<name>/ segment when present (game-
//    root drop-ins, and odd nestings like Mods/NativeMods/UE4SS/Mods/<name>/ that
//    use backslash paths); else fall back to a single bare top folder,
//  - extract each mod folder to Mods/<name> and register it in mods.txt.
// Returns the installed mod name(s) + any pak filenames split out.
// Strip a Nexus file-name suffix from a derived mod folder name — a trailing
// `-<modid>-<version…>-<unix timestamp>` (e.g. "LessRestrictiveBuilding-98-1-2-1734970943"
// → "LessRestrictiveBuilding"), only when the result is still a safe, non-empty name.
// Applied to every UE4SS mod name at install so folders/mods.txt/associations stay clean.
export function cleanModName(name: string): string {
  const cleaned = name.replace(/-\d+(?:[-.]\d+)*-\d{9,}$/, '')
  return cleaned && cleaned !== name && isSafeModFolderName(cleaned) ? cleaned : name
}

// A config-looking file we preserve across an update (config*/settings* data files),
// excluding *.default.*/*.example.* templates (those are seeds, safe to refresh).
function isConfigLikeRel(rel: string): boolean {
  const b = basename(rel.replace(/\\/g, '/')).toLowerCase()
  if (/\.(default|example)\./.test(b)) return false
  return /(config|settings)[\w.-]*\.(lua|jsonc?|ini)$/.test(b)
}

export async function installUe4ssModArchive(
  buffer: Buffer,
  nameHint?: string,
  replace = false, // update path: overwrite an existing mod folder in place instead of refusing
): Promise<{ name: string; pakFiles: string[] }> {
  const modsDir = await resolveUe4ssModsDir()
  if (!modsDir) throw new Error('UE4SS Mods directory not found')
  const zip = new AdmZip(buffer)
  const all = zip.getEntries().filter((e) => !e.isDirectory)
  if (!all.length) throw new Error('The zip is empty')
  const norm = (n: string) => n.replace(/\\/g, '/')

  // 1. Split pak-family assets out to ~mods (hybrid Lua+pak mods).
  const pakEntries = all.filter((e) => /\.(pak|utoc|ucas)$/i.test(norm(e.entryName)))
  const nonPak = all.filter((e) => !/\.(pak|utoc|ucas)$/i.test(norm(e.entryName)))
  const pakFiles: string[] = []
  if (pakEntries.length) {
    await mkdir(pakModsDir(), { recursive: true })
    for (const e of pakEntries) {
      const nm = basename(norm(e.entryName))
      if (!/^[A-Za-z0-9_.-]+\.(pak|utoc|ucas)$/i.test(nm)) continue
      const dest = join(pakModsDir(), nm)
      if (dest !== pakModsDir() && !dest.startsWith(pakModsDir() + sep)) continue
      await writeFile(dest, e.getData())
      pakFiles.push(nm)
    }
  }

  // 1b. PalSchema companion of a combined Lua+PalSchema mod. Such a mod ships its
  //     PalSchema half under …/PalSchema/mods/<name>/… — sometimes real .json data,
  //     sometimes just a `raw/keep.txt` placeholder whose only job is to create the
  //     directory the Lua half writes generated JSON into at runtime (mod 3546). We
  //     must NOT install it as a UE4SS mod (it's skipped in the anchor loop below),
  //     but dropping it makes the Lua mod load and then fail on io.open. So extract
  //     the whole subtree verbatim into the PalSchema mods dir — but only when
  //     PalSchema itself is installed (otherwise there's no loader for it anyway).
  const psAnchor = /(?:^|\/)PalSchema\/mods\/([^/]+)\/(.+)$/i
  const psEntries = nonPak
    .map((e) => ({ e, m: norm(e.entryName).match(psAnchor) }))
    .filter((x): x is { e: AdmZip.IZipEntry; m: RegExpMatchArray } => x.m !== null)
  if (psEntries.length) {
    const psModsDir = join(modsDir, 'PalSchema', 'mods')
    const psPresent = await stat(join(modsDir, 'PalSchema')).then(() => true).catch(() => false)
    if (psPresent) {
      for (const { e, m } of psEntries) {
        const [, name, rel] = m
        if (!isSafeModFolderName(name)) continue
        const modRoot = join(psModsDir, name)
        const dest = join(modRoot, rel)
        if (dest !== modRoot && !dest.startsWith(modRoot + sep)) continue // path escape
        await mkdir(dirname(dest), { recursive: true })
        await writeFile(dest, e.getData())
      }
    }
  }

  // 2. Group the mod content by folder. Anchored (…/ue4ss/Mods/<name>/…) first;
  //    else a single bare top-level folder.
  const mods = new Map<string, { rel: string; entry: AdmZip.IZipEntry }[]>()
  const anchor = /(?:^|\/)ue4ss\/Mods\/([^/]+)\/(.+)$/i
  for (const e of nonPak) {
    const m = norm(e.entryName).match(anchor)
    if (!m) continue
    // Skip the PalSchema framework dir (…/ue4ss/Mods/PalSchema/mods/…) and UE4SS's
    // reserved `shared`: PalSchema DATA is installed by installPalSchemaSubmod, not
    // as a UE4SS mod — otherwise a combined mod's PalSchema half becomes a junk
    // "PalSchema" mod folder (mod 3546).
    if (/^(palschema|shared)$/i.test(m[1])) continue
    const list = mods.get(m[1]) ?? []
    list.push({ rel: m[2], entry: e })
    mods.set(m[1], list)
  }
  // Legacy UE4SS location (pre-ue4ss-subdir): old mods ship the full game path
  // Pal/Binaries/Win64/Mods/<name>/… (no `ue4ss/`, e.g. Nexus 607). Anchor on that too so the
  // mod folder lands in the CURRENT ue4ss/Mods — otherwise a Content/ sibling stops the
  // wrapper-peel and the whole tree is dumped under one folder (Scripts buried → never loads).
  if (mods.size === 0) {
    const legacyAnchor = /(?:^|\/)Win64\/Mods\/([^/]+)\/(.+)$/i
    for (const e of nonPak) {
      const m = norm(e.entryName).match(legacyAnchor)
      if (!m) continue
      if (/^(palschema|shared)$/i.test(m[1])) continue
      const list = mods.get(m[1]) ?? []
      list.push({ rel: m[2], entry: e })
      mods.set(m[1], list)
    }
  }
  if (mods.size === 0) {
    // `eff(e)` is the entry path with any peeled wrapper prefix removed (see the peel
    // loop below); all detection runs against it. A top folder is a UE4SS mod if it holds
    // a Scripts/ dir, an enabled.txt, or a .lua / main.dll.
    let peel = ''
    const eff = (e: AdmZip.IZipEntry) => norm(e.entryName).slice(peel.length)
    // `folder` IS a UE4SS mod when it DIRECTLY holds the mod-defining pieces: a Scripts/
    // (Lua) or dlls/ (C++) subdir, an enabled.txt, a main.dll, or a bare .lua at its root.
    // The check must be DIRECT — a `.lua` deep inside a nested mod folder must NOT qualify
    // the outer wrapper (that's what left mod 98 double-nested).
    const dirIsMod = (folder: string): boolean =>
      nonPak.some((e) => {
        const r = eff(e)
        if (!r.startsWith(`${folder}/`)) return false
        const rest = r.slice(folder.length + 1).toLowerCase()
        return (
          rest.startsWith('scripts/') ||
          rest.startsWith('dlls/') ||
          rest === 'enabled.txt' ||
          rest === 'main.dll' ||
          (!rest.includes('/') && rest.endsWith('.lua'))
        )
      })
    // PEEL redundant wrapper folders: a single top-level dir that isn't itself a mod but
    // holds the mod one level down — a Nexus file-name wrapper (mod 98 shipped
    // `LessRestrictiveBuilding-98…/LessRestrictiveBuilding/Scripts/…`). Without this the
    // wrapper became the mod name and the real mod was double-nested (Scripts one level
    // too deep → UE4SS never loaded it). Stops as soon as the top IS the mod folder.
    for (let guard = 0; guard < 8; guard++) {
      const tops = [...new Set(nonPak.map((e) => eff(e).split('/')[0]).filter(Boolean))]
      if (tops.length !== 1) break
      const top = tops[0]
      if (/^(scripts|dlls)$/i.test(top)) break // guts under this prefix — don't peel
      if (dirIsMod(top)) break // `top` IS the mod folder — let detection name it
      if (!nonPak.some((e) => eff(e).startsWith(`${top}/`))) break // nothing deeper
      peel += `${top}/`
    }

    // Detection on the peeled paths — the common "dropped at the root" layouts.
    const topFolders = [...new Set(nonPak.map((e) => eff(e).split('/')[0]))].filter(
      (f) => f && nonPak.some((e) => eff(e).startsWith(`${f}/`)),
    )
    // `Scripts`/`dlls` are a mod's INTERNAL dirs, never a mod name.
    const modFolders = topFolders.filter((f) => !/^(scripts|dlls)$/i.test(f) && dirIsMod(f))
    // Guts-at-root: Scripts/ or enabled.txt or a bare .lua at the (peeled) root, no wrapper.
    const gutsAtRoot = nonPak.some((e) => {
      const l = eff(e).toLowerCase()
      return l.startsWith('scripts/') || l === 'enabled.txt' || (!l.includes('/') && l.endsWith('.lua'))
    })

    if (modFolders.length) {
      // One OR MANY mods at the root (mod 4178 ships two) — install each folder.
      for (const folder of modFolders) {
        const prefix = `${folder}/`
        mods.set(
          folder,
          nonPak
            .filter((e) => eff(e).startsWith(prefix))
            .map((e) => ({ rel: eff(e).slice(prefix.length), entry: e }))
            .filter((x) => x.rel),
        )
      }
    } else if (gutsAtRoot && nameHint) {
      // Mod 4547: Scripts/main.lua + enabled.txt with no folder — name it from the hint.
      mods.set(nameHint, nonPak.map((e) => ({ rel: eff(e), entry: e })).filter((x) => x.rel))
    } else if (topFolders.length === 1) {
      // A single wrapper folder that isn't obviously a mod — use it as the mod name.
      const top = topFolders[0]
      const prefix = `${top}/`
      mods.set(
        top,
        nonPak
          .filter((e) => eff(e).startsWith(prefix))
          .map((e) => ({ rel: eff(e).slice(prefix.length), entry: e }))
          .filter((x) => x.rel),
      )
    } else if (nameHint) {
      mods.set(nameHint, nonPak.map((e) => ({ rel: eff(e), entry: e })).filter((x) => x.rel))
    } else if (pakFiles.length) {
      return { name: pakFiles[0], pakFiles } // pak-only after all
    } else {
      throw new Error(
        'No UE4SS mod folder found in the archive. Expected a Mods/<name>/ or <name>/Scripts/ layout — if this is a bare mod (Scripts/main.lua at the root), install it via manual upload so it can be named.',
      )
    }
  }

  // 3. Validate + install each mod folder (under a cleaned name — strips Nexus
  //    file-name suffixes so e.g. LessRestrictiveBuilding-98-1-2-… → LessRestrictiveBuilding).
  const names: string[] = []
  for (const [rawName, entries] of mods) {
    const name = cleanModName(rawName)
    if (!isSafeModFolderName(name) || name.toLowerCase() === 'shared') {
      throw new Error(`Unsafe UE4SS mod name: "${name}"`)
    }
    const targetDir = join(modsDir, name)
    // On a fresh install, refuse to clobber an existing mod. On an UPDATE (replace),
    // overwrite in place — the write loop below replaces the archive's files and leaves
    // anything else (e.g. a runtime config the mod keeps in its folder) untouched, which
    // is the "manual re-upload" semantics we want. Config kept in Pal/Saved/<mod>/ (e.g.
    // BaseRadiusImproved) is outside the folder and never affected.
    if (!replace) {
      try {
        await stat(targetDir)
        throw new Error(`A UE4SS mod named "${name}" already exists — remove it first to replace it.`)
      } catch (e) {
        if (e instanceof Error && e.message.includes('already exists')) throw e
      }
    }
    for (const { rel } of entries) {
      const dest = join(targetDir, rel)
      if (dest !== targetDir && !dest.startsWith(targetDir + sep)) {
        throw new Error(`Refusing to install: entry "${rel}" escapes the mod folder`)
      }
    }
    await mkdir(targetDir, { recursive: true })
    for (const { rel, entry } of entries) {
      const dest = join(targetDir, rel)
      // On an UPDATE, preserve the user's in-folder config: skip overwriting an existing
      // config-looking file (config*/settings* .lua/.json/.ini, not a *.default/*.example
      // template). Code/data files are still replaced. Config kept in Pal/Saved/<mod>/ is
      // outside the folder and untouched regardless.
      if (replace && isConfigLikeRel(rel) && (await stat(dest).then(() => true).catch(() => false))) {
        continue
      }
      await mkdir(dirname(dest), { recursive: true })
      await writeFile(dest, entry.getData())
    }
    const modsTxtPath = join(modsDir, 'mods.txt')
    const active = await readModsTxt(modsDir)
    active.set(name, true)
    const tmp = `${modsTxtPath}.tmp`
    await writeFile(tmp, serializeModsTxt(active), 'utf8')
    await rename(tmp, modsTxtPath)
    names.push(name)
  }
  return { name: names.join(', '), pakFiles }
}

// ── Mod grouping (hybrid mods) ──────────────────────────────────────────────
// A single install (e.g. a Nexus Lua+pak hybrid) can produce multiple list rows —
// the UE4SS/Lua mod AND its pak. Record that relationship so the UI can nest the
// pak(s) under the parent mod instead of showing them as separate top-level rows.
// Keyed by the same modKey the list uses ("ue4ss:<name>" / "pak:<file>").
const modGroupsFile = () => dataFile('mod-groups', process.env.MOD_GROUPS_FILE)

export async function readModGroups(): Promise<Record<string, string[]>> {
  try {
    return JSON.parse(await readFile(modGroupsFile(), 'utf8')) as Record<string, string[]>
  } catch {
    return {}
  }
}

async function writeModGroups(groups: Record<string, string[]>): Promise<void> {
  await mkdir(dirname(modGroupsFile()), { recursive: true })
  const tmp = `${modGroupsFile()}.tmp`
  await writeFile(tmp, JSON.stringify(groups, null, 2), 'utf8')
  await rename(tmp, modGroupsFile())
}

// Record (or clear, if children is empty) a parent → children grouping.
export async function setModGroup(parent: string, children: string[]): Promise<void> {
  const g = await readModGroups()
  if (children.length) g[parent] = children
  else delete g[parent]
  await writeModGroups(g)
}

// Remove a modKey from the group map, whether it's a parent or a child (called on
// mod removal so the map never points at a deleted mod).
// Manually (re)parent a mod: detach it from any current group, then nest it under
// `parentKey` (null/empty = just un-nest, back to a top-level row). Used by the Mods-tab
// "nest under…" affordance for mods whose paks/Lua arrived as separate downloads and so
// weren't auto-grouped.
export async function nestModUnder(childKey: string, parentKey: string | null): Promise<void> {
  await removeFromModGroups(childKey)
  if (parentKey && parentKey !== childKey) {
    const g = await readModGroups()
    const children = g[parentKey] ?? []
    if (!children.includes(childKey)) children.push(childKey)
    await setModGroup(parentKey, children)
  }
}

export async function removeFromModGroups(modKey: string): Promise<void> {
  const g = await readModGroups()
  let changed = false
  if (g[modKey]) {
    delete g[modKey]
    changed = true
  }
  for (const parent of Object.keys(g)) {
    const filtered = g[parent].filter((c) => c !== modKey)
    if (filtered.length !== g[parent].length) {
      changed = true
      if (filtered.length) g[parent] = filtered
      else delete g[parent]
    }
  }
  if (changed) await writeModGroups(g)
}

// ── Steam Workshop mod associations ─────────────────────────────────────────
// modKey ("ue4ss:<name>" / "pak:<file>") → the Workshop item it came from, so the
// mod row can show a "Steam Workshop ↗" link (the parallel of the Nexus link) and
// suppress the Nexus chip. Written on install, cleaned up on removal.
const steamModsFile = () => dataFile('steam-mods', process.env.STEAM_MODS_FILE)
export type SteamModLink = { itemId: string; name: string | null }

export async function readSteamMods(): Promise<Record<string, SteamModLink>> {
  try {
    return JSON.parse(await readFile(steamModsFile(), 'utf8')) as Record<string, SteamModLink>
  } catch {
    return {}
  }
}

async function writeSteamMods(links: Record<string, SteamModLink>): Promise<void> {
  await mkdir(dirname(steamModsFile()), { recursive: true })
  const tmp = `${steamModsFile()}.tmp`
  await writeFile(tmp, JSON.stringify(links, null, 2), 'utf8')
  await rename(tmp, steamModsFile())
}

export async function setSteamMod(modKey: string, link: SteamModLink): Promise<void> {
  const l = await readSteamMods()
  l[modKey] = link
  await writeSteamMods(l)
}

export async function removeFromSteamMods(modKey: string): Promise<void> {
  const l = await readSteamMods()
  if (l[modKey]) {
    delete l[modKey]
    await writeSteamMods(l)
  }
}

// Remove a pak file by basename from wherever it lives (~mods or LogicMods), including a
// `.disabled` variant. Best-effort — a missing file is fine.
async function removePakFile(name: string): Promise<void> {
  for (const dir of [pakModsDir(), logicModsDir()]) {
    await rm(join(dir, name), { force: true }).catch(() => {})
    await rm(join(dir, `${name}.disabled`), { force: true }).catch(() => {})
  }
}

// Fully remove a server-installed mod and EVERYTHING it shipped: the mod folder / pak
// file, its mods.txt entry, any GROUPED child pak FILES (hybrid Lua+pak mods), and all
// tracking rows (Nexus + Steam + group map). Returns the source ids so the caller can
// cascade the delete to a paired client stage. Does NOT cascade itself (avoids a loop).
export async function removeServerMod(
  id: string,
): Promise<{ nexusModId: number | null; steamItemId: string | null }> {
  const [kind, ...rest] = id.split(':')
  const name = rest.join(':')
  if ((kind !== 'ue4ss' && kind !== 'pak') || !name) throw new Error('Invalid mod id')

  // Capture source ids BEFORE stripping tracking, so the caller can find the counterpart.
  const nexusModId = await nexusModIdForKey(id)
  const steam = await readSteamMods()
  const steamItemId = steam[id]?.itemId ?? null

  // Grouped child paks (hybrid mods): delete the actual FILES, not just the map entry.
  const groups = await readModGroups()
  const children = groups[id] ?? []

  if (kind === 'ue4ss') {
    const modsDir = await resolveUe4ssModsDir()
    if (!modsDir) throw new Error('UE4SS Mods directory not found')
    await rm(join(modsDir, name), { recursive: true, force: true })
    const modsTxtPath = join(modsDir, 'mods.txt')
    try {
      const active = await readModsTxt(modsDir)
      active.delete(name)
      const tmp = `${modsTxtPath}.tmp`
      await writeFile(tmp, serializeModsTxt(active), 'utf8')
      await rename(tmp, modsTxtPath)
    } catch {
      // no mods.txt, or the mod was never listed — nothing to clean up
    }
  } else {
    await removePakFile(name)
  }

  for (const child of children) {
    const [ck, ...cr] = child.split(':')
    const cname = cr.join(':')
    if (ck === 'pak' && cname) await removePakFile(cname)
    await removeNexusAssoc(child)
    await removeFromSteamMods(child)
  }

  await removeFromModGroups(id)
  await removeFromSteamMods(id)
  await removeNexusAssoc(id)
  return { nexusModId, steamItemId }
}

// Cascade helper: remove server mods that came from a given source id (Nexus modId /
// Steam itemId) — used when a client-side delete should also drop the server copy.
export async function removeServerModsBySource(source: 'nexus' | 'steam', sourceId: string): Promise<string[]> {
  let keys: string[] = []
  if (source === 'nexus') {
    const n = Number(sourceId)
    if (Number.isFinite(n)) keys = await nexusKeysForModId(n)
  } else {
    const s = await readSteamMods()
    keys = Object.keys(s).filter((k) => s[k].itemId === sourceId)
  }
  const removed: string[] = []
  for (const k of keys) {
    try {
      await removeServerMod(k)
      removed.push(k)
    } catch {
      /* best-effort — keep going */
    }
  }
  return removed
}

// ── Workshop-layout swap engine (spec official-workshop-mods.md §5, Inc 2) ───
// Fourth loader build: migrate the proxy stack into the official layout and back.
// VALIDATED end-to-end in a staging round-trip (2026-07-31): proxy → workshop
// (loader deploys+injects UE4SS + PalSchema, PalDefender alive) → proxy (restored
// from backup, injects again). Synthesized packages work — no Steam metadata and
// no real workshop ids needed; the loader only requires packages under
// steamapps/workshop/content/<appid>/<numeric-id>/ with Info.json + WorkshopRootDir
// pointed there (an arbitrary Mods/Workshop dir does NOT work).
//
// The swap only rewrites the injection layer, so callers MUST stop the server
// first (same rule as installUe4ssZip). PalDefender (d3d9) is never touched.
const GAME_APPID = '1623730'
const modsRoot = () => join(gameDir(), 'Mods')
const palModSettingsFile = () => join(modsRoot(), 'PalModSettings.ini')
const workshopContentDir = () => join(gameDir(), 'steamapps', 'workshop', 'content', GAME_APPID)
const nativemodsDir = () => join(modsRoot(), 'NativeMods')
const managedModsDir = () => join(modsRoot(), 'ManagedMods')
const pmsPreswap = () => join(ue4ssBackupDir(), 'PalModSettings.preswap.ini')

// Reserved synthetic workshop ids for the built-in packages we synthesize from the
// on-disk stack. Real Workshop mods (Inc 3+) use their own numeric ids.
const UE4SS_SYNTH_ID = '9000000001'
const PALSCHEMA_SYNTH_ID = '9000000002'

const UE4SS_PACKAGE_INFO = {
  ModName: 'UE4SS Experimental (Palworld)',
  PackageName: 'UE4SSExperimentalPW',
  Version: 'experimental-palworld-6',
  DebugMode: false,
  MinRevision: 82182,
  Author: 'Oak',
  Dependencies: null,
  InstallRule: [
    { Type: 'UE4SS', Targets: ['.'] },
    { Type: 'UE4SS', IsServer: true, Targets: ['.'] },
  ],
}
const PALSCHEMA_PACKAGE_INFO = {
  ModName: 'PalSchema',
  PackageName: 'PalSchema',
  Version: '0.6.1',
  DebugMode: false,
  MinRevision: 82182,
  Author: 'Oak',
  Dependencies: ['UE4SSExperimentalPW'],
  InstallRule: [
    { Type: 'Lua', Targets: ['.'] },
    { Type: 'Lua', IsServer: true, Targets: ['.'] },
  ],
}

// /palworld/... -> Z:\palworld\... (wine drive Z: maps to /). PalModSettings and
// UE4SS read Windows paths under wine.
function toWinePath(p: string): string {
  return 'Z:' + p.replace(/\//g, '\\')
}

// Write PalModSettings.ini keeping every key we don't own byte-for-byte (the loader
// adds its own, e.g. future keys). We own exactly: bGlobalEnableMod, WorkshopRootDir,
// ConfigVersion, bNeedShowErrorOnNextStart, and the multi-valued ActiveModList set.
async function writePalModSettings(opts: {
  enable: boolean
  workshopRootDir: string
  activeMods: string[]
}): Promise<void> {
  let current = ''
  try {
    current = await readFile(palModSettingsFile(), 'utf8')
  } catch {
    /* first write */
  }
  const owned = new Set([
    'bglobalenablemod',
    'workshoprootdir',
    'configversion',
    'activemodlist',
    'bneedshowerroronnextstart',
  ])
  const preserved: string[] = []
  for (const raw of current.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('[')) continue
    const key = line.split('=')[0].trim().toLowerCase()
    if (owned.has(key)) continue
    preserved.push(raw)
  }
  const lines = [
    '[PalModSettings]',
    `bGlobalEnableMod=${opts.enable ? 'True' : 'False'}`,
    `WorkshopRootDir=${opts.workshopRootDir}`,
    'ConfigVersion=1.0',
    'bNeedShowErrorOnNextStart=False',
    ...preserved,
    ...opts.activeMods.map((m) => `ActiveModList=${m}`),
  ]
  await writeConfigFileWithBackup(palModSettingsFile(), lines.join('\n') + '\n')
}

// Read the managed PalModSettings values (for incremental Workshop-mod edits).
export async function readPalModSettings(): Promise<{
  enable: boolean
  workshopRootDir: string
  activeMods: string[]
}> {
  let content = ''
  try {
    content = await readFile(palModSettingsFile(), 'utf8')
  } catch {
    /* not created yet */
  }
  let enable = false
  let workshopRootDir = ''
  const activeMods: string[] = []
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('[')) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).trim().toLowerCase()
    const val = line.slice(eq + 1).trim()
    if (key === 'bglobalenablemod') enable = /^true$/i.test(val)
    else if (key === 'workshoprootdir') workshopRootDir = val
    else if (key === 'activemodlist' && val) activeMods.push(val)
  }
  return { enable, workshopRootDir, activeMods }
}

// Activate a Workshop package (idempotent): add it to ActiveModList, ensure the
// loader is on and WorkshopRootDir points at the content dir. Used after a Steam
// Workshop download so the loader deploys it on next boot.
export async function addWorkshopActiveMod(packageName: string): Promise<void> {
  const cur = await readPalModSettings()
  if (cur.activeMods.includes(packageName)) return
  await writePalModSettings({
    enable: true,
    workshopRootDir: cur.workshopRootDir || toWinePath(workshopContentDir()),
    activeMods: [...cur.activeMods, packageName],
  })
}

// Synthesize one workshop package: copy a source tree into
// content/<appid>/<numericId>/, drop excluded subpaths + any stale UE4SS.log, and
// write Info.json.
async function stageSynthPackage(
  numericId: string,
  srcDir: string,
  info: object,
  excludeRel: string[] = [],
): Promise<void> {
  const dest = join(workshopContentDir(), numericId)
  await rm(dest, { recursive: true, force: true })
  await mkdir(dest, { recursive: true })
  await cp(srcDir, dest, { recursive: true })
  for (const rel of excludeRel) await rm(join(dest, rel), { recursive: true, force: true })
  await rm(join(dest, 'UE4SS.log'), { force: true }).catch(() => {})
  await writeFile(join(dest, 'Info.json'), JSON.stringify(info, null, 2) + '\n', 'utf8')
}

// PROXY -> WORKSHOP. Backs up the proxy install (rollback anchor) + snapshots
// PalModSettings, synthesizes the UE4SS + PalSchema packages from the on-disk
// proxy stack, removes the dwmapi proxy, writes PalModSettings, records the regime.
// Returns the backup name (for a targeted rollback) + the migrated package names.
export async function swapToWorkshop(): Promise<{ backup: string; packages: string[] }> {
  // 1. Rollback anchor: tar the current proxy install + snapshot PalModSettings.
  const backup = await backupUe4ss()
  try {
    const cur = await readFile(palModSettingsFile(), 'utf8')
    await mkdir(ue4ssBackupDir(), { recursive: true })
    await writeFile(pmsPreswap(), cur, 'utf8')
  } catch {
    /* no PalModSettings yet — restore will leave the loader default */
  }

  const ue4ssRoot = ue4ssDir() // proxy layout: Win64/ue4ss
  const palSchemaSrc = join(ue4ssRoot, 'Mods', 'PalSchema')

  // 2. Fresh workshop staging + clear any prior loader outputs.
  await rm(workshopContentDir(), { recursive: true, force: true })
  await rm(nativemodsDir(), { recursive: true, force: true })
  await rm(managedModsDir(), { recursive: true, force: true })

  const packages: string[] = []
  // UE4SS package = the whole ue4ss tree (carries our Lua mods + mods.txt) minus
  // PalSchema, which ships as its own package.
  await stageSynthPackage(UE4SS_SYNTH_ID, ue4ssRoot, UE4SS_PACKAGE_INFO, ['Mods/PalSchema'])
  packages.push('UE4SSExperimentalPW')
  let hasPalSchema = false
  try {
    await stat(palSchemaSrc)
    hasPalSchema = true
  } catch {
    /* PalSchema not installed */
  }
  if (hasPalSchema) {
    await stageSynthPackage(PALSCHEMA_SYNTH_ID, palSchemaSrc, PALSCHEMA_PACKAGE_INFO)
    packages.push('PalSchema')
  }

  // 3. Remove the proxy injection layer (PalDefender's d3d9 stays untouched).
  await rm(dwmapiDll(), { force: true })
  await rm(DWMAPI_DISABLED, { force: true })
  await rm(ue4ssRoot, { recursive: true, force: true })

  // 4. Point the official loader at the staged packages + activate them.
  await writePalModSettings({
    enable: true,
    workshopRootDir: toWinePath(workshopContentDir()),
    activeMods: packages,
  })

  // 5. Record the active regime (resolver + UI read this).
  await recordRegime('workshop')
  return { backup, packages }
}

// WORKSHOP -> PROXY. Restores the proxy install from the pre-swap backup (exact
// byte-for-byte round-trip), removes every workshop artifact, restores the original
// PalModSettings, and records the regime. `backupFile` defaults to the newest
// ue4ss-*.tar.gz. This is the acceptance bar: the result boots as the original proxy.
export async function swapToProxy(backupFile?: string): Promise<void> {
  let backup = backupFile
  if (!backup) {
    const backups = await listUe4ssBackups()
    if (!backups.length) throw new Error('No UE4SS backup to restore the proxy regime from')
    backup = backups[0].file // newest first
  }

  // Clear any workshop-deployed UE4SS + proxy remnants, then extract the backup.
  await rm(ue4ssDir(), { recursive: true, force: true })
  await rm(dwmapiDll(), { force: true })
  await rm(DWMAPI_DISABLED, { force: true })
  await execFileP('tar', ['-xzf', join(ue4ssBackupDir(), backup), '-C', win64Dir()])

  // Remove workshop-regime artifacts (our staged packages + what the loader deployed).
  await rm(workshopContentDir(), { recursive: true, force: true })
  await rm(nativemodsDir(), { recursive: true, force: true })
  await rm(managedModsDir(), { recursive: true, force: true })

  // Restore the pre-swap PalModSettings (loader idle again).
  try {
    const orig = await readFile(pmsPreswap(), 'utf8')
    await writeConfigFileWithBackup(palModSettingsFile(), orig)
  } catch {
    /* no snapshot — leave whatever's there */
  }

  await recordRegime('proxy')
}

// ── Install a Steam Workshop package into the PROXY layout (Option B) ─────────
// Instead of the official loader, read the downloaded item's Info.json InstallRule
// and copy each server-applicable part into the community-proxy folders the running
// UE4SS/PalSchema already load from. No loader swap, no regime change.
//   Lua       -> Win64/ue4ss/Mods/<PackageName>/  (+ mods.txt)
//   PalSchema -> Win64/ue4ss/Mods/PalSchema/mods/<PackageName>/
//   Paks      -> Pal/Content/Paks/~mods/   | LogicMods -> Paks/LogicMods/
//   UE4SS     -> skipped (framework already installed)
const logicModsDir = () => join(gameDir(), 'Pal', 'Content', 'Paks', 'LogicMods')

async function walkFilesAbs(dir: string): Promise<string[]> {
  const out: string[] = []
  const rec = async (d: string) => {
    let ents
    try {
      ents = await readdir(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of ents) {
      const full = join(d, e.name)
      if (e.isDirectory()) await rec(full)
      else out.push(full)
    }
  }
  await rec(dir)
  return out
}

// Copy each Target (relative to src) into dest, preserving the target's subpath.
// Target "." / "" copies the whole package. Path-traversal guarded.
// Copy a Workshop item's InstallRule Targets into a proxy dest. Two placement modes,
// because the Workshop convention differs by mod type:
//   - Lua targets are `./Scripts`, `./enabled.txt` — the folder name IS the layout
//     (`ue4ss/Mods/<pkg>/Scripts/…`), so preserve it: `<src>/Scripts` → `<dest>/Scripts`.
//   - PalSchema targets are `./PalSchema/` — a WRAPPER whose CONTENTS map to
//     `PalSchema/mods/<pkg>/…` (like `AncientCoreDrops/raw/…`). Preserving the wrapper
//     lands the payload one level too deep (`<pkg>/PalSchema/blueprints/…`) and
//     PalSchema loads nothing — so `flatten` strips it: `<src>/PalSchema` → `<dest>`.
async function copyTargets(src: string, targets: string[], dest: string, flatten = false): Promise<void> {
  await mkdir(dest, { recursive: true })
  for (const raw of targets) {
    const t = raw.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
    if (t === '' || t === '.') {
      await cp(src, dest, { recursive: true })
    } else {
      const from = join(src, t)
      if (from !== src && !from.startsWith(src + sep)) continue
      await cp(from, flatten ? dest : join(dest, t), { recursive: true })
    }
  }
}

// Copy pak-family files found under the targets into a flat dir (~mods / LogicMods).
// Returns the .pak filenames copied (the ones that become pak rows; .utoc/.ucas are
// companions, copied but not listed).
async function copyPaksFlat(src: string, targets: string[], destDir: string): Promise<string[]> {
  await mkdir(destDir, { recursive: true })
  const paks: string[] = []
  const roots = targets
    .map((t) => t.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, ''))
    .map((t) => (t === '' || t === '.' ? src : join(src, t)))
  for (const root of roots) {
    if (root !== src && !root.startsWith(src + sep)) continue
    for (const f of await walkFilesAbs(root)) {
      if (/\.(pak|utoc|ucas)$/i.test(f)) {
        const name = basename(f)
        await cp(f, join(destDir, name))
        if (/\.pak$/i.test(name)) paks.push(name)
      }
    }
  }
  return paks
}

export type WorkshopProxyInstall = {
  packageName: string
  modName: string | null
  installed: { type: string; where: string }[]
  skipped: string[]
}

// Fallback for a Workshop item with NO Info.json manifest: place its files by STRUCTURE.
// Many Workshop mods ship Scripts/dlls/enabled.txt + paks at the root with no manifest.
// Mirrors the manifest path's placement — Lua/C++ → ue4ss/Mods/<pkg>, LogicMods paks →
// Paks/LogicMods, loose paks → ~mods, a PalSchema/ wrapper → PalSchema/mods/<pkg> — and
// records the Steam source link the same way.
async function installWorkshopByStructure(
  contentDir: string,
  itemId: string,
  nameHint?: string,
): Promise<WorkshopProxyInstall> {
  const linkName = nameHint?.trim() || null
  const cleaned = cleanModName(linkName || `workshop_${itemId}`)
  const pkg = isSafeModFolderName(cleaned) ? cleaned : `workshop_${itemId}`
  const proxy = await resolveRegimePaths('proxy')
  const entries = await readdir(contentDir, { withFileTypes: true })
  const isPak = (n: string) => /\.(pak|utoc|ucas)$/i.test(n)
  const META = new Set(['thumbnail.png', '.workshop.json', 'info.json'])
  const SUBDIRS = new Set(['logicmods', 'palschema'])
  const installed: { type: string; where: string }[] = []

  // 1. Lua/C++ mod folder: everything EXCEPT paks, the LogicMods/PalSchema subtrees, and meta.
  const codeEntries = entries.filter((e) => {
    const low = e.name.toLowerCase()
    if (e.isDirectory()) return !SUBDIRS.has(low)
    return !META.has(low) && !isPak(e.name)
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
  let luaInstalled = false
  if (hasLua) {
    const dest = join(proxy.ue4ssModsDir, pkg)
    await rm(dest, { recursive: true, force: true })
    await mkdir(dest, { recursive: true })
    for (const e of codeEntries) await cp(join(contentDir, e.name), join(dest, e.name), { recursive: true })
    const active = await readModsTxt(proxy.ue4ssModsDir)
    active.set(pkg, true)
    const modsTxt = join(proxy.ue4ssModsDir, 'mods.txt')
    const tmp = `${modsTxt}.tmp`
    await writeFile(tmp, serializeModsTxt(active), 'utf8')
    await rename(tmp, modsTxt)
    luaInstalled = true
    installed.push({ type: 'Lua', where: `ue4ss/Mods/${pkg}` })
  }

  // 2. LogicMods paks → Paks/LogicMods. 3. Loose root paks → ~mods.
  const hasLogic = entries.some((e) => e.isDirectory() && e.name.toLowerCase() === 'logicmods')
  const logicPaks = hasLogic ? await copyPaksFlat(contentDir, ['LogicMods'], logicModsDir()) : []
  if (logicPaks.length) installed.push({ type: 'LogicMods', where: `Paks/LogicMods (${logicPaks.length})` })
  const loosePaks: string[] = []
  for (const e of entries) {
    if (!e.isFile() || !isPak(e.name)) continue
    await mkdir(proxy.pakModsDir, { recursive: true })
    await cp(join(contentDir, e.name), join(proxy.pakModsDir, e.name))
    if (/\.pak$/i.test(e.name)) loosePaks.push(e.name)
  }
  if (loosePaks.length) installed.push({ type: 'Paks', where: `~mods (${loosePaks.length})` })

  // 4. PalSchema/ wrapper → PalSchema/mods/<pkg> (flatten strips the wrapper).
  let palSchemaInstalled = false
  if (entries.some((e) => e.isDirectory() && e.name.toLowerCase() === 'palschema')) {
    await copyTargets(contentDir, ['PalSchema'], join(proxy.palSchemaModsDir, pkg), true)
    palSchemaInstalled = true
    installed.push({ type: 'PalSchema', where: `PalSchema/mods/${pkg}` })
  }

  if (!installed.length) {
    throw new Error('This Workshop item has no Info.json and no recognizable UE4SS / pak / PalSchema files.')
  }

  const allPaks = [...logicPaks, ...loosePaks]
  if (luaInstalled) {
    await setSteamMod(`ue4ss:${pkg}`, { itemId, name: linkName })
    if (allPaks.length) await setModGroup(`ue4ss:${pkg}`, allPaks.map((p) => `pak:${p}`))
  } else if (allPaks.length) {
    for (const p of allPaks) await setSteamMod(`pak:${p}`, { itemId, name: linkName })
  } else if (palSchemaInstalled) {
    await setSteamMod(`palschema:${pkg}`, { itemId, name: linkName })
  }
  return { packageName: pkg, modName: linkName, installed, skipped: [] }
}

// Read a downloaded Workshop item's Info.json and place its server parts into the
// proxy layout. Prefers rules marked IsServer:true; if none, uses all rules
// best-effort (and the caller can warn it may be client-only).
export async function installWorkshopPackageToProxy(
  contentDir: string,
  itemId: string,
  nameHint?: string,
): Promise<WorkshopProxyInstall> {
  let info: { PackageName?: string; ModName?: string; InstallRule?: unknown }
  try {
    info = JSON.parse((await readFile(join(contentDir, 'Info.json'), 'utf8')).replace(/^\uFEFF/, ''))
  } catch {
    // No Info.json manifest — fall back to structure-based placement (bare-archive layout).
    return installWorkshopByStructure(contentDir, itemId, nameHint)
  }
  const packageName = typeof info.PackageName === 'string' ? info.PackageName.trim() : ''
  if (!packageName || !isSafeModFolderName(packageName)) {
    throw new Error('This Workshop item has no valid PackageName.')
  }
  // Robust guard (independent of item id): never overwrite a framework/reserved
  // folder in the proxy stack — UE4SS + PalSchema are managed by their own sections,
  // and 'shared' is UE4SS's runtime folder.
  const FRAMEWORK_PACKAGES = new Set(['ue4ssexperimentalpw', 'palschema', 'shared'])
  if (FRAMEWORK_PACKAGES.has(packageName.toLowerCase())) {
    throw new Error(
      `"${packageName}" is a framework component you already have — install it via the UE4SS Loader / PalSchema sections, not here. Blocked to avoid clobbering your setup.`,
    )
  }
  const rules = (Array.isArray(info.InstallRule) ? info.InstallRule : []) as {
    Type?: string
    Targets?: unknown
    IsServer?: boolean
  }[]
  const serverRules = rules.filter((r) => r?.IsServer === true)
  const useRules = serverRules.length ? serverRules : rules
  if (!useRules.length) throw new Error('This Workshop item has no InstallRule — cannot place its files.')

  const proxy = await resolveRegimePaths('proxy')
  // Merge Targets per Type (a mod may list a client + server rule with the same Type).
  const byType = new Map<string, Set<string>>()
  for (const r of useRules) {
    const type = String(r?.Type ?? '')
    const targets = Array.isArray(r?.Targets) && r.Targets.length ? (r.Targets as unknown[]).map(String) : ['.']
    if (!byType.has(type)) byType.set(type, new Set())
    for (const tg of targets) byType.get(type)!.add(tg)
  }

  const installed: { type: string; where: string }[] = []
  const skipped: string[] = []
  let luaInstalled = false
  let palSchemaInstalled = false
  const pakRowFiles: string[] = [] // ~mods .pak files, for hybrid nesting
  for (const [type, targetSet] of byType) {
    const targets = [...targetSet]
    if (type === 'UE4SS') {
      skipped.push('UE4SS (framework already installed)')
    } else if (type === 'Lua') {
      await copyTargets(contentDir, targets, join(proxy.ue4ssModsDir, packageName))
      const active = await readModsTxt(proxy.ue4ssModsDir)
      active.set(packageName, true)
      const modsTxt = join(proxy.ue4ssModsDir, 'mods.txt')
      const tmp = `${modsTxt}.tmp`
      await writeFile(tmp, serializeModsTxt(active), 'utf8')
      await rename(tmp, modsTxt)
      luaInstalled = true
      installed.push({ type, where: `ue4ss/Mods/${packageName}` })
    } else if (type === 'PalSchema') {
      // flatten: strip the `./PalSchema/` wrapper so the payload lands directly under
      // PalSchema/mods/<pkg>/ (else it's a level too deep and PalSchema loads nothing).
      await copyTargets(contentDir, targets, join(proxy.palSchemaModsDir, packageName), true)
      palSchemaInstalled = true
      installed.push({ type, where: `PalSchema/mods/${packageName}` })
    } else if (type === 'Paks') {
      pakRowFiles.push(...(await copyPaksFlat(contentDir, targets, proxy.pakModsDir)))
      installed.push({ type, where: '~mods' })
    } else if (type === 'LogicMods') {
      await copyPaksFlat(contentDir, targets, logicModsDir())
      installed.push({ type, where: 'Paks/LogicMods' })
    } else {
      skipped.push(`${type} (unsupported)`)
    }
  }
  if (!installed.length) {
    throw new Error(
      `Nothing server-installable in this item${skipped.length ? ` (skipped: ${skipped.join(', ')})` : ''}.`,
    )
  }
  // Hybrid nesting (matches the Nexus behavior): if this mod dropped both a UE4SS
  // mod and pak(s), nest the paks under the UE4SS row so they don't float as
  // standalone entries. Only when there's a UE4SS parent row to nest under.
  if (luaInstalled && pakRowFiles.length) {
    await setModGroup(
      `ue4ss:${packageName}`,
      pakRowFiles.map((p) => `pak:${p}`),
    )
  }

  // Record the Workshop source so the row shows a "Steam Workshop ↗" link (and not a
  // Nexus one). Link the UE4SS parent if present (its paks nest under it); otherwise
  // link each top-level pak row.
  const linkName = typeof info.ModName === 'string' ? info.ModName : packageName
  if (luaInstalled) {
    await setSteamMod(`ue4ss:${packageName}`, { itemId, name: linkName })
  } else if (pakRowFiles.length) {
    for (const p of pakRowFiles) await setSteamMod(`pak:${p}`, { itemId, name: linkName })
  } else if (palSchemaInstalled) {
    // A PalSchema-only Workshop mod (no Lua row, no pak row). Record the source so
    // the association isn't silently lost; keyed like a PalSchema submod.
    await setSteamMod(`palschema:${packageName}`, { itemId, name: linkName })
  }

  return { packageName, modName: typeof info.ModName === 'string' ? info.ModName : null, installed, skipped }
}
