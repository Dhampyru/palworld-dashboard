import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { currentGameDir } from '@/lib/instances'
import { buildClientLoadout } from '@/lib/client-loadout'

// PATCH (not upstream): friend-facing share links (docs/specs/client-mod-sync.md §5b/§8).
// The admin mints a share link; a non-admin friend opens a public page (token = capability,
// no admin login) and downloads the loadout bundle. Persistent (zip on the game volume,
// metadata in the data volume) + revocable. Hardening (§8a): optional expiry, max downloads,
// and a passphrase — the token stays a bearer capability but the admin can bound it.
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
  expiresAt: number | null // epoch ms; null = never
  maxUses: number | null // null = unlimited
  uses: number
  requiresPass: boolean // derived; the passphrase itself is never exposed
}
// Stored adds the zip path + passphrase hash — both stripped from any public/admin response.
type StoredShare = Omit<ShareInfo, 'requiresPass'> & { path: string; passHash: string | null }
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
  const { path: _path, passHash, ...rest } = s
  void _path
  return { ...rest, requiresPass: Boolean(passHash) }
}
const isExpired = (s: StoredShare): boolean => s.expiresAt != null && Date.now() > s.expiresAt
const isExhausted = (s: StoredShare): boolean => s.maxUses != null && s.uses >= s.maxUses

// Remove expired shares (delete their zip). Persists only if something changed. Called on
// read paths so dead links self-clean. Exhausted links are KEPT (admin sees "used up").
async function sweep(idx: Index): Promise<Index> {
  let changed = false
  for (const [tok, s] of Object.entries(idx)) {
    if (isExpired(s)) {
      delete idx[tok]
      changed = true
      await rm(s.path, { force: true }).catch(() => {})
    }
  }
  if (changed) await writeIndex(idx)
  return idx
}

// scrypt(pass, token-as-salt) → hex; token is unique per share so no separate salt needed.
const hashPass = (pass: string, token: string): string => scryptSync(pass, token, 32).toString('hex')
function passOk(s: StoredShare, pass: string | null): boolean {
  if (!s.passHash) return true
  if (!pass) return false
  const want = Buffer.from(s.passHash, 'hex')
  const got = scryptSync(pass, s.token, 32)
  return want.length === got.length && timingSafeEqual(want, got)
}

// Generate a bundle, persist it, and mint a share. Runs in the admin's instance context.
export async function createShare(opts: {
  includeUe4ss?: boolean
  serverName?: string | null
  gameVersion?: string | null
  port?: number
  connectHost?: string | null
  label?: string | null
  expiryHours?: number | null // null/0 = never
  maxUses?: number | null // null/0 = unlimited
  passphrase?: string | null
}): Promise<ShareInfo> {
  const { zipPath, fileName, summary, cleanup } = await buildClientLoadout({ includeUe4ss: opts.includeUe4ss })
  try {
    const token = randomBytes(24).toString('hex')
    const dir = sharesDir()
    await mkdir(dir, { recursive: true })
    const dest = join(dir, `${token}.zip`)
    await copyFile(zipPath, dest) // cross-device safe (temp /tmp → game volume)
    const host = opts.connectHost?.trim()
    const pass = opts.passphrase?.trim() || null
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
      expiresAt: opts.expiryHours && opts.expiryHours > 0 ? Date.now() + opts.expiryHours * 3600_000 : null,
      maxUses: opts.maxUses && opts.maxUses > 0 ? Math.floor(opts.maxUses) : null,
      uses: 0,
      passHash: pass ? hashPass(pass, token) : null,
    }
    const idx = await sweep(await readIndex())
    idx[token] = stored
    await writeIndex(idx)
    return publicView(stored)
  } finally {
    await cleanup()
  }
}

export async function listShares(): Promise<ShareInfo[]> {
  const idx = await sweep(await readIndex())
  return Object.values(idx)
    .map(publicView)
    .sort((a, b) => b.createdAt - a.createdAt)
}

// Public-safe metadata for the friend page. Null if unknown/expired; still returned when
// exhausted (uses >= maxUses) so the page can say "used up" rather than "not found".
export async function getShare(token: string): Promise<ShareInfo | null> {
  if (!/^[a-f0-9]{48}$/.test(token)) return null
  const s = (await sweep(await readIndex()))[token]
  return s ? publicView(s) : null
}

export type DownloadPrep =
  | { ok: true; path: string; fileName: string; sizeBytes: number }
  | { ok: false; reason: 'notfound' | 'exhausted' | 'badpass' }

// Validate + authorize a download, then count the use. Server-resolves the path from the
// token (never client input). Expired links are swept → 'notfound'.
export async function prepareDownload(token: string, pass: string | null): Promise<DownloadPrep> {
  if (!/^[a-f0-9]{48}$/.test(token)) return { ok: false, reason: 'notfound' }
  const idx = await sweep(await readIndex())
  const s = idx[token]
  if (!s) return { ok: false, reason: 'notfound' }
  if (isExhausted(s)) return { ok: false, reason: 'exhausted' }
  if (!passOk(s, pass)) return { ok: false, reason: 'badpass' }
  s.uses += 1
  await writeIndex(idx)
  return { ok: true, path: s.path, fileName: s.fileName, sizeBytes: s.sizeBytes }
}

// Validate a token+pass WITHOUT counting a use — for the page's pre-download check, so a
// wrong passphrase / dead link shows a message instead of the browser navigating to a raw
// JSON error, and only the real download increments `uses`.
export async function checkShare(
  token: string,
  pass: string | null,
): Promise<{ ok: boolean; reason?: 'notfound' | 'exhausted' | 'badpass' }> {
  if (!/^[a-f0-9]{48}$/.test(token)) return { ok: false, reason: 'notfound' }
  const s = (await sweep(await readIndex()))[token]
  if (!s) return { ok: false, reason: 'notfound' }
  if (isExhausted(s)) return { ok: false, reason: 'exhausted' }
  if (!passOk(s, pass)) return { ok: false, reason: 'badpass' }
  return { ok: true }
}

export async function deleteShare(token: string): Promise<void> {
  const idx = await readIndex()
  const s = idx[token]
  if (!s) return
  delete idx[token]
  await writeIndex(idx)
  await rm(s.path, { force: true }).catch(() => {})
}

export async function revokeAll(): Promise<{ removed: number }> {
  const idx = await readIndex()
  const entries = Object.values(idx)
  for (const s of entries) await rm(s.path, { force: true }).catch(() => {})
  await writeIndex({})
  return { removed: entries.length }
}
