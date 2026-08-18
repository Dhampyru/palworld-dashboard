import { readUe4ssStatus } from '@/lib/game-mods'
import { readPalSchemaStatus } from '@/lib/palschema'

// PATCH (not upstream): framework update CHECKS for UE4SS + PalSchema (docs/specs/
// framework-updates.md). Regular mods (Nexus/Steam) already have update detection; the
// frameworks did not. PalSchema is clean semver (a hard "update available" flag); UE4SS
// tracks a ROLLING tag whose version/sha don't map cleanly to the installed banner, so it's
// presented INFORMATIONALLY (latest release + link) with no false badge. GitHub's
// unauthenticated API is 60/hr → results cached for an hour.
const UA = { Accept: 'application/vnd.github+json', 'User-Agent': 'palworld-dashboard' } as const
const TTL_MS = 60 * 60 * 1000

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
  latest: { tag: string | null; publishedAt: string | null; url: string | null }
  // null = "can't reliably tell" (rolling tag). Never a false positive.
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
  return {
    installed: { version: st.version, sha: st.sha, source: st.source },
    latest: {
      tag: (rel?.tag_name as string) ?? (rel?.name as string) ?? null,
      publishedAt: (rel?.published_at as string) ?? null,
      url: (rel?.html_url as string) ?? null,
    },
    updateAvailable: null, // rolling tag — version/sha don't map to the banner; no false badge
    note: 'UE4SS tracks a rolling tag; check the release notes to decide if an update is needed.',
  }
}

let cache: { at: number; data: FrameworkUpdates } | null = null

export async function checkFrameworkUpdates(force = false): Promise<FrameworkUpdates> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.data
  const [ue4ss, palschema] = await Promise.all([checkUe4ss(), checkPalSchema()])
  const data: FrameworkUpdates = { ue4ss, palschema, checkedAt: new Date().toISOString() }
  cache = { at: Date.now(), data }
  return data
}
