import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { currentInstanceId, resolveInstance } from '@/lib/instances'

// PATCH (not upstream): durable server-side connect address for the friend loadout
// (docs/specs/client-mod-sync.md §8). The invite panel's host field was browser-local
// only (localStorage), so a share minted without it — or from another browser/the API —
// carried no "Connect address", and friends didn't know where to join. This persists the
// host once in the data volume so EVERY share + the bundle's INSTALL.txt show it
// automatically. Not a secret (friends need it to connect); backed up with the other
// operational JSONs. The port defaults to the ACTIVE instance's game port.
const DATA_DIR = resolve(process.env.DASHBOARD_DATA_DIR ?? './data')
const FILE = join(DATA_DIR, 'loadout-connect.json')

export type LoadoutConnect = { host: string | null; port: number | null }

function instanceGamePort(): number {
  return resolveInstance(currentInstanceId())?.ports.game ?? Number(process.env.PALWORLD_GAME_PORT ?? 8211)
}

export async function getLoadoutConnect(): Promise<LoadoutConnect> {
  try {
    const j = JSON.parse(await readFile(FILE, 'utf8')) as Partial<LoadoutConnect>
    const host = typeof j.host === 'string' && j.host.trim() ? j.host.trim() : null
    const port = typeof j.port === 'number' && j.port > 0 ? Math.floor(j.port) : null
    return { host, port }
  } catch {
    return { host: null, port: null }
  }
}

export async function setLoadoutConnect(c: LoadoutConnect): Promise<LoadoutConnect> {
  const host = c.host?.trim() || null
  const port = c.port && c.port > 0 ? Math.floor(c.port) : null
  await mkdir(DATA_DIR, { recursive: true })
  const tmp = `${FILE}.tmp`
  await writeFile(tmp, JSON.stringify({ host, port }, null, 2) + '\n', 'utf8')
  await rename(tmp, FILE)
  return { host, port }
}

// The full "host:port" string a friend connects to, or null if no host is set.
// Port precedence: explicit stored port → the active instance's game port.
export async function resolveConnectString(): Promise<string | null> {
  const c = await getLoadoutConnect()
  if (!c.host) return null
  return `${c.host}:${c.port ?? instanceGamePort()}`
}
