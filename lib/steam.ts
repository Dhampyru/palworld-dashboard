import { mkdir, readFile, rm, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { currentGameDir } from '@/lib/instances'

const execFileP = promisify(execFile)

// PATCH (not upstream): Steam Workshop mod downloads via SteamCMD (docs/specs/
// steam-workshop-download.md). SESSION-TOKEN-ONLY by design: the operator connects
// once with username + password + a Steam Guard code; SteamCMD caches a session in
// STEAM_HOME (the /app/data volume) and we persist ONLY the username. The password
// is used for that single login and never stored — a compromised host leaks a
// session token, not the account password. Later downloads reuse the cached session
// non-interactively until it expires, when the operator reconnects.
//
// SteamCMD runs as the non-root nextjs user (uid 2001) — running it as root breaks
// a real account's Steam-cloud writes (verified). Anonymous cannot fetch Workshop
// content for a paid game, so this is the owning-account path: opt-in, admin-only,
// and best used with a DEDICATED secondary account that owns Palworld.

const STEAMCMD = process.env.STEAMCMD_PATH ?? '/opt/steamcmd/steamcmd.sh'
const STEAM_HOME = process.env.STEAM_HOME ?? '/app/data/steam'
const STEAM_ACCOUNT_FILE = process.env.STEAM_ACCOUNT_FILE ?? '/app/data/steam-account.json'
export const PALWORLD_APPID = '1623730'

export type SteamStatus = {
  configured: boolean // a username is saved (a successful connect happened)
  connected: boolean // we believe the cached session is usable (validated lazily on download / Test)
  username: string | null
  error: string | null
}

type StoredAccount = { username?: string; connectedAt?: string }
export type LoginResult = 'ok' | 'needs_guard' | 'bad_credentials' | 'rate_limited' | 'error'

async function readAccount(): Promise<StoredAccount | null> {
  try {
    const j = JSON.parse(await readFile(STEAM_ACCOUNT_FILE, 'utf8')) as StoredAccount
    return j.username?.trim() ? j : null
  } catch {
    return null
  }
}

// The account name SteamCMD cached in its own session config — the source of truth
// (independent of our little account file, which can get out of sync). Lets a
// cached session drive status/downloads even if steam-account.json is missing.
async function readSessionUsername(): Promise<string | null> {
  try {
    const vdf = await readFile(join(STEAM_HOME, 'Steam', 'config', 'config.vdf'), 'utf8')
    const m = vdf.match(/"Accounts"\s*\{\s*"([^"]+)"/i)
    return m ? m[1] : null
  } catch {
    return null
  }
}

// Prefer the SteamCMD session's account; fall back to our stored username.
async function resolveUsername(): Promise<string | null> {
  return (await readSessionUsername()) ?? (await readAccount())?.username ?? null
}

// Forget the account AND drop the cached session (so nothing authenticates after).
export async function clearSteamAccount(): Promise<void> {
  await rm(STEAM_ACCOUNT_FILE, { force: true }).catch(() => {})
  await rm(join(STEAM_HOME, 'Steam', 'config', 'config.vdf'), { force: true }).catch(() => {})
  await rm(STEAM_HOME, { recursive: true, force: true }).catch(() => {})
}

// SteamCMD colorizes its output (e.g. `Waiting for user info...\x1b[0mOK`), which
// otherwise breaks the status regexes below — strip ANSI escape sequences first.
function stripAnsi(s: string): string {
  const esc = String.fromCharCode(27) // avoid a literal control char in source
  return s.replace(new RegExp(esc + '\\[[0-9;?]*[ -/]*[@-~]', 'g'), '')
}

// Run SteamCMD with the persistent HOME so it reuses/writes the cached session.
// Never throws on a non-zero exit — SteamCMD exits non-zero on a Guard-required
// login, which is a normal branch here. Returns combined stdout+stderr (ANSI-stripped).
async function runSteamcmd(args: string[], timeoutMs = 120_000): Promise<string> {
  await mkdir(STEAM_HOME, { recursive: true })
  try {
    const { stdout, stderr } = await execFileP(STEAMCMD, args, {
      env: { ...process.env, HOME: STEAM_HOME },
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    })
    return stripAnsi(`${stdout}\n${stderr}`)
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string }
    return stripAnsi(`${err.stdout ?? ''}\n${err.stderr ?? ''}\n${err.message ?? ''}`)
  }
}

