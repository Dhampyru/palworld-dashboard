import { copyFile, cp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
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
// Stored adds the zip path, the extracted tree dir (for FSA per-file serving), and the
// passphrase hash — all stripped from any public/admin response.
type StoredShare = Omit<ShareInfo, 'requiresPass'> & { path: string; treeDir: string; passHash: string | null }
type Index = Record<string, StoredShare>
const TOKEN_RE = /^[a-f0-9]{48}$/

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
  const { path: _path, treeDir: _treeDir, passHash, ...rest } = s
  void _path
  void _treeDir
  return { ...rest, requiresPass: Boolean(passHash) }
}
const isExpired = (s: StoredShare): boolean => s.expiresAt != null && Date.now() > s.expiresAt
const isExhausted = (s: StoredShare): boolean => s.maxUses != null && s.uses >= s.maxUses

// Remove expired shares (delete their zip). Persists only if something changed. Called on
// read paths so dead links self-clean. Exhausted links are KEPT (admin sees "used up").
async function removeArtifacts(s: StoredShare): Promise<void> {
  await rm(s.path, { force: true }).catch(() => {})
  await rm(s.treeDir, { recursive: true, force: true }).catch(() => {})
}

async function sweep(idx: Index): Promise<Index> {
  let changed = false
  for (const [tok, s] of Object.entries(idx)) {
    if (isExpired(s)) {
      delete idx[tok]
      changed = true
      await removeArtifacts(s)
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
  const { zipPath, bundleDir, fileName, summary, cleanup } = await buildClientLoadout({ includeUe4ss: opts.includeUe4ss })
  try {
    const token = randomBytes(24).toString('hex')
    const dir = sharesDir()
    await mkdir(dir, { recursive: true })
    const dest = join(dir, `${token}.zip`)
    await copyFile(zipPath, dest) // cross-device safe (temp /tmp → game volume)
    const treeDir = join(dir, token) // extracted tree (for FSA per-file serving)
    await cp(bundleDir, treeDir, { recursive: true })
    const host = opts.connectHost?.trim()
    const pass = opts.passphrase?.trim() || null
    const stored: StoredShare = {
      token,
      fileName,
      path: dest,
      treeDir,
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
  if (!TOKEN_RE.test(token)) return null
  const s = (await sweep(await readIndex()))[token]
  return s ? publicView(s) : null
}

export type ShareReason = 'notfound' | 'exhausted' | 'badpass'

// The one gate: validate token + passphrase, enforce expiry/exhaustion, and OPTIONALLY count
// a use. Expired links are swept → 'notfound'. Shared by every friend-facing access.
async function authorize(
  token: string,
  pass: string | null,
  count: boolean,
): Promise<{ ok: true; s: StoredShare } | { ok: false; reason: ShareReason }> {
  if (!TOKEN_RE.test(token)) return { ok: false, reason: 'notfound' }
  const idx = await sweep(await readIndex())
  const s = idx[token]
  if (!s) return { ok: false, reason: 'notfound' }
  if (isExhausted(s)) return { ok: false, reason: 'exhausted' }
  if (!passOk(s, pass)) return { ok: false, reason: 'badpass' }
  if (count) {
    s.uses += 1
    await writeIndex(idx)
  }
  return { ok: true, s }
}

export type DownloadPrep =
  | { ok: true; path: string; fileName: string; sizeBytes: number }
  | { ok: false; reason: ShareReason }

// Authorize a zip download, counting the use. Path server-resolved from the token.
export async function prepareDownload(token: string, pass: string | null): Promise<DownloadPrep> {
  const a = await authorize(token, pass, true)
  if (!a.ok) return a
  return { ok: true, path: a.s.path, fileName: a.s.fileName, sizeBytes: a.s.sizeBytes }
}

// Validate WITHOUT counting a use — the page's pre-download / passphrase check.
export async function checkShare(token: string, pass: string | null): Promise<{ ok: boolean; reason?: ShareReason }> {
  const a = await authorize(token, pass, false)
  return a.ok ? { ok: true } : { ok: false, reason: a.reason }
}

// ── FSA per-file serving (docs/specs/client-mod-sync.md §5.2) ─────────────────
// The manifest (relative paths under game/) — counts ONE use (a sync = one download).
export async function shareFiles(
  token: string,
  pass: string | null,
): Promise<{ ok: true; files: string[] } | { ok: false; reason: ShareReason }> {
  const a = await authorize(token, pass, true)
  if (!a.ok) return a
  try {
    const list = await readFile(join(a.s.treeDir, 'installed-files.txt'), 'utf8')
    const files = list.split('\n').map((l) => l.trim()).filter(Boolean)
    return { ok: true, files }
  } catch {
    return { ok: false, reason: 'notfound' }
  }
}

// One file's absolute path, path-safe under the share's game/ tree (the `rel` comes from the
// client). Does NOT count a use — the manifest fetch already did. Gated by token+pass.
export async function shareFilePath(
  token: string,
  rel: string,
  pass: string | null,
): Promise<{ ok: true; absPath: string } | { ok: false; reason: ShareReason }> {
  const a = await authorize(token, pass, false)
  if (!a.ok) return a
  const gameRoot = resolve(join(a.s.treeDir, 'game'))
  const abs = resolve(join(gameRoot, rel))
  if (abs !== gameRoot && !abs.startsWith(gameRoot + sep)) return { ok: false, reason: 'notfound' }
  try {
    if (!(await stat(abs)).isFile()) return { ok: false, reason: 'notfound' }
  } catch {
    return { ok: false, reason: 'notfound' }
  }
  return { ok: true, absPath: abs }
}

export async function deleteShare(token: string): Promise<void> {
  const idx = await readIndex()
  const s = idx[token]
  if (!s) return
  delete idx[token]
  await writeIndex(idx)
  await removeArtifacts(s)
}

export async function revokeAll(): Promise<{ removed: number }> {
  const idx = await readIndex()
  const entries = Object.values(idx)
  for (const s of entries) await removeArtifacts(s)
  await writeIndex({})
  return { removed: entries.length }
}
