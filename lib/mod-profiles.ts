import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  readServerModStates,
  readSteamMods,
  setServerModEnabled,
  type ServerModState,
} from '@/lib/game-mods'
import { readNexusAssocIds } from '@/lib/nexus'
import { listClientMods, setClientModKeep, type ClientMod } from '@/lib/client-mods'
import { isFrameworkDefault } from '@/lib/ue4ss-framework-defaults'

// PATCH (not upstream): unified mod profiles — a named snapshot of the enable/disable
// state of BOTH the server's mods AND the client friend-loadout selection, so an admin
// can save "this exact working set" and return to it later. It also powers a DRIFT check:
// for a mod present on both sides, flag when the server has it enabled but the client
// loadout doesn't (or vice versa) — the thing that kept silently diverging.
//
// A profile records STATE ONLY (on/off + keep), never mod files — the files stay on disk
// in their own stores; restore just re-applies toggles. Restore is effective on the next
// server restart (server side) / next bundle generation (client side), like any toggle.
//
// Stored in the /app/data volume alongside the other dashboard state, so the daily
// dashboard-data auto-backup already captures it.
const DATA_DIR = resolve(process.env.DASHBOARD_DATA_DIR ?? './data')
const PROFILES_FILE = join(DATA_DIR, 'mod-profiles.json')

// A single mod's snapshot on one side. `enabled` means "enabled" for a server entry and
// "keep" (included in the loadout) for a client entry. `source`/`sourceId` are stored so a
// restore can re-match a mod even if its folder name / client slug changed since the snapshot.
export type ProfileEntry = {
  id: string // server: `ue4ss:<folder>` / `pak:<file>` / `paldefender:*`; client: the client store slug
  name: string
  kind?: string
  source: string | null // 'nexus' | 'steam' | 'upload' | null
  sourceId: string | null
  enabled: boolean
}

export type ModProfile = {
  id: string // slug, unique
  name: string
  createdAt: number
  note?: string
  server: ProfileEntry[]
  client: ProfileEntry[]
}

type Store = Record<string, ModProfile>

const normName = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
// A server pak's display name carries the `.pak` suffix; strip it before name-matching a
// client mod (whose name never does), so "Foo.pak" ↔ "Foo" lines up.
const serverNormName = (s: string) => normName(s.replace(/\.pak$/i, ''))

// ── store I/O ────────────────────────────────────────────────────────────────
async function readStore(): Promise<Store> {
  try {
    const j = JSON.parse(await readFile(PROFILES_FILE, 'utf8')) as Store
    return j && typeof j === 'object' ? j : {}
  } catch {
    return {}
  }
}

let writeSeq = 0
async function writeStore(store: Store): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true })
  const tmp = `${PROFILES_FILE}.${process.pid}.${++writeSeq}.tmp`
  await writeFile(tmp, JSON.stringify(store, null, 2) + '\n', 'utf8')
  await rename(tmp, PROFILES_FILE)
}

// Serialize read-modify-write so concurrent save/rename/delete can't clobber each other.
let chain: Promise<unknown> = Promise.resolve()
function mutate<T>(fn: (store: Store) => T | Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const store = await readStore()
    const result = await fn(store)
    await writeStore(store)
    return result
  })
  chain = run.then(() => {}, () => {})
  return run
}

function slugify(name: string): string {
  const base = name.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase()
  return base || 'profile'
}
function uniqueId(store: Store, base: string): string {
  const slug = slugify(base)
  if (!store[slug]) return slug
  for (let i = 2; ; i++) {
    const cand = `${slug}-${i}`
    if (!store[cand]) return cand
  }
}

// ── snapshotting current state ───────────────────────────────────────────────
// Enrich a server mod with its source link (Nexus modId / Steam itemId) so restore can
// re-match it later even if the folder was renamed.
function toServerEntry(s: ServerModState, nexusIds: Record<string, number>, steam: Record<string, { itemId: string }>): ProfileEntry {
  let source: string | null = null
  let sourceId: string | null = null
  if (nexusIds[s.id] != null) {
    source = 'nexus'
    sourceId = String(nexusIds[s.id])
  } else if (steam[s.id]?.itemId) {
    source = 'steam'
    sourceId = steam[s.id].itemId
  }
  return { id: s.id, name: s.name, kind: s.kind, source, sourceId, enabled: s.enabled }
}

async function snapshotServer(): Promise<ProfileEntry[]> {
  const [states, nexusIds, steam] = await Promise.all([readServerModStates(), readNexusAssocIds(), readSteamMods()])
  return states.map((s) => toServerEntry(s, nexusIds, steam))
}

function toClientEntry(m: ClientMod): ProfileEntry {
  return { id: m.id, name: m.name, kind: m.kind, source: m.source, sourceId: m.sourceId, enabled: m.keep }
}
async function snapshotClient(): Promise<ProfileEntry[]> {
  return (await listClientMods()).map(toClientEntry)
}

// ── public API ───────────────────────────────────────────────────────────────
export async function listProfiles(): Promise<ModProfile[]> {
  const store = await readStore()
  return Object.values(store).sort((a, b) => b.createdAt - a.createdAt)
}

