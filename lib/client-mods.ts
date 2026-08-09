import { readFile, writeFile, rename, mkdir, rm, cp, readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { detectModKind, cleanModName } from '@/lib/game-mods'
import { downloadNexusFile, getModFiles, getModInfo, parseNexusModId, type NexusFile } from '@/lib/nexus'
import { downloadWorkshopItem, parseWorkshopId } from '@/lib/steam'
import { normalizeArchiveToZip } from '@/lib/archive'
import AdmZip from 'adm-zip'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

// Client-mod store (docs/specs/client-mod-sync.md §2c, Phase 2 intake). Where an admin
// STAGES the mods a friend's client needs — WITHOUT installing them on the server. The
// server mod pipeline (installUe4ssModArchive / installPakArchive / installWorkshopPackage
// ToProxy) loads a mod into the running game; that's wrong for a client-only mod (some
// authors explicitly don't support servers). Here we only DOWNLOAD the payload and keep
// it, so the (later) loadout generator can pack it into a friend's Classic-UE4SS bundle.
//
// Layout (in the /app/data volume, alongside the other dashboard state):
//   data/client-mods.json          — the index (source of truth for the list)
//   data/client-mods/<id>/payload.zip   — a Nexus/uploaded archive (normalized to zip)
//   data/client-mods/<id>/payload.pak   — a bare uploaded .pak
//   data/client-mods/<id>/content/      — a Steam Workshop item's files (verbatim)
const DATA_DIR = resolve(process.env.DASHBOARD_DATA_DIR ?? './data')
const STORE_DIR = join(DATA_DIR, 'client-mods')
const INDEX_FILE = join(DATA_DIR, 'client-mods.json')

export type ClientModSource = 'nexus' | 'steam' | 'upload'
export type ClientModKind = 'ue4ss' | 'pak' | 'palschema' | 'unknown'

export type ClientMod = {
  id: string // slug, unique; also the store subdir name
  name: string
  source: ClientModSource
  sourceId: string | null // Nexus modId or Steam Workshop itemId
  url: string | null
  kind: ClientModKind
  version: string | null
  payload: string // basename under the mod dir: 'payload.zip' | 'payload.pak' | 'content'
  sizeBytes: number
  keep: boolean // include this mod in the generated friend loadout
  addedAt: number
  warn?: string | null // set when the mod has NO client-installable files (server-side / not a mod)
  configMenu?: boolean // detected: ships an in-game Mod Config Menu → writes a client-side
  // LogicMods/<name>.modconfig.json the admin can capture + pre-configure (client-configs editor)
}

type Index = Record<string, ClientMod>

async function readIndex(): Promise<Index> {
  try {
    const j = JSON.parse(await readFile(INDEX_FILE, 'utf8')) as Index
    return j && typeof j === 'object' ? j : {}
  } catch {
    return {}
  }
}

let writeSeq = 0
async function writeIndex(idx: Index): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true })
  // Unique temp per write so two concurrent writers never share/clobber the same .tmp.
  const tmp = `${INDEX_FILE}.${process.pid}.${++writeSeq}.tmp`
  await writeFile(tmp, JSON.stringify(idx, null, 2) + '\n', 'utf8')
  await rename(tmp, INDEX_FILE)
}

// Serialize index read-modify-write. Every mutation reads the CURRENT index, applies its
// change, and writes — all under one in-process chain — so concurrent callers (e.g. rapid
// keep-toggles or an add landing mid-toggle) can't clobber each other via last-write-wins,
// which showed up as the loadout "lagging behind" the selection. Heavy work (downloads)
// must stay OUTSIDE this — only the read→mutate→write belongs here.
let indexChain: Promise<unknown> = Promise.resolve()
function mutateIndex<T>(fn: (idx: Index) => T | Promise<T>): Promise<T> {
  const run = indexChain.then(async () => {
    const idx = await readIndex()
    const result = await fn(idx)
    await writeIndex(idx)
    return result
  })
  indexChain = run.then(
    () => {},
    () => {},
  ) // keep the chain alive regardless of this op's outcome
  return run
}

// Bytes on disk under a path (recursive). Best-effort — an unreadable entry counts 0.
async function pathSize(path: string): Promise<number> {
  let total = 0
  let entries: string[]
  try {
    const st = await stat(path)
    if (!st.isDirectory()) return st.size
    entries = await readdir(path)
  } catch {
    return 0
  }
  for (const e of entries) total += await pathSize(join(path, e))
  return total
}

