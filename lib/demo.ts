import type { FpsSample, Player, ServerInfo, ServerMetrics } from './types'

export const demoConfig = {
  serverIp: 'demo.local',
  restApiPort: '8212',
  gamePort: '8211',
  adminPassword: 'demo',
  accessTier: 'admin' as const,
}

export const demoServerInfo: ServerInfo = {
  version: '0.6.6-demo',
  servername: 'Demo Palworld Server',
  description: 'Read-only sample data for the public dashboard demo.',
  worldguid: 'demo-world',
}

export const demoPlayers: Player[] = [
  { name: 'LamballPilot', accountName: 'lamball', playerId: '101', userId: 'steam_demo_101', ip: '127.0.0.1', ping: 28, location_x: 1450, location_y: -820, level: 37 },
  { name: 'CattivaOps', accountName: 'cattiva', playerId: '102', userId: 'steam_demo_102', ip: '127.0.0.1', ping: 44, location_x: -360, location_y: 980, level: 22 },
  { name: 'AnubisAdmin', accountName: 'anubis', playerId: '103', userId: 'steam_demo_103', ip: '127.0.0.1', ping: 19, location_x: 720, location_y: 260, level: 50 },
]

export const demoMetrics: ServerMetrics = {
  serverfps: 58,
  currentplayernum: demoPlayers.length,
  maxplayernum: 32,
  serverframetime: 17.2,
  uptime: 345600,
  days: 128,
  basecampnum: 8,
}

export const demoSettings = {
  ServerName: demoServerInfo.servername,
  Difficulty: 'Normal',
  ServerPlayerMaxNum: demoMetrics.maxplayernum,
  DeathPenalty: 'Item',
  BaseCampMaxNum: demoMetrics.basecampnum,
  RESTAPIEnabled: true,
}

export function getDemoFpsHistory(now = Date.now()): FpsSample[] {
  return Array.from({ length: 120 }, (_, index) => {
    const phase = index / 8
    return {
      timestamp: now - (119 - index) * 30_000,
      fps: Math.round((55 + Math.sin(phase) * 4 + Math.cos(phase / 2) * 2) * 10) / 10,
    }
  })
}

// ── Saves & backups (demo) ───────────────────────────────────────────────────
export const DEMO_WORLD_ID = 'DemoWorld000000000000000000000001'

export const demoWorlds = [
  { id: DEMO_WORLD_ID, active: true, sizeBytes: 48_318_382, modifiedAt: '2026-08-02T09:14:00.000Z', playerCount: 3 },
  { id: 'ArchivedWorld00000000000000000002', active: false, sizeBytes: 21_004_112, modifiedAt: '2026-07-20T22:03:00.000Z', playerCount: 2 },
]

export const demoBackups = [
  { file: 'palworld-save-auto-20260802T060000Z.tar.gz', sizeBytes: 44_112_880, modifiedAt: '2026-08-02T06:00:00.000Z' },
  { file: 'palworld-save-daily-20260801T060000Z.tar.gz', sizeBytes: 43_882_104, modifiedAt: '2026-08-01T06:00:00.000Z' },
  { file: 'palworld-save-manual-20260731T181500Z.tar.gz', sizeBytes: 43_501_233, modifiedAt: '2026-07-31T18:15:00.000Z' },
]

// A player's .sav filename is 8 significant hex chars + zero padding to 32.
// The saves panel's uidToUuid() turns that into the dashed UUID used as the
// world player's uid, so these must correlate for the Inspect dialog to match.
export const DEMO_PLAYER_HEX = '1a2b3c4d000000000000000000000000'
const DEMO_PLAYER_UUID = '1a2b3c4d-0000-0000-0000-000000000000'
const DEMO_PLAYER2_HEX = '9f8e7d6c000000000000000000000000'
const DEMO_PLAYER2_UUID = '9f8e7d6c-0000-0000-0000-000000000000'

export const demoPlayerSaves = [
  { playerUid: DEMO_PLAYER_HEX, sizeBytes: 18_742, modifiedAt: '2026-08-02T09:10:00.000Z' },
  { playerUid: DEMO_PLAYER2_HEX, sizeBytes: 12_310, modifiedAt: '2026-08-01T20:44:00.000Z' },
]

