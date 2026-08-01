import type { Player, ServerConfig } from './types'

interface RawPlayer extends Partial<Player> {
  nickname?: string
  player_uid?: string
  playerUid?: string
  user_id?: string
  account_name?: string
  locationX?: number
  locationY?: number
  // PATCH (not upstream): the game's own REST API returns this field as "iP"
  // (capital P) -- an inconsistent casing choice on Palworld's own part, not
  // ours. JS property access is case-sensitive, so without this the field
  // silently never populated despite the raw data actually containing it.
  iP?: string
}

function extractPlayerList(payload: unknown): unknown[] {
  if (Array.isArray(payload)) {
    return payload
  }

  if (Array.isArray((payload as { players?: unknown[] } | null)?.players)) {
    return (payload as { players: unknown[] }).players
  }

  return []
}

export type PalworldApiConfig = Pick<ServerConfig, 'serverIp' | 'restApiPort' | 'adminPassword' | 'instanceId'>

export const PALWORLD_PROXY_HEADERS = {
  serverIp: 'x-palworld-server-ip',
  serverPort: 'x-palworld-server-port',
  adminPassword: 'x-palworld-admin-password',
  // Multi-instance (#7): selects which registered server this request targets.
  // Absent → 'default' (the live Palkatraz server) — see lib/instances.ts.
  instance: 'x-palworld-instance',
} as const

export function buildPalworldProxyPath(endpoint: string) {
  return `/api/palworld/${endpoint.replace(/^\/+/, '')}`
}

export function buildPalworldProxyHeaders(config: PalworldApiConfig): HeadersInit {
  return {
    [PALWORLD_PROXY_HEADERS.serverIp]: config.serverIp.trim(),
    [PALWORLD_PROXY_HEADERS.serverPort]: config.restApiPort.trim(),
    [PALWORLD_PROXY_HEADERS.adminPassword]: config.adminPassword,
    // Only sent when an instance is selected; routes default to 'default'.
    ...(config.instanceId ? { [PALWORLD_PROXY_HEADERS.instance]: config.instanceId } : {}),
  }
}

export function getPlayerKey(player: Pick<Player, 'name' | 'playerId' | 'userId'>) {
  return player.userId || player.playerId || player.name
}

export function normalizePlayersPayload(payload: unknown): Player[] {
  return extractPlayerList(payload)
    .map((item) => {
      const player = item as RawPlayer

      return {
        name: player.name ?? player.nickname ?? 'Unknown Player',
        accountName: player.accountName ?? player.account_name ?? '',
        playerId: player.playerId ?? player.player_uid ?? player.playerUid ?? '',
        userId: player.userId ?? player.user_id ?? '',
        ip: player.ip ?? player.iP ?? '',
        ping: Number(player.ping ?? 0),
        location_x: Number(player.location_x ?? player.locationX ?? 0),
        location_y: Number(player.location_y ?? player.locationY ?? 0),
        level: Number(player.level ?? 0),
      }
    })
}