// Classify a SteamCMD login transcript into a coarse result. The reliable success
// marker is the login RESPONSE line ("… to Steam Public...OK") — NOT a blanket
// "no FAILED anywhere" (bootstrap output contains unrelated "failed" lines) and NOT
// "Waiting for user info...OK" alone (SteamCMD injects interstitial text there).
export function classifyLogin(out: string): LoginResult {
  if (/to Steam Public\.\.\.\s*OK/i.test(out)) return 'ok'
  if (/Steam Guard|Two[- ]?factor|mobile authenticator/i.test(out)) return 'needs_guard'
  if (/Invalid Password|password.*incorrect|InvalidPassword|two[- ]?factor code mismatch/i.test(out))
    return 'bad_credentials'
  if (/Rate ?Limit/i.test(out)) return 'rate_limited'
  if (/to Steam Public\.\.\.\s*FAILED/i.test(out)) return 'bad_credentials'
  return 'error'
}

// NOTE: the in-dashboard password + Steam Guard connect flow was removed (2026-08-01).
// Email Steam Guard can't be done over a stateless 2-step web form — each submit is a
// fresh SteamCMD process that triggers a NEW code, so codes go stale in a loop, and a
// failed attempt can corrupt the cached session. Connecting is now a one-time
// interactive shell login (single session), documented in the Settings UI:
//   docker exec -it -e HOME=/app/data/steam palworld-server-dashboard \
//     /opt/steamcmd/steamcmd.sh +login <username> +quit
// It caches the session into STEAM_HOME, which getSteamStatus/validate/download read.
// The operator's password never touches the dashboard/browser.

// Real session check (spawns SteamCMD) — for an explicit "Test" and after a failed
// download. Uses the saved username with NO password: a valid cached session logs
// in; otherwise it can't and reports not-connected.
export async function validateSteamSession(): Promise<boolean> {
  const username = await resolveUsername()
  if (!username) return false
  const out = await runSteamcmd(['+login', username, '+quit'], 60_000)
  return classifyLogin(out) === 'ok'
}

// Cheap status for polling — does NOT spawn SteamCMD. Reads the account from the
// SteamCMD session (config.vdf), so a cached session shows connected even if our
// steam-account.json was removed. True validity is confirmed lazily (Test/download).
export async function getSteamStatus(): Promise<SteamStatus> {
  const sessionUser = await readSessionUsername()
  const username = sessionUser ?? (await readAccount())?.username ?? null
  if (!username) return { configured: false, connected: false, username: null, error: null }
  return {
    configured: true,
    connected: Boolean(sessionUser),
    username,
    error: sessionUser ? null : 'Cached session missing — reconnect.',
  }
}

// Framework Workshop items the operator already has via the proxy stack — installing
// the Workshop copy would be redundant (UE4SS) or clobber the existing install
// (PalSchema + its sub-mods). Blocked by id (fast) and by PackageName (robust; see
// game-mods.installWorkshopPackageToProxy).
export const FRAMEWORK_WORKSHOP_IDS = new Set(['3625223587', '3625280368']) // UE4SSExperimentalPW, PalSchema
export function isFrameworkWorkshopId(id: string): boolean {
  return FRAMEWORK_WORKSHOP_IDS.has(id.trim())
}

// Accept a full Workshop URL (…/sharedfiles/filedetails/?id=<digits>) or a bare id.
export function parseWorkshopId(input: string): string | null {
  const s = input.trim()
  if (/^\d+$/.test(s)) return s
  const m = s.match(/[?&]id=(\d+)/) || s.match(/filedetails\/\?id=(\d+)/)
  return m ? m[1] : null
}

