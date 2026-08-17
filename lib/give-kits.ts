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

const ITEM_ID_RE = /^[A-Za-z0-9_]+$/
const MAX_AMOUNT = 99999

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

// ---- persistence -------------------------------------------------------------------------
type Store = { kits: GiveKit[] }

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

async function readStore(): Promise<Store> {
  try {
    const j = JSON.parse(await readFile(FILE, 'utf8')) as Partial<Store>
    if (Array.isArray(j.kits)) return { kits: j.kits }
  } catch {
    /* seed below */
  }
  await writeStore({ kits: DEFAULT_KITS })
  return { kits: DEFAULT_KITS }
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
