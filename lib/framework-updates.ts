import { readFile, writeFile } from 'node:fs/promises'
import { readUe4ssStatus } from '@/lib/game-mods'
import { readPalSchemaStatus } from '@/lib/palschema'
import { fetchWorkshopUpdateTimes } from '@/lib/steam'

// PATCH (not upstream): framework update CHECKS for UE4SS + PalSchema (docs/specs/
// framework-updates.md). Regular mods (Nexus/Steam) already have update detection; the
// frameworks did not. PalSchema is clean semver (a hard "update available" flag); UE4SS
// tracks a ROLLING tag whose version/sha don't map cleanly to the installed banner, so it's
// presented INFORMATIONALLY (latest release + link) with no false badge. GitHub's
// unauthenticated API is 60/hr → results cached for an hour.
const UA = { Accept: 'application/vnd.github+json', 'User-Agent': 'palworld-dashboard' } as const
const TTL_MS = 60 * 60 * 1000

// Okaetsu's experimental-palworld UE4SS is published on the Steam Workshop as this item; its
// `time_updated` is the RELIABLE "is a newer build out?" signal (the GitHub tag is rolling and
// its version/sha don't map to the installed banner). Verified 2026-08-19: the community dwmapi
// build and this Workshop package are the SAME binary (SHA c838a8ac). A newer build here is the
// thing that could let BPModLoaderMod / LogicMods load again on an updated game — see the
// ue4ss-boot-crash note. Instance-agnostic baseline (default instance is the live one).
const UE4SS_WORKSHOP_ITEM = '3625223587'
const UE4SS_BASELINE_FILE = './data/ue4ss-update-baseline.json'

async function readUe4ssBaseline(): Promise<number | null> {
  try {
    const j = JSON.parse(await readFile(UE4SS_BASELINE_FILE, 'utf8')) as { baselineAt?: number }
    return typeof j.baselineAt === 'number' ? j.baselineAt : null
  } catch {
    return null
  }
}
async function writeUe4ssBaseline(baselineAt: number): Promise<void> {
  await writeFile(UE4SS_BASELINE_FILE, JSON.stringify({ baselineAt, setAt: new Date().toISOString() }, null, 2), 'utf8')
}

export type PalSchemaUpdate = {
  installed: string | null
  installedFlag: boolean
  latest: string | null
  publishedAt: string | null
  url: string | null
  updateAvailable: boolean
}
export type Ue4ssUpdate = {
  installed: { version: string | null; sha: string | null; source: string | null }
  // `basedOn` = the Palworld engine version the build targets, best-effort scraped from the release
  // notes ("engine edits in 0.4.1.5"); null when the notes don't state one.
  latest: { tag: string | null; publishedAt: string | null; url: string | null; basedOn: string | null }
  // Reliable Workshop-time comparison (experimental-palworld only): is a newer build published?
  workshop: {
    itemId: string
    baselineAt: number | null // time_updated (epoch s) of the build we consider installed
    latestAt: number | null // live time_updated of the Workshop item
    updateAvailable: boolean
  } | null
  // Workshop check drives this when present; else null = "can't reliably tell" (rolling tag).
  updateAvailable: boolean | null
  note: string
}
export type FrameworkUpdates = { ue4ss: Ue4ssUpdate; palschema: PalSchemaUpdate; checkedAt: string }

// Compare dotted numeric versions ("0.6.1" vs "0.6.3"). Non-numeric segments sort low.
function cmpSemver(a: string, b: string): number {
  const pa = a.replace(/^v/i, '').split('.').map((n) => parseInt(n, 10))
  const pb = b.replace(/^v/i, '').split('.').map((n) => parseInt(n, 10))
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = Number.isFinite(pa[i]) ? pa[i] : 0
    const y = Number.isFinite(pb[i]) ? pb[i] : 0
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

// Best-effort: pull the Palworld engine version a UE4SS build targets out of its release notes,
// e.g. "engine edits in 0.4.1.5" → "0.4.1.5". Okaetsu-specific phrasing; null when not found.
function parseBasedOn(body: string | null | undefined): string | null {
  if (!body) return null
  const m = /engine edits in\s+v?(\d+(?:\.\d+)+)/i.exec(body)
  return m ? m[1]! : null
}

async function ghJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(url, { headers: UA, cache: 'no-store', signal: AbortSignal.timeout(10_000) })
    if (!r.ok) return null
    return (await r.json()) as Record<string, unknown>
  } catch {
    return null
  }
}

async function checkPalSchema(): Promise<PalSchemaUpdate> {
  const st = await readPalSchemaStatus()
  const installed = st.version
  const rel = await ghJson('https://api.github.com/repos/Okaetsu/PalSchema/releases/latest')
  const latest = (rel?.tag_name as string) ?? null
  return {
    installed,
    installedFlag: st.installed,
    latest,
    publishedAt: (rel?.published_at as string) ?? null,
    url: (rel?.html_url as string) ?? null,
    updateAvailable: Boolean(st.installed && installed && latest && cmpSemver(latest, installed) > 0),
  }
}