// World inspection (Level.sav via psp-inspect): players, guilds, every Pal.
export const demoWorldInspection = {
  worldId: DEMO_WORLD_ID,
  players: [
    { uid: DEMO_PLAYER_UUID, nickname: 'LamballPilot', level: 37, pal_count: 3, guild_id: 'guild-001' },
    { uid: DEMO_PLAYER2_UUID, nickname: 'CattivaOps', level: 22, pal_count: 2, guild_id: 'guild-001' },
  ],
  guilds: [
    { id: 'guild-001', name: 'Dawnbreakers', admin_player_uid: DEMO_PLAYER_UUID, player_count: 2 },
  ],
  pals: [
    { instance_id: 'pal-0001', character_id: 'ChickenPal', character_key: 'ChickenPal', nickname: 'Cluck', owner_uid: DEMO_PLAYER_UUID, gender: 'Female', level: 15 },
    { instance_id: 'pal-0002', character_id: 'PinkCat', character_key: 'PinkCat', nickname: null, owner_uid: DEMO_PLAYER_UUID, gender: 'Male', level: 12 },
    { instance_id: 'pal-0003', character_id: 'NightFox', character_key: 'BOSS_NightFox', nickname: 'Shadow', owner_uid: DEMO_PLAYER_UUID, gender: 'Male', level: 28 },
    { instance_id: 'pal-0101', character_id: 'Melpaca', character_key: 'Melpaca', nickname: null, owner_uid: DEMO_PLAYER2_UUID, gender: 'Female', level: 19 },
    { instance_id: 'pal-0102', character_id: 'FireKitsune', character_key: 'FireKitsune', nickname: 'Blaze', owner_uid: DEMO_PLAYER2_UUID, gender: 'Male', level: 24 },
  ],
}

// Per-player inventory (psp-player) for the Inspect dialog.
export const demoInventory = {
  uid: DEMO_PLAYER_HEX,
  nickname: 'LamballPilot',
  level: 37,
  exp: 1_234_567,
  hp: 500,
  stomach: 100,
  sanity: 100,
  status_points: { max_hp: 3, max_sp: 1, attack: 2, weight: 4, capture_rate: 0, work_speed: 5 } as Record<string, number>,
  containers: [
    { kind: 'Inventory', slots: [
      { slot: 0, id: 'Wood', count: 480, category: 'Material', rarity: 0 },
      { slot: 1, id: 'Stone', count: 320, category: 'Material', rarity: 0 },
      { slot: 2, id: 'Ingot', count: 96, category: 'Material', rarity: 0 },
      { slot: 3, id: 'PalSphere', count: 42, category: 'Consumable', rarity: 1 },
    ] },
    { kind: 'Key Items', slots: [
      { slot: 0, id: 'AncientTechnologyPoint', count: 12, category: 'Material', rarity: 2 },
    ] },
    { kind: 'Weapons', slots: [
      { slot: 0, id: 'AssaultRifle', count: 1, category: 'Weapon', rarity: 2, durability: 180 },
    ] },
    { kind: 'Equipment', slots: [
      { slot: 0, id: 'MetalHelmet', count: 1, category: 'Head', rarity: 1, durability: 200 },
      { slot: 1, id: 'RefinedMetalArmor', count: 1, category: 'Body', rarity: 2, durability: 240 },
    ] },
    { kind: 'Food', slots: [
      { slot: 0, id: 'CookedMeat', count: 8, category: 'Food', rarity: 0 },
    ] },
  ],
}

// ── Guilds & Players (demo exportguilds) ─────────────────────────────────────
export const demoGuilds = [
  {
    id: 'guild-001', name: 'Dawnbreakers', adminId: DEMO_PLAYER_UUID, adminName: 'LamballPilot',
    level: 14, campNum: 3, campNumTotal: 7, memberCount: 2,
    members: [
      { id: DEMO_PLAYER_UUID, nickName: 'LamballPilot', level: 37, exp: 1_234_567, worldPosition: { x: 1450, y: -820, z: 120 }, mapPosition: { x: 340, y: 210 }, lastOnline: '2026-08-02T09:10:00.000Z' },
      { id: DEMO_PLAYER2_UUID, nickName: 'CattivaOps', level: 22, exp: 456_789, worldPosition: { x: -360, y: 980, z: 80 }, mapPosition: { x: 120, y: 410 }, lastOnline: '2026-08-01T20:44:00.000Z' },
    ],
    expeditionsFinished: 5, expeditionsUnlocked: 8,
  },
  {
    id: 'guild-002', name: 'Lone Wolves', adminId: 'aaaabbbb-0000-0000-0000-000000000000', adminName: 'AnubisAdmin',
    level: 9, campNum: 1, campNumTotal: 7, memberCount: 1,
    members: [
      { id: 'aaaabbbb-0000-0000-0000-000000000000', nickName: 'AnubisAdmin', level: 50, exp: 9_999_999, worldPosition: { x: 720, y: 260, z: 60 }, mapPosition: { x: 260, y: 300 }, lastOnline: '2026-08-02T08:00:00.000Z' },
    ],
    expeditionsFinished: 2, expeditionsUnlocked: 6,
  },
]

// ── Fleet / instances (demo) ─────────────────────────────────────────────────
export const demoInstances = [
  { id: 'default', displayName: 'Demo Server', isDefault: true, enabled: true, ports: { game: 8211, query: 27015, rcon: 25575, rest: 8212, paldefender: 17993 }, running: true, status: 'running', memBytes: 9_650_000_000, startedAt: '2026-08-02T05:00:00.000Z' },
  { id: 'creative', displayName: 'Creative Sandbox', isDefault: false, enabled: true, ports: { game: 8311, query: 27016, rcon: 25576, rest: 8312, paldefender: 17994 }, running: false, status: 'exited', memBytes: null as number | null, startedAt: null as string | null },
]