export type ProfileMissing = { server: ProfileEntry[]; client: ProfileEntry[] }
export type ModProfileWithStatus = ModProfile & { missing: ProfileMissing }

// Profiles annotated with which captured mods are NO LONGER installed (can't be resolved to a
// current server/client mod, via the same exact-id → source-link → normalized-name matching a
// restore uses). Lets the UI flag a stale profile up front instead of only at restore time.
export async function listProfilesWithStatus(): Promise<ModProfileWithStatus[]> {
  const [profiles, states, nexusIds, steam, clientMods] = await Promise.all([
    listProfiles(),
    readServerModStates(),
    readNexusAssocIds(),
    readSteamMods(),
    listClientMods(),
  ])
  return profiles.map((p) => ({
    ...p,
    missing: {
      server: p.server.filter((e) => resolveServerId(e, states, nexusIds, steam) === null),
      client: p.client.filter((e) => resolveClientId(e, clientMods) === null),
    },
  }))
}

export async function saveProfile(name: string, note?: string): Promise<ModProfile> {
  const trimmed = (name || '').trim()
  if (!trimmed) throw new Error('Name a profile before saving')
  const [server, client] = await Promise.all([snapshotServer(), snapshotClient()])
  return mutate((store) => {
    const id = uniqueId(store, trimmed)
    const profile: ModProfile = {
      id,
      name: trimmed,
      createdAt: Date.now(),
      note: note?.trim() || undefined,
      server,
      client,
    }
    store[id] = profile
    return profile
  })
}

export async function renameProfile(id: string, name: string): Promise<ModProfile> {
  const trimmed = (name || '').trim()
  if (!trimmed) throw new Error('Name cannot be empty')
  return mutate((store) => {
    const p = store[id]
    if (!p) throw new Error('No such profile')
    p.name = trimmed
    return p
  })
}

export async function deleteProfile(id: string): Promise<void> {
  await mutate((store) => {
    if (!store[id]) throw new Error('No such profile')
    delete store[id]
  })
}

export type RestoreReport = {
  server: { applied: number; missing: ProfileEntry[] }
  client: { applied: number; missing: ProfileEntry[] }
  // Installed now but NOT in the profile — left untouched (informational).
  extras: { server: { id: string; name: string }[]; client: { id: string; name: string }[] }
}

// Resolve a profile entry to a currently-installed server mod id (exact id → source link →
// normalized name), so a restore survives a folder rename since the snapshot.
function resolveServerId(
  entry: ProfileEntry,
  states: ServerModState[],
  nexusIds: Record<string, number>,
  steam: Record<string, { itemId: string }>,
): string | null {
  if (states.some((s) => s.id === entry.id)) return entry.id
  if (entry.source === 'nexus' && entry.sourceId) {
    const hit = states.find((s) => nexusIds[s.id] != null && String(nexusIds[s.id]) === entry.sourceId)
    if (hit) return hit.id
  }
  if (entry.source === 'steam' && entry.sourceId) {
    const hit = states.find((s) => steam[s.id]?.itemId === entry.sourceId)
    if (hit) return hit.id
  }
  const hit = states.find((s) => serverNormName(s.name) === normName(entry.name))
  return hit ? hit.id : null
}

function resolveClientId(entry: ProfileEntry, mods: ClientMod[]): string | null {
  if (mods.some((m) => m.id === entry.id)) return entry.id
  if (entry.source && entry.sourceId) {
    const hit = mods.find((m) => m.source === entry.source && m.sourceId === entry.sourceId)
    if (hit) return hit.id
  }
  const hit = mods.find((m) => normName(m.name) === normName(entry.name))
  return hit ? hit.id : null
}

// Re-apply a profile's on/off state to whatever is installed NOW. State only — never
// installs/removes a mod. Reports entries that no longer exist and mods present now that the
// profile didn't cover (left as they are).
export async function restoreProfile(id: string): Promise<RestoreReport> {
  const store = await readStore()
  const profile = store[id]
  if (!profile) throw new Error('No such profile')

  const [states, nexusIds, steam, clientMods] = await Promise.all([
    readServerModStates(),
    readNexusAssocIds(),
    readSteamMods(),
    listClientMods(),
  ])

  const report: RestoreReport = {
    server: { applied: 0, missing: [] },
    client: { applied: 0, missing: [] },
    extras: { server: [], client: [] },
  }
  const touchedServer = new Set<string>()
  const touchedClient = new Set<string>()

  for (const entry of profile.server) {
    const target = resolveServerId(entry, states, nexusIds, steam)
    if (!target) {
      report.server.missing.push(entry)
      continue
    }
    const ok = await setServerModEnabled(target, entry.enabled).catch(() => false)
    if (ok) {
      report.server.applied++
      touchedServer.add(target)
    } else {
      report.server.missing.push(entry)
    }
  }

  for (const entry of profile.client) {
    const target = resolveClientId(entry, clientMods)
    if (!target) {
      report.client.missing.push(entry)
      continue
    }
    await setClientModKeep(target, entry.enabled).catch(() => {})
    report.client.applied++
    touchedClient.add(target)
  }

  for (const s of states) if (!touchedServer.has(s.id)) report.extras.server.push({ id: s.id, name: s.name })
  for (const m of clientMods) if (!touchedClient.has(m.id)) report.extras.client.push({ id: m.id, name: m.name })

  return report
}