async function checkUe4ss(): Promise<Ue4ssUpdate> {
  const st = await readUe4ssStatus()
  // Resolve the release feed for the installed line.
  const feed =
    st.source === 'experimental-palworld'
      ? 'https://api.github.com/repos/Okaetsu/RE-UE4SS/releases/tags/experimental-palworld'
      : st.source === 'beta'
        ? 'https://api.github.com/repos/UE4SS-RE/RE-UE4SS/releases/tags/experimental-latest'
        : 'https://api.github.com/repos/UE4SS-RE/RE-UE4SS/releases/latest'
  const rel = await ghJson(feed)

  // Reliable signal for the experimental-palworld line: compare the Workshop item's live
  // time_updated against a stored baseline (the build we consider installed). First run seeds
  // the baseline to the current live time — right now the installed build IS the latest, so
  // that reads "up to date"; a future Okaetsu build then flips updateAvailable to true.
  let workshop: Ue4ssUpdate['workshop'] = null
  if (st.source === 'experimental-palworld') {
    const times = await fetchWorkshopUpdateTimes([UE4SS_WORKSHOP_ITEM])
    const latestAt = times[UE4SS_WORKSHOP_ITEM]?.timeUpdated ?? null
    let baselineAt = await readUe4ssBaseline()
    if (baselineAt == null && latestAt != null) {
      baselineAt = latestAt
      await writeUe4ssBaseline(baselineAt)
    }
    workshop = {
      itemId: UE4SS_WORKSHOP_ITEM,
      baselineAt,
      latestAt,
      updateAvailable: Boolean(latestAt != null && baselineAt != null && latestAt > baselineAt),
    }
  }

  return {
    installed: { version: st.version, sha: st.sha, source: st.source },
    latest: {
      tag: (rel?.tag_name as string) ?? (rel?.name as string) ?? null,
      publishedAt: (rel?.published_at as string) ?? null,
      url: (rel?.html_url as string) ?? null,
      basedOn: parseBasedOn(rel?.body as string | undefined),
    },
    workshop,
    updateAvailable: workshop ? workshop.updateAvailable : null,
    note: workshop
      ? workshop.updateAvailable
        ? 'A newer experimental-palworld UE4SS build is published — updating may let BPModLoaderMod (Blueprint/LogicMods) load again on the current game.'
        : 'UE4SS matches the latest experimental-palworld build; nothing to do.'
      : 'UE4SS tracks a rolling tag; check the release notes to decide if an update is needed.',
  }
}

// Re-baseline to the current live Workshop time — call after swapping UE4SS, or from the
// "mark as up to date" button once the operator has updated. Clears the flag until the next
// Okaetsu build. Best-effort: if the Steam call fails the baseline is left unchanged.
export async function markUe4ssUpdateInstalled(): Promise<{ baselineAt: number | null }> {
  const times = await fetchWorkshopUpdateTimes([UE4SS_WORKSHOP_ITEM])
  const latestAt = times[UE4SS_WORKSHOP_ITEM]?.timeUpdated ?? null
  if (latestAt != null) await writeUe4ssBaseline(latestAt)
  cache = null // force a fresh check on the next read
  return { baselineAt: latestAt }
}

// After a UE4SS ROLLBACK to an older build, force the update check to report that a newer build
// exists (baseline 0 = "older than any Workshop update") so the card stops falsely reading "up to
// date" while on the rolled-back build. Cleared by the next successful update (which re-baselines).
export async function markUe4ssRolledBack(): Promise<void> {
  await writeUe4ssBaseline(0)
  cache = null
}

let cache: { at: number; data: FrameworkUpdates } | null = null

export async function checkFrameworkUpdates(force = false): Promise<FrameworkUpdates> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.data
  const [ue4ss, palschema] = await Promise.all([checkUe4ss(), checkPalSchema()])
  // Lockstep guard: UE4SS + PalSchema are version-locked. If a newer UE4SS build exists AND
  // PalSchema is installed, warn — a UE4SS swap sets PalSchema aside (it's an ABI-locked C++ mod)
  // and needs a MATCHING PalSchema for the new build, or the server crash-loops. Don't update alone.
  if (ue4ss.workshop?.updateAvailable && palschema.installedFlag) {
    ue4ss.note =
      'A newer UE4SS build exists — but PalSchema is installed and version-locked to UE4SS. Updating ' +
      'UE4SS alone sets PalSchema aside (ABI-locked) and can crash-loop until a MATCHING PalSchema is ' +
      'installed. Only update when a compatible PalSchema exists, and update the pair together.'
  }
  const data: FrameworkUpdates = { ue4ss, palschema, checkedAt: new Date().toISOString() }
  cache = { at: Date.now(), data }
  return data
}
