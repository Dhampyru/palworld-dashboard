// SERVER-ONLY. PATCH (not upstream): Keybind Manager Phase 3 — named keybind PROFILES. A profile is
// a named snapshot of the client-mod keybind-override LAYER — every config-override across the client
// mods, which is where the remap manager (Phase 1/2) writes its key reassignments. Save / restore /
// rename / delete — mirrors lib/mod-profiles.ts, but for keybinds. Restoring makes the override layer
// match the profile EXACTLY: every current override is cleared, then the profile's are written back.
//
// Snapshotting the ACTUAL overrides (enumerated from disk) — NOT the keybind-remap ledger — is
// deliberate: the ledger drifts (a mod re-added under a new id, or a case-different relWithin, leaves
// stale/duplicate entries), so it under-counts the real set. Enumerating readClientModConfigOverrides
// per mod is the reliable source of truth. A restore re-points the ledger at the restored set.
//
// Why snapshot the FILE CONTENTS (not just references): the override files live under
// data/client-mods/<id>/config-override/…, which the dashboard-data auto-backup EXCLUDES (staged
// payloads are bulky + re-downloadable). Storing the content inside keybind-profiles.json — which IS
// backed up — makes a profile self-contained and restorable from a data snapshot.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { listClientMods } from '@/lib/client-mods'
import { clearClientModConfig, readClientModConfigOverrides, saveClientModConfig } from '@/lib/client-mod-config'
import { setLedger } from '@/lib/keybind-remap'

const DATA_DIR = resolve(process.env.DASHBOARD_DATA_DIR ?? './data')
const PROFILES_FILE = join(DATA_DIR, 'keybind-profiles.json')

export type KeybindOverride = { modId: string; modName: string; relWithin: string; content: string }
export type KeybindProfile = {
  id: string // slug, unique
  name: string
  createdAt: number
  note?: string
  overrides: KeybindOverride[] // empty = a "stock keybinds" profile (no remaps)
}
type Store = Record<string, KeybindProfile>

// ── store I/O (mirrors mod-profiles: atomic temp+rename, serialized mutate) ──────────────────────
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

let chain: Promise<unknown> = Promise.resolve()
function mutate<T>(fn: (store: Store) => T | Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const store = await readStore()
    const result = await fn(store)
    await writeStore(store)
    return result
  })
  chain = run.then(
    () => {},
    () => {},
  )
  return run
}

function slugify(name: string): string {
  const base = name.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase()
  return base || 'keybinds'
}
function uniqueId(store: Store, base: string): string {
  const slug = slugify(base)
  if (!store[slug]) return slug
  for (let i = 2; ; i++) {
    const cand = `${slug}-${i}`
    if (!store[cand]) return cand
  }
}

// ── snapshot the current override layer (enumerated from disk — reliable) ──────────────────────────
async function snapshotOverrides(): Promise<KeybindOverride[]> {
  const out: KeybindOverride[] = []
  for (const m of await listClientMods()) {
    for (const o of await readClientModConfigOverrides(m.id).catch(() => [])) {
      const content = await readFile(o.absPath, 'utf8').catch(() => null)
      if (content == null) continue
      out.push({ modId: m.id, modName: m.name, relWithin: o.relWithin, content })
    }
  }
  return out
}

// ── public API ───────────────────────────────────────────────────────────────────────────────────
export async function listProfiles(): Promise<KeybindProfile[]> {
  const store = await readStore()
  return Object.values(store).sort((a, b) => b.createdAt - a.createdAt)
}

export async function saveProfile(name: string, note?: string): Promise<KeybindProfile> {
  const trimmed = (name || '').trim()
  if (!trimmed) throw new Error('Name a profile before saving')
  const overrides = await snapshotOverrides() // outside mutate() — it does I/O
  return mutate((store) => {
    const id = uniqueId(store, trimmed)
    const profile: KeybindProfile = { id, name: trimmed, createdAt: Date.now(), note: note?.trim() || undefined, overrides }
    store[id] = profile
    return profile
  })
}

export async function renameProfile(id: string, name: string): Promise<KeybindProfile> {
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

export type KbRestoreReport = { applied: number; missing: { modName: string; relWithin: string }[] }

// Make the override layer match the profile EXACTLY: drop every current client-mod override, then
// write the profile's back. An empty profile therefore restores "stock keybinds" (no remaps).
// Reversible — the caller can re-save the prior set as its own profile first. Effective on next
// loadout build. The ledger is re-pointed at the restored set (fixing any prior drift).
export async function restoreProfile(id: string): Promise<KbRestoreReport> {
  const store = await readStore()
  const profile = store[id]
  if (!profile) throw new Error('No such profile')

  const mods = await listClientMods()
  const present = new Set(mods.map((m) => m.id))

  // 1. Clear every current override (enumerate the real files, not the drift-prone ledger).
  for (const m of mods) {
    for (const o of await readClientModConfigOverrides(m.id).catch(() => [])) {
      await clearClientModConfig(m.id, o.relWithin).catch(() => {})
    }
  }

  // 2. Write the profile's overrides (mods that vanished since the snapshot are reported).
  const report: KbRestoreReport = { applied: 0, missing: [] }
  const written: { modId: string; relWithin: string }[] = []
  for (const o of profile.overrides) {
    if (!present.has(o.modId)) {
      report.missing.push({ modName: o.modName, relWithin: o.relWithin })
      continue
    }
    try {
      await saveClientModConfig(o.modId, o.relWithin, o.content) // .lua re-validated on save
      written.push({ modId: o.modId, relWithin: o.relWithin })
      report.applied++
    } catch {
      report.missing.push({ modName: o.modName, relWithin: o.relWithin })
    }
  }

  // 3. Re-point the remap ledger at exactly the restored set (no override-file side effects).
  await setLedger(written)
  return report
}