function slugify(name: string): string {
  const base = name.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase()
  return base || 'mod'
}

// A store id unique against the current index (slug, then slug-2, slug-3, …).
function uniqueId(idx: Index, base: string): string {
  const slug = slugify(base)
  if (!idx[slug]) return slug
  for (let i = 2; ; i++) {
    const cand = `${slug}-${i}`
    if (!idx[cand]) return cand
  }
}

// Newest MAIN file (fall back to newest of any downloadable file). Client staging just
// needs THE file; it doesn't need the server route's stricter one-MAIN-or-bail rule.
function pickFile(files: NexusFile[]): NexusFile | null {
  if (!files.length) return null
  const main = files.filter((f) => (f.category ?? '').toUpperCase() === 'MAIN')
  const pool = main.length ? main : files
  return pool[pool.length - 1]
}

// ── Client-placement classification (add-time warning) ───────────────────────
// Determine whether a staged mod actually has files a friend's CLIENT installs. Returns a
// warning string when it does NOT (so the panel can flag a mis-categorized add on the
// spot), or null when it's client-installable. Mirrors the loadout generator's placement:
// client = Lua + pak + LogicMods; PalSchema/UE4SS = server-side.
const SERVER_SIDE_WARN =
  'PalSchema/server-side mod — it runs on the server, not the client, so there are no client files and it won’t ship in the loadout.'
const FOMOD_WARN =
  'FOMOD installer — it has multiple variant options; pick one and stage it manually (it can’t be auto-shipped in a client loadout).'

// Classify from a list of archive entry names (shared by the buffer + on-disk paths).
// Exported so lib/mod-targeting.ts can reuse the SAME client-installability rule (a null
// return = the mod has files a friend's client installs).
export function classifyNames(names: string[], kind: ClientModKind): string | null {
  // FOMOD (variant installer) wins over the kind short-circuit — it needs a manual choice.
  if (names.some((n) => /(^|\/)fomod\/moduleconfig\.xml$/i.test(n))) return FOMOD_WARN
  if (kind === 'ue4ss' || kind === 'pak') return null // Lua or a pak → client-installable
  if (names.some((n) => /\.(pak|utoc|ucas)$/i.test(n))) return null // a pak (even alongside PalSchema) → client gets it
  if (
    names.some((n) => {
      const l = n.toLowerCase()
      return l.includes('/scripts/') || l.startsWith('scripts/') || l.endsWith('.lua') || l.endsWith('/main.dll')
    })
  )
    return null // Lua mod
  if (names.some((n) => /(^|\/)palschema\/mods\/.+\.jsonc?$/i.test(n))) return SERVER_SIDE_WARN
  if (names.length > 0 && names.every((n) => /engine\.ini|\.txt$/i.test(n)))
    return 'Engine.ini text tweak — not an installable mod; apply to Engine.ini manually.'
  return 'No client-installable files detected (no pak / Lua) — it won’t ship in the loadout.'
}

function warnFromZip(buffer: Buffer, kind: ClientModKind): string | null {
  if (kind === 'ue4ss' || kind === 'pak') return null
  try {
    return classifyNames(
      new AdmZip(buffer).getEntries().filter((e) => !e.isDirectory).map((e) => e.entryName.replace(/\\/g, '/')),
      kind,
    )
  } catch {
    return 'Not a readable archive — nothing to ship to clients.'
  }
}

// Disk variant for BACKFILL: list entries with `lsar` (streaming, no big Node buffer) so a
// 500MB payload never loads into memory.
async function warnFromZipPath(zipPath: string, kind: ClientModKind): Promise<string | null> {
  if (kind === 'ue4ss' || kind === 'pak') return null
  try {
    const { stdout } = await execFileP('lsar', [zipPath], { maxBuffer: 32 * 1024 * 1024 })
    const names = stdout.split('\n').slice(1).map((s) => s.trim().replace(/\\/g, '/')).filter(Boolean)
    return classifyNames(names, kind)
  } catch {
    return 'Not a readable archive — nothing to ship to clients.'
  }
}

async function warnFromContent(contentDir: string): Promise<string | null> {
  try {
    const info = JSON.parse(await readFile(join(contentDir, 'Info.json'), 'utf8')) as { InstallRule?: { Type?: string }[] }
    const types = (Array.isArray(info.InstallRule) ? info.InstallRule : []).map((r) => String(r?.Type ?? ''))
    if (types.some((t) => t === 'Lua' || t === 'Paks' || t === 'LogicMods')) return null
    if (types.some((t) => t === 'PalSchema' || t === 'UE4SS')) return SERVER_SIDE_WARN
    return 'No client-installable files in this Workshop item — it won’t ship in the loadout.'
  } catch {
    return 'No Info.json — can’t confirm client files; it may not ship in the loadout.'
  }
}

