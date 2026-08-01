// Combined per-tick snapshot (owner order 2026-07-14): the panel makes ONE
// request every 15s and gets metrics + players (+ the server-side FPS ring for
// admin tier) together, instead of polling separate endpoints on separate
// timers. Upstream, PalServer has no combined REST endpoint, so the two reads
// (/metrics + /players — both mod-allowlisted data) run in parallel here.
// REST cost with the panel open: 2 calls / 15s = 0.13 req/s (was 0.3 req/s
// with the separate 5s metrics + 10s roster polls).
import { Buffer } from 'node:buffer'
import { NextRequest, NextResponse } from 'next/server'
import { classifyPassword, tierForClass } from '@/lib/access-tier'
import { clientIp, isLockedOut, recordFailure } from '@/lib/rate-limit'
import { DEMO_MODE, demoFpsHistory, demoMetrics, demoPlayers } from '@/lib/demo-mode'
import { PALWORLD_PROXY_HEADERS } from '@/lib/palworld'
import { resolveInstance, resolveSecrets } from '@/lib/instances'
import { readFpsRing } from '@/lib/fps-ring'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function fetchUpstream(baseUrl: URL, endpoint: string, password: string) {
  const response = await fetch(new URL(`/v1/api/${endpoint}`, baseUrl), {
    headers: {
      Accept: 'application/json',
      Authorization: `Basic ${Buffer.from(`admin:${password}`).toString('base64')}`,
    },
    cache: 'no-store',
  })

  if (!response.ok) {
    throw new Error(`upstream ${endpoint} responded with ${response.status}`)
  }

  return response.json() as Promise<unknown>
}

// PATCH (not upstream): PalDefender enrichment (guild name, precise coords).
// Entirely optional and never blocks the rest of the snapshot -- returns null
// on ANY failure (not installed, token not configured, network error, bad
// response) rather than throwing, so a server without PalDefender behaves
// exactly as it did before this was added.
interface PalDefenderPlayer {
  Name?: string
  PlayerUID?: string
  GuildName?: string
  MapLocation?: { x?: number; y?: number; z?: number }
}

async function fetchPalDefenderPlayers(instanceId: string | null): Promise<PalDefenderPlayer[] | null> {
  const token = resolveSecrets(instanceId).paldefenderToken
  if (!token) return null
  const instance = resolveInstance(instanceId)
  if (!instance) return null
  try {
    const baseUrl = new URL(instance.paldefenderUrl)
    const response = await fetch(new URL('/v1/pdapi/players', baseUrl), {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(3000),
    })
    if (!response.ok) return null
    const data = (await response.json()) as { Players?: PalDefenderPlayer[] }
    return Array.isArray(data.Players) ? data.Players : null
  } catch {
    return null
  }
}

// Game playerId ("C15A5B1B000000000000000000000000") and PalDefender's
// PlayerUID ("C15A5B1B-00000000-00000000-00000000") are the same underlying
// ID, just formatted differently -- strip non-alphanumerics to compare.
function normalizeUid(uid: unknown): string {
  return typeof uid === 'string' ? uid.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() : ''
}

function mergePalDefenderData(playersPayload: unknown, pdPlayers: PalDefenderPlayer[] | null): unknown {
  if (!pdPlayers || pdPlayers.length === 0) return playersPayload
  if (!playersPayload || typeof playersPayload !== 'object') return playersPayload
  const payload = playersPayload as { players?: unknown[] }
  if (!Array.isArray(payload.players)) return playersPayload

  const byUid = new Map<string, PalDefenderPlayer>()
  for (const pd of pdPlayers) {
    const key = normalizeUid(pd.PlayerUID)
    if (key) byUid.set(key, pd)
  }

  const merged = payload.players.map((p) => {
    if (!p || typeof p !== 'object') return p
    const player = p as { playerId?: string }
    const pd = byUid.get(normalizeUid(player.playerId))
    if (!pd) return p
    return {
      ...player,
      guildName: pd.GuildName ?? null,
      preciseLocation:
        pd.MapLocation && typeof pd.MapLocation.x === 'number' && typeof pd.MapLocation.y === 'number'
          ? { x: pd.MapLocation.x, y: pd.MapLocation.y, z: pd.MapLocation.z ?? 0 }
          : null,
    }
  })

  return { ...payload, players: merged }
}

export async function GET(request: NextRequest) {
  // Same auth + brute-force posture as the palworld proxy route.
  const ip = clientIp(request)
  if (isLockedOut(ip)) {
    return NextResponse.json({ error: 'Too many attempts. Try again later.' }, { status: 429 })
  }

  const presented = request.headers.get(PALWORLD_PROXY_HEADERS.adminPassword) ?? ''
  const tier = tierForClass(classifyPassword(presented))
  if (tier === 'invalid') {
    recordFailure(ip)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (DEMO_MODE) {
    return NextResponse.json({
      metrics: demoMetrics(),
      players: { players: demoPlayers },
      ...(tier === 'admin' ? { fpsHistory: demoFpsHistory() } : {}),
    })
  }

  // Upstream target is PINNED server-side (same posture as the proxy route);
  // the game's real REST admin password comes from the resolved instance and
  // never reaches the client.
  const instanceId = request.headers.get(PALWORLD_PROXY_HEADERS.instance)
  const instance = resolveInstance(instanceId)
  const gameAdminPassword = resolveSecrets(instanceId).adminPassword

  if (!instance || !gameAdminPassword) {
    return NextResponse.json(
      { error: 'Server proxy is not configured (missing PALWORLD_ADMIN_PASSWORD).' },
      { status: 500 }
    )
  }
  const pinned = new URL(instance.restUrl)

  try {
    const [metrics, players, fpsHistory, pdPlayers] = await Promise.all([
      fetchUpstream(pinned, 'metrics', gameAdminPassword),
      fetchUpstream(pinned, 'players', gameAdminPassword),
      // FPS history is an admin-view feature; the mod tier gets metrics+players only.
      tier === 'admin' ? readFpsRing(instanceId) : Promise.resolve(null),
      fetchPalDefenderPlayers(instanceId),
    ])

    return NextResponse.json({
      metrics,
      players: mergePalDefenderData(players, pdPlayers),
      ...(fpsHistory ? { fpsHistory } : {}),
    })
  } catch (error) {
    console.error('Snapshot error:', error)

    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to connect to server' },
      { status: 502 }
    )
  }
}
