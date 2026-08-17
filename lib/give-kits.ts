import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { currentInstanceId, gameDataReadScopes, resolveInstance } from '@/lib/instances'
import { getRconConfig, runRcon } from '@/lib/rcon-exec'

// PATCH (not upstream): reusable "give-items kits" (docs/specs/give-kits.md). A kit is a
// named list of {itemId, amount} handed to a player in one PalDefender `giveitems` call
// (`giveitems <UserId> ItemId:Amount ...`). Persisted in the data volume; item IDs are
// validated against the operator's extracted dataset (the RCON picker's source) so a typo'd
// id is caught before it reaches the live server. Admin-only at the route.
const DATA_DIR = resolve(process.env.DASHBOARD_DATA_DIR ?? './data')
const FILE = join(DATA_DIR, 'give-kits.json')
const BAKED_DATASETS_DIR = process.env.PALWORLD_DATASETS_DIR ?? join(process.cwd(), 'data')

export type KitItem = { itemId: string; amount: number }
export type GiveKit = { id: string; name: string; items: KitItem[] }

// Pal kits: a named team handed out via one `givepal <UserId> <PalId> <level>` per Pal
// (repeated `count` times). Party holds 5; extras overflow to the Palbox.
export type KitPal = { palId: string; level: number; count: number }
export type PalKit = { id: string; name: string; pals: KitPal[] }

const ITEM_ID_RE = /^[A-Za-z0-9_]+$/
const PAL_ID_RE = /^[A-Za-z0-9_]+$/
const MAX_AMOUNT = 99999
const MAX_LEVEL = 60
const MAX_COUNT = 10
const MAX_PAL_CALLS = 30 // total givepal calls per kit, so a kit can't flood the server

// A sensible starter kit so the panel is useful on first open. IDs verified against the
// live dataset (Wood/Stone/Fiber/Pal_crystal_S/CopperIngot/Cement/Coal).
const DEFAULT_KITS: GiveKit[] = [
  {
    id: 'building-materials',
    name: 'Building Materials',
    items: [
      { itemId: 'Wood', amount: 2000 },
      { itemId: 'Stone', amount: 2000 },
      { itemId: 'Fiber', amount: 1000 },
      { itemId: 'Pal_crystal_S', amount: 500 },
      { itemId: 'CopperIngot', amount: 300 },
      { itemId: 'Cement', amount: 200 },
      { itemId: 'Coal', amount: 200 },
    ],
  },
  {
    id: 'starter-kit',
    name: 'Starter Kit',
    items: [
      { itemId: 'PalSphere', amount: 50 },
      { itemId: 'Pan', amount: 20 }, // Bread
      { itemId: 'Berries', amount: 50 }, // Red Berries
      { itemId: 'Herbs', amount: 20 }, // Low Grade Medical Supplies
      { itemId: 'ClothArmor', amount: 1 }, // Cloth Outfit
      { itemId: 'Wood', amount: 500 },
      { itemId: 'Stone', amount: 500 },
    ],
  },
  {
    id: 'capture-kit',
    name: 'Capture Kit (Spheres)',
    items: [
      { itemId: 'PalSphere', amount: 100 },
      { itemId: 'PalSphere_Mega', amount: 50 },
      { itemId: 'PalSphere_Giga', amount: 30 },
      { itemId: 'PalSphere_Master', amount: 10 },
    ],
  },
  {
    id: 'combat-kit',
    name: 'Combat Kit',
    items: [
      { itemId: 'AssaultRifle_Default1', amount: 1 },
      { itemId: 'AssaultRifleBullet', amount: 2000 },
      { itemId: 'HandgunBullet', amount: 500 },
      { itemId: 'LuxuryMedicines', amount: 20 }, // High Grade Medical Supplies
      { itemId: 'Potion_High', amount: 20 }, // High Quality Recovery Meds
      { itemId: 'PalRevive', amount: 5 }, // Revival Potion
    ],
  },
  {
    id: 'food-kit',
    name: 'Food Kit',
    items: [
      { itemId: 'Pan', amount: 50 }, // Bread
      { itemId: 'Berries', amount: 100 },
      { itemId: 'BakedMeat_ChickenPal', amount: 30 }, // Grilled Chikipi
      { itemId: 'Milk', amount: 30 },
      { itemId: 'Potion', amount: 10 }, // Recovery Meds
    ],
  },
]