// Download one Workshop item with the cached session, into the game dir's
// steamapps/workshop/content/<appid>/<id>/ — exactly where the Workshop-layout
// loader (WorkshopRootDir) looks. Reads the item's Info.json for its PackageName.
// Throws with a clear message on an expired session or a failed download.
export async function downloadWorkshopItem(
  itemId: string,
): Promise<{ contentDir: string; packageName: string | null; modName: string | null }> {
  const username = await resolveUsername()
  if (!username) throw new Error('Connect a Steam account first (Panel Settings → Steam).')
  const out = await runSteamcmd(
    [
      '+force_install_dir',
      currentGameDir(),
      '+login',
      username,
      '+workshop_download_item',
      PALWORLD_APPID,
      itemId,
      '+quit',
    ],
    300_000,
  )
  if (classifyLogin(out) !== 'ok') {
    throw new Error('Steam session expired — reconnect the account (Panel Settings → Steam).')
  }
  if (!/Downloaded item\s+\d+/i.test(out)) {
    const m = out.match(/ERROR!\s*Download item \d+ failed \(([^)]+)\)/i)
    throw new Error(`Workshop download failed${m ? `: ${m[1]}` : ''}.`)
  }
  const contentDir = join(currentGameDir(), 'steamapps', 'workshop', 'content', PALWORLD_APPID, itemId)
  let packageName: string | null = null
  let modName: string | null = null
  try {
    const info = JSON.parse((await readFile(join(contentDir, 'Info.json'), 'utf8')).replace(/^\uFEFF/, '')) as {
      PackageName?: string
      ModName?: string
    }
    packageName = typeof info.PackageName === 'string' ? info.PackageName : null
    modName = typeof info.ModName === 'string' ? info.ModName : null
  } catch {
    /* no Info.json — not a server-installable package */
  }
  return { contentDir, packageName, modName }
}

// ── Workshop update detection (docs/specs/steam-workshop-download.md §7) ──────
// Steam Workshop exposes an update TIMESTAMP, not a version string. The installed
// baseline is already on disk — SteamCMD records each item's `timeupdated` in
// `steamapps/workshop/appworkshop_<appid>.acf` — so no install-time bookkeeping is
// needed. Compare it to the item's live `time_updated` from Steam's public API.

// Parse the acf (a Valve VDF) for `timeupdated` per workshop id. Line-scan: an id is a
// line that is just "<digits>"; the following `"timeupdated" "<n>"` is its value. Both
// WorkshopItemsInstalled and WorkshopItemDetails list it (same value) — last wins.
export async function readInstalledWorkshopTimes(): Promise<Record<string, number>> {
  const acf = join(currentGameDir(), 'steamapps', 'workshop', `appworkshop_${PALWORLD_APPID}.acf`)
  let text: string
  try {
    text = await readFile(acf, 'utf8')
  } catch {
    return {} // no acf → nothing installed via SteamCMD here
  }
  const out: Record<string, number> = {}
  let id: string | null = null
  for (const line of text.split(/\r?\n/)) {
    const idm = line.match(/^\s*"(\d{6,})"\s*$/)
    if (idm) {
      id = idm[1]
      continue
    }
    const tm = line.match(/"timeupdated"\s*"(\d+)"/i)
    if (tm && id) out[id] = Number(tm[1])
  }
  return out
}

