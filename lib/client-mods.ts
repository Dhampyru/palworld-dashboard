import { readFile, writeFile, rename, mkdir, rm, cp, readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { detectModKind, cleanModName } from '@/lib/game-mods'
import { downloadNexusFile, getModFiles, getModInfo, parseNexusModId, type NexusFile } from '@/lib/nexus'
import { downloadWorkshopItem, parseWorkshopId } from '@/lib/steam'
import { normalizeArchiveToZip } from '@/lib/archive'

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

async function writeIndex(idx: Index): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true })
  const tmp = `${INDEX_FILE}.tmp`
  await writeFile(tmp, JSON.stringify(idx, null, 2) + '\n', 'utf8')
  await rename(tmp, INDEX_FILE)
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

export async function listClientMods(): Promise<ClientMod[]> {
  const idx = await readIndex()
  return Object.values(idx).sort((a, b) => a.name.localeCompare(b.name) || b.addedAt - a.addedAt)
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
  }
  idx[id] = rec
  await writeIndex(idx)
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
  }
  idx[id] = rec
  await writeIndex(idx)
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
  }
  idx[id] = rec
  await writeIndex(idx)
  return rec
}

export async function setClientModKeep(id: string, keep: boolean): Promise<ClientMod> {
  const idx = await readIndex()
  const rec = idx[id]
  if (!rec) throw new Error('No such client mod')
  rec.keep = keep
  await writeIndex(idx)
  return rec
}

export async function removeClientMod(id: string): Promise<void> {
  const idx = await readIndex()
  if (!idx[id]) return
  delete idx[id]
  await writeIndex(idx)
  await rm(join(STORE_DIR, id), { recursive: true, force: true })
}