// Default Pal teams — ids verified against the live dataset (normal, non-alpha variants).
const DEFAULT_PAL_KITS: PalKit[] = [
  {
    id: 'starter-team',
    name: 'Starter Team',
    pals: [
      { palId: 'SheepBall', level: 5, count: 1 }, // Lamball
      { palId: 'PinkCat', level: 5, count: 1 }, // Cattiva
      { palId: 'ChickenPal', level: 5, count: 1 }, // Chikipi
      { palId: 'Kitsunebi', level: 5, count: 1 }, // Foxparks
      { palId: 'Penguin', level: 5, count: 1 }, // Pengullet
    ],
  },
  {
    id: 'worker-team',
    name: 'Worker Team',
    pals: [
      { palId: 'Kitsunebi', level: 15, count: 1 }, // Foxparks — Kindling
      { palId: 'BluePlatypus', level: 15, count: 1 }, // Fuack — Watering
      { palId: 'RobinHood', level: 15, count: 1 }, // Robinquill — Planting/Handiwork
      { palId: 'Carbunclo', level: 15, count: 1 }, // Lifmunk — Handiwork
      { palId: 'DrillGame', level: 15, count: 1 }, // Digtoise — Mining
      { palId: 'Deer', level: 15, count: 1 }, // Eikthyrdeer — Lumbering
      { palId: 'CatBat', level: 15, count: 1 }, // Tombat — Mining/Handiwork
      { palId: 'PinkCat', level: 15, count: 1 }, // Cattiva — Gathering/Transport
    ],
  },
  {
    id: 'combat-team',
    name: 'Combat Team',
    pals: [
      { palId: 'Anubis', level: 50, count: 1 },
      { palId: 'JetDragon', level: 50, count: 1 }, // Jetragon
      { palId: 'IceHorse', level: 50, count: 1 }, // Frostallion
      { palId: 'BlackCentaur', level: 50, count: 1 }, // Necromus
      { palId: 'BlackGriffon', level: 50, count: 1 }, // Shadowbeak
      { palId: 'ElecPanda', level: 50, count: 1 }, // Grizzbolt
    ],
  },
]

// ---- item dataset (for validation + the picker) ------------------------------------------
export type ItemEntry = { id: string; name?: string; image?: string }

// Load items.json from the active instance's extracted datasets, falling back to the baked
// dir (which holds the operator's populated copy on this box). First non-empty wins.
export async function loadItems(instanceId?: string | null): Promise<ItemEntry[]> {
  const dirs = [...gameDataReadScopes(instanceId ?? currentInstanceId()).map((s) => s.dataDir), BAKED_DATASETS_DIR]
  for (const dir of dirs) {
    try {
      const arr = JSON.parse(await readFile(join(dir, 'items.json'), 'utf8')) as ItemEntry[]
      if (Array.isArray(arr) && arr.length) return arr.filter((e) => e && typeof e.id === 'string')
    } catch {
      /* try next dir */
    }
  }
  return []
}

async function itemIdSet(instanceId?: string | null): Promise<Set<string>> {
  return new Set((await loadItems(instanceId)).map((e) => e.id))
}

// Same shape/behaviour as loadItems, over pals.json (for the Pal picker + validation).
export async function loadPals(instanceId?: string | null): Promise<ItemEntry[]> {
  const dirs = [...gameDataReadScopes(instanceId ?? currentInstanceId()).map((s) => s.dataDir), BAKED_DATASETS_DIR]
  for (const dir of dirs) {
    try {
      const arr = JSON.parse(await readFile(join(dir, 'pals.json'), 'utf8')) as ItemEntry[]
      if (Array.isArray(arr) && arr.length) return arr.filter((e) => e && typeof e.id === 'string')
    } catch {
      /* try next dir */
    }
  }
  return []
}

async function palIdSet(instanceId?: string | null): Promise<Set<string>> {
  return new Set((await loadPals(instanceId)).map((e) => e.id))
}

// ---- persistence -------------------------------------------------------------------------
type Store = { kits: GiveKit[]; palKits: PalKit[] }

function sanitizeKit(input: unknown): GiveKit {
  const k = (input ?? {}) as Partial<GiveKit>
  const name = typeof k.name === 'string' ? k.name.trim() : ''
  if (!name) throw new Error('Kit name is required')
  const rawItems = Array.isArray(k.items) ? k.items : []
  const items: KitItem[] = []
  for (const it of rawItems) {
    const itemId = typeof it?.itemId === 'string' ? it.itemId.trim() : ''
    if (!itemId) continue
    if (!ITEM_ID_RE.test(itemId)) throw new Error(`Invalid item id: "${itemId}"`)
    let amount = Math.floor(Number(it?.amount))
    if (!Number.isFinite(amount) || amount < 1) amount = 1
    if (amount > MAX_AMOUNT) amount = MAX_AMOUNT
    items.push({ itemId, amount })
  }
  if (!items.length) throw new Error('A kit needs at least one item')
  const id = typeof k.id === 'string' && k.id.trim() ? k.id.trim() : randomBytes(6).toString('hex')
  return { id, name, items }
}

function sanitizePalKit(input: unknown): PalKit {
  const k = (input ?? {}) as Partial<PalKit>
  const name = typeof k.name === 'string' ? k.name.trim() : ''
  if (!name) throw new Error('Kit name is required')
  const rawPals = Array.isArray(k.pals) ? k.pals : []
  const pals: KitPal[] = []
  for (const p of rawPals) {
    const palId = typeof p?.palId === 'string' ? p.palId.trim() : ''
    if (!palId) continue
    if (!PAL_ID_RE.test(palId)) throw new Error(`Invalid Pal id: "${palId}"`)
    let level = Math.floor(Number(p?.level))
    if (!Number.isFinite(level) || level < 1) level = 1
    if (level > MAX_LEVEL) level = MAX_LEVEL
    let count = Math.floor(Number(p?.count))
    if (!Number.isFinite(count) || count < 1) count = 1
    if (count > MAX_COUNT) count = MAX_COUNT
    pals.push({ palId, level, count })
  }
  if (!pals.length) throw new Error('A team needs at least one Pal')
  const id = typeof k.id === 'string' && k.id.trim() ? k.id.trim() : randomBytes(6).toString('hex')
  return { id, name, pals }
}