// Live last-update time (+ title) per workshop id, via the public GetPublishedFileDetails
// (no API key). Best-effort: a failed call yields {} (→ no update chips), never throws.
export async function fetchWorkshopUpdateTimes(
  ids: string[],
): Promise<Record<string, { timeUpdated: number; title: string }>> {
  const uniq = [...new Set(ids.filter(Boolean))]
  if (!uniq.length) return {}
  const body = new URLSearchParams()
  body.set('itemcount', String(uniq.length))
  uniq.forEach((id, i) => body.set(`publishedfileids[${i}]`, id))
  try {
    const res = await fetch('https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })
    if (!res.ok) return {}
    const j = (await res.json()) as {
      response?: { publishedfiledetails?: { publishedfileid: string; time_updated?: number; title?: string; result?: number }[] }
    }
    const out: Record<string, { timeUpdated: number; title: string }> = {}
    for (const d of j.response?.publishedfiledetails ?? []) {
      if (d.result === 1 && d.time_updated) out[d.publishedfileid] = { timeUpdated: d.time_updated, title: d.title ?? '' }
    }
    return out
  } catch {
    return {}
  }
}

// Workshop tags per item, via the public GetPublishedFileDetails (no API key). Used as a
// genre-category source for Steam-sourced mods. Best-effort: a failed call yields {}.
export async function fetchWorkshopTags(ids: string[]): Promise<Record<string, string[]>> {
  const uniq = [...new Set(ids.filter(Boolean))]
  if (!uniq.length) return {}
  const body = new URLSearchParams()
  body.set('itemcount', String(uniq.length))
  uniq.forEach((id, i) => body.set(`publishedfileids[${i}]`, id))
  try {
    const res = await fetch('https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })
    if (!res.ok) return {}
    const j = (await res.json()) as {
      response?: { publishedfiledetails?: { publishedfileid: string; result?: number; tags?: { tag?: string }[] }[] }
    }
    const out: Record<string, string[]> = {}
    for (const d of j.response?.publishedfiledetails ?? []) {
      if (d.result === 1) out[d.publishedfileid] = (d.tags ?? []).map((t) => String(t?.tag ?? '')).filter(Boolean)
    }
    return out
  } catch {
    return {}
  }
}

// Title + description for one workshop item, via the public GetPublishedFileDetails (no key).
// Used to mine the mod page for placement keywords (server/client/both) — the file CONTENTS
// still need a SteamCMD download, but the description is public. Null on any error.
export async function fetchWorkshopDetails(input: string): Promise<{ title: string; description: string } | null> {
  const id = parseWorkshopId(input)
  if (!id) return null
  const body = new URLSearchParams()
  body.set('itemcount', '1')
  body.set('publishedfileids[0]', id)
  try {
    const res = await fetch('https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })
    if (!res.ok) return null
    const j = (await res.json()) as {
      response?: { publishedfiledetails?: { result?: number; title?: string; file_description?: string }[] }
    }
    const d = j.response?.publishedfiledetails?.[0]
    if (!d || d.result !== 1) return null
    return { title: d.title ?? '', description: d.file_description ?? '' }
  } catch {
    return null
  }
}

// Info.json InstallRule types for a downloaded Workshop item (deep-scan placement signal).
// Lua/Paks/LogicMods = client-installable; PalSchema/UE4SS = server-side.
export async function readWorkshopInstallTypes(contentDir: string): Promise<string[]> {
  try {
    const info = JSON.parse((await readFile(join(contentDir, 'Info.json'), 'utf8')).replace(/^\uFEFF/, '')) as { InstallRule?: { Type?: string }[] }
    return (Array.isArray(info.InstallRule) ? info.InstallRule : []).map((r) => String(r?.Type ?? '')).filter(Boolean)
  } catch {
    return []
  }
}

// Purge orphaned Workshop cache dirs — items downloaded for a scan (or a failed install)
// that were never installed. An item's cache is KEPT while it's installed (its .acf powers
// update detection), so this only removes ids NOT in `installedIds`. `olderThanMs` protects
// a scan still mid-decision; `only` targets one id (immediate purge on reject). Returns the
// ids removed. Best-effort — never throws.
export async function purgeOrphanWorkshopContent(
  installedIds: Set<string>,
  opts: { olderThanMs?: number; only?: string } = {},
): Promise<string[]> {
  const base = join(currentGameDir(), 'steamapps', 'workshop', 'content', PALWORLD_APPID)
  let ids: string[]
  try {
    ids = await readdir(base)
  } catch {
    return []
  }
  const now = Date.now()
  const removed: string[] = []
  for (const id of ids) {
    if (!/^\d+$/.test(id)) continue
    if (installedIds.has(id)) continue
    if (opts.only && id !== opts.only) continue
    const dir = join(base, id)
    try {
      if (opts.olderThanMs != null) {
        const st = await stat(dir)
        if (now - st.mtimeMs < opts.olderThanMs) continue
      }
      await rm(dir, { recursive: true, force: true })
      removed.push(id)
    } catch {
      /* skip */
    }
  }
  return removed
}

export type SteamModUpdate = { installedAt: number | null; latestAt: number; updateAvailable: boolean; title: string }

// Update state per workshop id: installed (acf) vs live (Steam). updateAvailable only
// when we know both and live is strictly newer. Items we can't fetch are omitted.
export async function getSteamModUpdates(itemIds: string[]): Promise<Record<string, SteamModUpdate>> {
  const uniq = [...new Set(itemIds.filter(Boolean))]
  if (!uniq.length) return {}
  const [installed, latest] = await Promise.all([readInstalledWorkshopTimes(), fetchWorkshopUpdateTimes(uniq)])
  const out: Record<string, SteamModUpdate> = {}
  for (const id of uniq) {
    const l = latest[id]
    if (!l) continue
    const inst = installed[id] ?? null
    out[id] = { installedAt: inst, latestAt: l.timeUpdated, updateAvailable: inst != null && l.timeUpdated > inst, title: l.title }
  }
  return out
}