// ---- Mod Config Menu detection --------------------------------------------------------
// Mods that expose an in-game settings menu (DekModConfigMenu / a JsonSettingsLibrary) write
// their config to Pal/Content/Paks/LogicMods/<name>.modconfig.json ON THE CLIENT at runtime.
// We can't grab that file (it doesn't exist until the mod runs), but we CAN detect that a mod
// produces one — by a signature in its pak — so the UI can prompt the admin to capture +
// pre-configure it (client-configs editor). Match ASCII and UTF-16LE (UE stores FStrings wide).
const CONFIG_SIG_BUFS = ['JsonSettingsLibrary', 'ModConfigMenu', 'DekModConfig', 'modconfig'].flatMap((s) => [
  Buffer.from(s, 'latin1'),
  Buffer.from(s, 'utf16le'),
])
const CONFIG_SIG_CAP = 40 * 1024 * 1024 // skip huge texture paks — config mods ship small code paks

function bufHasConfigSig(buf: Buffer): boolean {
  return CONFIG_SIG_BUFS.some((needle) => buf.indexOf(needle) !== -1)
}

// Scan a zip payload's pak entries in memory (small entries only).
// Exported so lib/mod-targeting.ts can surface the in-game Config Menu signal at scan time.
export function zipUsesModConfig(buffer: Buffer): boolean {
  try {
    for (const e of new AdmZip(buffer).getEntries()) {
      if (e.isDirectory || !/\.pak$/i.test(e.entryName) || e.header.size > CONFIG_SIG_CAP) continue
      if (bufHasConfigSig(e.getData())) return true
    }
  } catch {
    /* unreadable → no detection */
  }
  return false
}

// Scan a Steam content dir's paks on disk (small files only).
async function contentUsesModConfig(dir: string): Promise<boolean> {
  const walk = async (d: string): Promise<string[]> => {
    let ents: import('node:fs').Dirent[]
    try {
      ents = await readdir(d, { withFileTypes: true })
    } catch {
      return []
    }
    const out: string[] = []
    for (const e of ents) {
      const p = join(d, e.name)
      if (e.isDirectory()) out.push(...(await walk(p)))
      else if (/\.pak$/i.test(e.name)) out.push(p)
    }
    return out
  }
  for (const p of await walk(dir)) {
    try {
      if ((await stat(p)).size > CONFIG_SIG_CAP) continue
      if (bufHasConfigSig(await readFile(p))) return true
    } catch {
      /* skip */
    }
  }
  return false
}

export async function listClientMods(): Promise<ClientMod[]> {
  const idx = await readIndex()
  return Object.values(idx).sort((a, b) => a.name.localeCompare(b.name) || b.addedAt - a.addedAt)
}

// Absolute path to a staged mod's on-disk directory (holds payload.zip / payload.pak /
// content/). For the loadout generator, which reads payloads to assemble a client bundle.
export function clientModStorePath(id: string): string {
  return join(STORE_DIR, id)
}

// Stage a Nexus mod for clients. Premium-gated (downloadNexusFile throws otherwise);
// the route surfaces that. Downloads the newest MAIN file, normalizes it to a zip, and
// records the detected kind — but never touches the server's mod dirs.
export async function addClientModFromNexus(url: string): Promise<ClientMod> {
  const modId = parseNexusModId(url)
  if (!modId) throw new Error('Paste a valid Nexus mod URL or id')
  const [info, files] = await Promise.all([getModInfo(modId), getModFiles(modId)])
  const file = pickFile(files)
  if (!file) throw new Error('No downloadable file found on Nexus (Premium key required for auto-download)')
  const raw = await downloadNexusFile(modId, file.fileId)
  let buffer: Buffer
  try {
    buffer = await normalizeArchiveToZip(raw)
  } catch {
    throw new Error("Couldn't open this download as an archive (corrupt, encrypted, or unsupported)")
  }
  const kind: ClientModKind = detectModKind(buffer) || 'unknown'
  const name = cleanModName(info?.name ?? `Nexus mod ${modId}`)

  const idx = await readIndex()
  const id = uniqueId(idx, name)
  const dir = join(STORE_DIR, id)
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'payload.zip'), buffer)

  const rec: ClientMod = {
    id,
    name,
    source: 'nexus',
    sourceId: String(modId),
    url: info?.url ?? `https://www.nexusmods.com/palworld/mods/${modId}`,
    kind,
    version: file.version ?? null,
    payload: 'payload.zip',
    sizeBytes: buffer.length,
    keep: true,
    addedAt: Date.now(),
    warn: warnFromZip(buffer, kind),
    configMenu: zipUsesModConfig(buffer),
  }
  // Commit through the mutex so this insert can't clobber a keep-toggle that lands during
  // the download above (re-reads the current index, adds only this record).
  await mutateIndex((cur) => {
    cur[id] = rec
  })
  return rec
}