async function readStore(): Promise<Store> {
  let kits: GiveKit[] | null = null
  let palKits: PalKit[] | null = null
  try {
    const j = JSON.parse(await readFile(FILE, 'utf8')) as Partial<Store>
    if (Array.isArray(j.kits)) kits = j.kits
    if (Array.isArray(j.palKits)) palKits = j.palKits
  } catch {
    /* seed both below */
  }
  const store: Store = { kits: kits ?? DEFAULT_KITS, palKits: palKits ?? DEFAULT_PAL_KITS }
  if (kits === null || palKits === null) await writeStore(store) // seed whichever half is missing
  return store
}

async function writeStore(store: Store): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true })
  const tmp = `${FILE}.tmp`
  await writeFile(tmp, JSON.stringify(store, null, 2) + '\n', 'utf8')
  await rename(tmp, FILE)
}

export async function listKits(): Promise<GiveKit[]> {
  return (await readStore()).kits
}

export async function saveKit(input: unknown): Promise<GiveKit> {
  const kit = sanitizeKit(input)
  const store = await readStore()
  const idx = store.kits.findIndex((k) => k.id === kit.id)
  if (idx >= 0) store.kits[idx] = kit
  else store.kits.push(kit)
  await writeStore(store)
  return kit
}

export async function deleteKit(id: string): Promise<void> {
  const store = await readStore()
  store.kits = store.kits.filter((k) => k.id !== id)
  await writeStore(store)
}

export async function listPalKits(): Promise<PalKit[]> {
  return (await readStore()).palKits
}

export async function savePalKit(input: unknown): Promise<PalKit> {
  const kit = sanitizePalKit(input)
  const store = await readStore()
  const idx = store.palKits.findIndex((k) => k.id === kit.id)
  if (idx >= 0) store.palKits[idx] = kit
  else store.palKits.push(kit)
  await writeStore(store)
  return kit
}

export async function deletePalKit(id: string): Promise<void> {
  const store = await readStore()
  store.palKits = store.palKits.filter((k) => k.id !== id)
  await writeStore(store)
}

// ---- command build + execute -------------------------------------------------------------
// PalDefender: `giveitems <UserId> ItemId:Amount ItemId:Amount ...`
export function buildGiveItemsCommand(userId: string, items: KitItem[]): string {
  const pairs = items.map((i) => `${i.itemId}:${i.amount}`).join(' ')
  return `giveitems ${userId} ${pairs}`
}

export type GiveResult = { command: string; response: string; unknownItemIds: string[] }

export async function giveKit(kitId: string, userId: string, instanceId?: string | null): Promise<GiveResult> {
  const uid = String(userId ?? '').trim()
  if (!uid) throw new Error('A target player (UserId) is required')
  const inst = instanceId ?? currentInstanceId()
  const kit = (await listKits()).find((k) => k.id === kitId)
  if (!kit) throw new Error('Kit not found')

  const known = await itemIdSet(inst)
  const unknownItemIds = known.size ? kit.items.map((i) => i.itemId).filter((id) => !known.has(id)) : []

  const rcon = getRconConfig(resolveInstance(inst)?.id ?? inst)
  if (!rcon) throw new Error('RCON is not configured on this server (missing admin password)')
  const command = buildGiveItemsCommand(uid, kit.items)
  const response = await runRcon(rcon, command)
  return { command, response, unknownItemIds }
}

// PalDefender: `givepal <UserId> <PalId> <level>` — one Pal per call, repeated per count.
export type GivePalResult = { commands: string[]; responses: string[]; unknownPalIds: string[]; given: number }

export async function givePalKit(kitId: string, userId: string, instanceId?: string | null): Promise<GivePalResult> {
  const uid = String(userId ?? '').trim()
  if (!uid) throw new Error('A target player (UserId) is required')
  const inst = instanceId ?? currentInstanceId()
  const kit = (await listPalKits()).find((k) => k.id === kitId)
  if (!kit) throw new Error('Pal team not found')

  const known = await palIdSet(inst)
  const unknownPalIds = known.size ? kit.pals.map((p) => p.palId).filter((id) => !known.has(id)) : []

  const rcon = getRconConfig(resolveInstance(inst)?.id ?? inst)
  if (!rcon) throw new Error('RCON is not configured on this server (missing admin password)')

  const commands: string[] = []
  const responses: string[] = []
  let given = 0
  for (const p of kit.pals) {
    for (let n = 0; n < p.count; n++) {
      if (given >= MAX_PAL_CALLS) break
      const command = `givepal ${uid} ${p.palId} ${p.level}`
      commands.push(command)
      responses.push(await runRcon(rcon, command))
      given++
    }
  }
  return { commands, responses, unknownPalIds, given }
}
