import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { currentGameDir } from '@/lib/instances'
import { buildClientLoadout } from '@/lib/client-loadout'

// PATCH (not upstream): friend-facing share links (docs/specs/client-mod-sync.md §5b/§8).
// The admin mints a share link; a non-admin friend opens a public page (token = capability,
// no admin login) and downloads the loadout bundle. Unlike the admin one-time-token
// download (lib/loadout-tokens.ts, in-memory + single-use + 15min), a share PERSISTS: the
// generated .zip is stored on the game volume (has space; the data volume is small) and the
// metadata (server info snapshot + zip path) in the data volume. Multi-use + revocable.
const DATA_DIR = resolve(process.env.DASHBOARD_DATA_DIR ?? './data')
const SHARES_INDEX = join(DATA_DIR, 'client-shares.json')
const sharesDir = () => join(currentGameDir(), 'client-shares')

export type ShareSummary = { lua: number; pak: number; logic: number; parity: number; skipped: number; ue4ss: boolean }
export type ShareInfo = {
  token: string
  fileName: string
  sizeBytes: number
  createdAt: number
  label: string | null
  serverName: string | null
  gameVersion: string | null
  connect: string | null // host:port the friend uses
  summary: ShareSummary
}
type StoredShare = ShareInfo & { path: string } // path = absolute zip path (never exposed)
type Index = Record<string, StoredShare>

async function readIndex(): Promise<Index> {
  try {
    const j = JSON.parse(await readFile(SHARES_INDEX, 'utf8')) as Index
    return j && typeof j === 'object' ? j : {}
  } catch {
    return {}
  }
}
async function writeIndex(idx: Index): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true })
  const tmp = `${SHARES_INDEX}.tmp`
  await writeFile(tmp, JSON.stringify(idx, null, 2) + '\n', 'utf8')
  await rename(tmp, SHARES_INDEX)
}
const publicView = (s: StoredShare): ShareInfo => {
  const { path: _path, ...rest } = s
  void _path
  return rest
}

// Generate a bundle, persist it, and mint a share. Runs in the admin's instance context.
export async function createShare(opts: {
  includeUe4ss?: boolean
  serverName?: string | null
  gameVersion?: string | null
  port?: number
  connectHost?: string | null
  label?: string | null
}): Promise<ShareInfo> {
  const { zipPath, fileName, summary, cleanup } = await buildClientLoadout({ includeUe4ss: opts.includeUe4ss })
  try {
    const token = randomBytes(24).toString('hex')
    const dir = sharesDir()
    await mkdir(dir, { recursive: true })
    const dest = join(dir, `${token}.zip`)
    await copyFile(zipPath, dest) // cross-device safe (temp /tmp → game volume)
    const host = opts.connectHost?.trim()
    const stored: StoredShare = {
      token,
      fileName,
      path: dest,
      sizeBytes: summary.sizeBytes,
      createdAt: Date.now(),
      label: opts.label?.trim() || null,
      serverName: opts.serverName ?? null,
      gameVersion: opts.gameVersion ?? null,
      connect: host ? `${host}:${opts.port ?? 8211}` : null,
      summary: {
        lua: summary.luaMods.length,
        pak: summary.pakFiles.length,
        logic: summary.logicMods.length,
        parity: summary.parityPaks,
        skipped: summary.skipped.length,
        ue4ss: summary.includedUe4ss,
      },
    }
    const idx = await readIndex()
    idx[token] = stored
    await writeIndex(idx)
    return publicView(stored)
  } finally {
    await cleanup()
  }
}

export async function listShares(): Promise<ShareInfo[]> {
  const idx = await readIndex()
  return Object.values(idx)
    .map(publicView)
    .sort((a, b) => b.createdAt - a.createdAt)
}

// Public-safe metadata for the friend page (null if the token is unknown/revoked).
export async function getShare(token: string): Promise<ShareInfo | null> {
  if (!/^[a-f0-9]{48}$/.test(token)) return null
  const s = (await readIndex())[token]
  return s ? publicView(s) : null
}

// The persisted zip's path + name for the public download (server-resolved from the token,
// never from client input). Null if unknown.
export async function resolveShareZip(token: string): Promise<{ path: string; fileName: string; sizeBytes: number } | null> {
  if (!/^[a-f0-9]{48}$/.test(token)) return null
  const s = (await readIndex())[token]
  return s ? { path: s.path, fileName: s.fileName, sizeBytes: s.sizeBytes } : null
}

export async function deleteShare(token: string): Promise<void> {
  const idx = await readIndex()
  const s = idx[token]
  if (!s) return
  delete idx[token]
  await writeIndex(idx)
  await rm(s.path, { force: true }).catch(() => {})
}
