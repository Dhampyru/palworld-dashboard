// Temp stash for the "scan first, then confirm" upload flow. A scan normalizes the
// uploaded archive to a zip, analyzes it, and parks the zip here keyed by a random token;
// the follow-up commit reads it back and installs to the chosen targets, then deletes it.
// This avoids re-uploading (and re-parsing) the file on confirm. Lives in the /app/data
// volume alongside the other dashboard state; entries are pruned after PRUNE_MS.
import { mkdir, writeFile, readFile, rm, readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { ModAnalysis } from '@/lib/mod-targeting'

const DATA_DIR = resolve(process.env.DASHBOARD_DATA_DIR ?? './data')
const SCAN_DIR = join(DATA_DIR, 'mod-scan')
const PRUNE_MS = 60 * 60 * 1000 // 1h — a confirm should follow a scan quickly

export type ScanMeta = {
  nameHint: string
  analysis: ModAnalysis
  isPak: boolean // the upload was a bare .pak (wrapped in a one-entry zip in the stash)
  pakName: string | null // sanitized bare-pak filename, when isPak
  createdAt: number
}

// Best-effort removal of stale scans so an abandoned upload never lingers on the volume.
async function prune(): Promise<void> {
  let names: string[]
  try {
    names = await readdir(SCAN_DIR)
  } catch {
    return
  }
  const now = Date.now()
  await Promise.all(
    names.map(async (n) => {
      try {
        const p = join(SCAN_DIR, n)
        const st = await stat(p)
        if (now - st.mtimeMs > PRUNE_MS) await rm(p, { force: true })
      } catch {
        /* ignore */
      }
    }),
  )
}

function tokenPaths(token: string) {
  // token is hex only (from randomBytes) — no path-traversal surface.
  const safe = /^[a-f0-9]{8,}$/i.test(token) ? token : ''
  if (!safe) return null
  return { zip: join(SCAN_DIR, `${safe}.zip`), meta: join(SCAN_DIR, `${safe}.json`) }
}

// Stash a normalized zip + its analysis, returning the token the commit will use.
export async function stashScan(zipBuffer: Buffer, meta: Omit<ScanMeta, 'createdAt'>): Promise<string> {
  await mkdir(SCAN_DIR, { recursive: true })
  await prune()
  const token = randomBytes(12).toString('hex')
  const paths = tokenPaths(token)!
  await writeFile(paths.zip, zipBuffer)
  await writeFile(paths.meta, JSON.stringify({ ...meta, createdAt: Date.now() } satisfies ScanMeta), 'utf8')
  return token
}

// Read back a stashed scan. Returns null if the token is unknown/expired.
export async function readScan(token: string): Promise<{ buffer: Buffer; meta: ScanMeta } | null> {
  const paths = tokenPaths(token)
  if (!paths) return null
  try {
    const [buffer, metaRaw] = await Promise.all([readFile(paths.zip), readFile(paths.meta, 'utf8')])
    return { buffer, meta: JSON.parse(metaRaw) as ScanMeta }
  } catch {
    return null
  }
}

export async function deleteScan(token: string): Promise<void> {
  const paths = tokenPaths(token)
  if (!paths) return
  await Promise.all([rm(paths.zip, { force: true }), rm(paths.meta, { force: true })])
}

// Clear the entire scan stash (file/Nexus pending scans). Returns how many entries removed.
// For the manual "Clear mod download cache" action.
export async function purgeAllScans(): Promise<number> {
  let names: string[]
  try {
    names = await readdir(SCAN_DIR)
  } catch {
    return 0
  }
  let n = 0
  await Promise.all(
    names.map(async (f) => {
      try {
        await rm(join(SCAN_DIR, f), { force: true })
        if (f.endsWith('.zip')) n += 1
      } catch {
        /* ignore */
      }
    }),
  )
  return n
}