// Stage a Steam Workshop item for clients. downloadWorkshopItem pulls it into SteamCMD's
// content cache (NOT the server proxy layout — that's installWorkshopPackageToProxy, which
// we deliberately do NOT call). We copy the item's files into our store verbatim; the
// loadout generator will place them (reusing the Workshop InstallRule logic) later.
export async function addClientModFromSteam(url: string): Promise<ClientMod> {
  const itemId = parseWorkshopId(url)
  if (!itemId) throw new Error('Paste a valid Steam Workshop URL or id')
  const { contentDir, packageName, modName } = await downloadWorkshopItem(itemId)
  const name = cleanModName(modName || packageName || `Workshop item ${itemId}`)

  const idx = await readIndex()
  const id = uniqueId(idx, name)
  const dir = join(STORE_DIR, id)
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  const dest = join(dir, 'content')
  await cp(contentDir, dest, { recursive: true })

  const rec: ClientMod = {
    id,
    name,
    source: 'steam',
    sourceId: itemId,
    url: `https://steamcommunity.com/sharedfiles/filedetails/?id=${itemId}`,
    kind: 'unknown', // Workshop kind is resolved from Info.json InstallRule at loadout time
    version: null, // Workshop exposes a timestamp, not a version
    payload: 'content',
    sizeBytes: await pathSize(dest),
    keep: true,
    addedAt: Date.now(),
    warn: await warnFromContent(dest),
    configMenu: await contentUsesModConfig(dest),
  }
  // Commit through the mutex so this insert can't clobber a keep-toggle that lands during
  // the download above (re-reads the current index, adds only this record).
  await mutateIndex((cur) => {
    cur[id] = rec
  })
  return rec
}

// Stage a manually-uploaded mod. A bare .pak is kept as-is; any other archive
// (.zip/.rar/.7z) is normalized to a zip so the detector and the loadout generator stay
// zip-only. nameHint names the store entry (defaults to the uploaded file's base name).
export async function addClientModUpload(fileName: string, buffer: Buffer): Promise<ClientMod> {
  const isPak = /\.pak$/i.test(fileName)
  let payloadName: string
  let stored: Buffer
  let kind: ClientModKind
  if (isPak) {
    payloadName = 'payload.pak'
    stored = buffer
    kind = 'pak'
  } else {
    payloadName = 'payload.zip'
    try {
      stored = await normalizeArchiveToZip(buffer)
    } catch {
      throw new Error("Couldn't open this file as a .zip/.rar/.7z archive (or upload a bare .pak)")
    }
    kind = detectModKind(stored) || 'unknown'
  }
  const name = cleanModName(fileName.replace(/\.(zip|rar|7z|pak)$/i, '')) || 'Uploaded mod'

  const idx = await readIndex()
  const id = uniqueId(idx, name)
  const dir = join(STORE_DIR, id)
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, payloadName), stored)

  const rec: ClientMod = {
    id,
    name,
    source: 'upload',
    sourceId: null,
    url: null,
    kind,
    version: null,
    payload: payloadName,
    sizeBytes: stored.length,
    keep: true,
    addedAt: Date.now(),
    warn: isPak ? null : warnFromZip(stored, kind),
    configMenu: isPak ? bufHasConfigSig(stored) : zipUsesModConfig(stored),
  }
  // Commit through the mutex so this insert can't clobber a keep-toggle that lands during
  // the download above (re-reads the current index, adds only this record).
  await mutateIndex((cur) => {
    cur[id] = rec
  })
  return rec
}

// Detect a URL's source by host. A bare id is ambiguous between Nexus and Steam, so bulk
// requires real URLs (the single-add box handles a bare id via an explicit source).
export function detectSource(input: string): 'nexus' | 'steam' | null {
  const s = input.trim()
  if (/nexusmods\.com/i.test(s)) return 'nexus'
  if (/steamcommunity\.com|[?&]id=/i.test(s)) return 'steam'
  return null
}