// ── bulk enable / disable ────────────────────────────────────────────────────
export type BulkResult = { server: number; client: number; skippedBuiltins: number }

// Flip EVERY content mod on both sides to `enabled`. Framework built-ins (PalDefender +
// the UE4SS loader components — BPModLoaderMod etc.) are deliberately LEFT ALONE: they're
// load-bearing plumbing, so a "disable all" for isolation testing shouldn't kill the loader
// or drop PalDefender's protections. Client mods have no built-in concept — all are flipped.
// Server changes take effect next restart; client on the next bundle. Idempotent per mod
// (setServerModEnabled/setClientModKeep no-op when already in the target state).
export async function bulkSetAll(enabled: boolean): Promise<BulkResult> {
  const [states, clientMods] = await Promise.all([readServerModStates(), listClientMods()])
  let server = 0
  let skippedBuiltins = 0
  for (const s of states) {
    if (isFrameworkDefault(s.kind, s.name)) {
      skippedBuiltins++
      continue
    }
    const ok = await setServerModEnabled(s.id, enabled).catch(() => false)
    if (ok) server++
  }
  let client = 0
  for (const m of clientMods) {
    await setClientModKeep(m.id, enabled).catch(() => {})
    client++
  }
  return { server, client, skippedBuiltins }
}

// ── drift detection ──────────────────────────────────────────────────────────
export type DriftEntry = {
  serverId: string
  serverName: string
  serverEnabled: boolean
  clientId: string
  clientName: string
  clientKeep: boolean
  matchBy: 'nexus' | 'steam' | 'name'
}

// Find the client mod that is the SAME mod as a given server mod, via (in order) shared
// Nexus modId, shared Steam itemId, else normalized display name. Returns null if the mod
// exists only on the server side (server-only mods can't drift).
function matchClient(
  s: ServerModState,
  nexusIds: Record<string, number>,
  steam: Record<string, { itemId: string }>,
  clientMods: ClientMod[],
): { mod: ClientMod; by: DriftEntry['matchBy'] } | null {
  const modId = nexusIds[s.id]
  if (modId != null) {
    const hit = clientMods.find((m) => m.source === 'nexus' && m.sourceId === String(modId))
    if (hit) return { mod: hit, by: 'nexus' }
  }
  const itemId = steam[s.id]?.itemId
  if (itemId) {
    const hit = clientMods.find((m) => m.source === 'steam' && m.sourceId === itemId)
    if (hit) return { mod: hit, by: 'steam' }
  }
  const key = serverNormName(s.name)
  if (key) {
    const hit = clientMods.find((m) => normName(m.name) === key)
    if (hit) return { mod: hit, by: 'name' }
  }
  return null
}

// Mods present on BOTH sides whose enabled (server) ≠ keep (client) — the loadout drifting
// from the running server. Only genuine both-side mismatches; server-only / client-only
// mods never appear.
export async function computeDrift(): Promise<DriftEntry[]> {
  const [states, nexusIds, steam, clientMods] = await Promise.all([
    readServerModStates(),
    readNexusAssocIds(),
    readSteamMods(),
    listClientMods(),
  ])
  // A client stage with a `warn` has NO client-installable files (PalSchema / server-side
  // mods staged on the client) — it never ships in the loadout, so its `keep` flag is not a
  // real client state. Excluding these means a server-only mod never shows as "drift" and can
  // never be "matched to client" (which would wrongly disable the legitimate server mod).
  const clientInstallable = clientMods.filter((m) => !m.warn)
  const out: DriftEntry[] = []
  for (const s of states) {
    if (s.kind === 'paldefender') continue // server-only concept, never in a client loadout
    const m = matchClient(s, nexusIds, steam, clientInstallable)
    if (!m) continue
    if (s.enabled !== m.mod.keep) {
      out.push({
        serverId: s.id,
        serverName: s.name,
        serverEnabled: s.enabled,
        clientId: m.mod.id,
        clientName: m.mod.name,
        clientKeep: m.mod.keep,
        matchBy: m.by,
      })
    }
  }
  return out
}

// Resolve one drift by making one side match the other. authoritative='server' pushes the
// server's state to the client loadout; 'client' pushes the loadout's state to the server.
export async function matchDrift(
  serverId: string,
  clientId: string,
  authoritative: 'server' | 'client',
): Promise<void> {
  const [states, clientMods] = await Promise.all([readServerModStates(), listClientMods()])
  const s = states.find((x) => x.id === serverId)
  const c = clientMods.find((x) => x.id === clientId)
  if (!s) throw new Error('Server mod not found')
  if (!c) throw new Error('Client mod not found')
  if (authoritative === 'server') {
    await setClientModKeep(clientId, s.enabled)
  } else {
    await setServerModEnabled(serverId, c.keep)
  }
}