export type BulkResult = { input: string; ok: boolean; name?: string; kind?: string; warn?: string | null; error?: string }

// Stage many mods from pasted Nexus/Steam URLs. Sequential — each is a CDN download +
// disk write mutating the shared store; serial avoids races and is gentle on the Nexus
// rate limit. One bad URL never aborts the rest.
export async function addClientModsBulk(inputs: string[]): Promise<BulkResult[]> {
  const clean = inputs.map((u) => u.trim()).filter(Boolean)
  const results: BulkResult[] = []
  for (const input of clean.slice(0, 50)) {
    const src = detectSource(input)
    if (!src) {
      results.push({ input, ok: false, error: 'Not a recognized Nexus or Steam Workshop URL' })
      continue
    }
    try {
      const mod = src === 'nexus' ? await addClientModFromNexus(input) : await addClientModFromSteam(input)
      results.push({ input, ok: true, name: mod.name, kind: mod.kind, warn: mod.warn })
    } catch (e) {
      results.push({ input, ok: false, error: e instanceof Error ? e.message : 'Failed' })
    }
  }
  return results
}

export async function setClientModKeep(id: string, keep: boolean): Promise<ClientMod> {
  return mutateIndex((idx) => {
    const rec = idx[id]
    if (!rec) throw new Error('No such client mod')
    rec.keep = keep
    return rec
  })
}

export async function removeClientMod(id: string): Promise<void> {
  const existed = await mutateIndex((idx) => {
    if (!idx[id]) return false
    delete idx[id]
    return true
  })
  if (existed) await rm(join(STORE_DIR, id), { recursive: true, force: true })
}

// Remove every staged client mod that came from a given source id (Nexus modId / Steam
// itemId) — cascades a server-side delete to the paired client stage. Returns removed names.
export async function removeClientModsBySource(source: 'nexus' | 'steam', sourceId: string): Promise<string[]> {
  const idx = await readIndex()
  const victims = Object.values(idx).filter((m) => m.source === source && m.sourceId === sourceId)
  for (const m of victims) await removeClientMod(m.id)
  return victims.map((m) => m.name)
}

// Recompute `configMenu` from a stored payload on disk (size-capped so a big payload never
// bloats memory). Used by add (in-memory variants) and backfill.
async function detectConfigMenuOnDisk(dir: string, payload: string): Promise<boolean> {
  try {
    if (payload === 'content') return await contentUsesModConfig(join(dir, 'content'))
    const p = join(dir, payload)
    if ((await stat(p)).size > CONFIG_SIG_CAP) return false
    const buf = await readFile(p)
    return payload === 'payload.pak' ? bufHasConfigSig(buf) : zipUsesModConfig(buf)
  } catch {
    return false
  }
}

// Recompute `warn` + `configMenu` for every staged mod (for entries added before those
// existed). `warn` uses disk-safe listing (lsar / Info.json); `configMenu` reads small paks.
export async function backfillClientWarnings(): Promise<{ updated: number; flagged: { name: string; warn: string }[] }> {
  // Compute the slow disk scans OUTSIDE the index mutex so a keep-toggle isn't blocked while
  // this runs; apply the results under the mutex (re-reads, touches only still-present mods).
  const snapshot = await readIndex()
  const computed = new Map<string, { warn: string | null; configMenu: boolean }>()
  const flagged: { name: string; warn: string }[] = []
  for (const [id, m] of Object.entries(snapshot)) {
    const dir = join(STORE_DIR, id)
    let warn: string | null
    if (m.payload === 'content') warn = await warnFromContent(join(dir, 'content'))
    else if (m.payload === 'payload.pak') warn = null
    else warn = await warnFromZipPath(join(dir, 'payload.zip'), m.kind)
    const configMenu = await detectConfigMenuOnDisk(dir, m.payload)
    computed.set(id, { warn, configMenu })
    if (warn) flagged.push({ name: m.name, warn })
  }
  const updated = await mutateIndex((idx) => {
    let n = 0
    for (const [id, c] of computed) {
      const m = idx[id]
      if (!m) continue // removed while we were scanning
      if ((m.warn ?? null) !== c.warn || (m.configMenu ?? false) !== c.configMenu) {
        m.warn = c.warn
        m.configMenu = c.configMenu
        n++
      }
    }
    return n
  })
  return { updated, flagged }
}
