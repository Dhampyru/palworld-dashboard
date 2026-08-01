// PATCH (not upstream): PalWorldSettings.ini isn't line-based key=value --
// it's one long `OptionSettings=(...)` tuple where commas separate fields
// AND appear inside nested values (e.g. CrossplayPlatforms=(Steam,Xbox,PS5,Mac)).
// A naive comma-split would silently corrupt the file. This parser tracks
// quote/paren depth so nested values survive intact, and preserves every
// untouched field's exact raw formatting on write-back (verified byte-for-byte
// round-trip against real captured server output before this was trusted).
//
// This module is CLIENT-SAFE (the world-settings panel imports the parser), so
// it must NOT import server-only helpers. The per-instance ini path lives in the
// route (app/api/palworld-settings), which is server-only.

function splitTopLevel(content: string): string[] {
  const parts: string[] = []
  let depth = 0
  let inQuotes = false
  let current = ''
  for (let i = 0; i < content.length; i++) {
    const c = content[i]
    if (c === '"' && content[i - 1] !== '\\') inQuotes = !inQuotes
    if (!inQuotes) {
      if (c === '(') depth++
      if (c === ')') depth--
    }
    if (c === ',' && depth === 0 && !inQuotes) {
      parts.push(current)
      current = ''
    } else {
      current += c
    }
  }
  if (current) parts.push(current)
  return parts
}

export function parseOptionSettings(iniContent: string): Map<string, string> {
  const match = iniContent.match(/OptionSettings=\(([\s\S]*)\)/)
  if (!match) throw new Error('OptionSettings=(...) not found in PalWorldSettings.ini')
  const entries = splitTopLevel(match[1])
  const map = new Map<string, string>()
  for (const entry of entries) {
    const eqIdx = entry.indexOf('=')
    if (eqIdx === -1) continue
    map.set(entry.slice(0, eqIdx).trim(), entry.slice(eqIdx + 1))
  }
  return map
}

export function serializeOptionSettings(
  fullIniContent: string,
  values: Map<string, string>
): string {
  const rebuilt = 'OptionSettings=(' + Array.from(values.entries()).map(([k, v]) => `${k}=${v}`).join(',') + ')'
  return fullIniContent.replace(/OptionSettings=\([\s\S]*\)/, rebuilt)
}

export type FieldKind = 'string' | 'boolean' | 'integer' | 'float' | 'enum' | 'platform-list'

export function isQuoted(raw: string): boolean {
  return raw.startsWith('"') && raw.endsWith('"')
}
export function unquote(raw: string): string {
  return isQuoted(raw) ? raw.slice(1, -1) : raw
}
export function quote(value: string): string {
  return `"${value}"`
}

export function inferKind(raw: string): FieldKind {
  if (isQuoted(raw)) return 'string'
  if (raw === 'True' || raw === 'False') return 'boolean'
  if (/^-?\d+\.\d+$/.test(raw)) return 'float'
  if (/^-?\d+$/.test(raw)) return 'integer'
  return 'enum'
}

export function formatValue(newValue: string | number | boolean, originalRaw: string): string {
  const kind = inferKind(originalRaw)
  switch (kind) {
    case 'string':
      return quote(String(newValue))
    case 'boolean':
      return newValue === true || newValue === 'True' ? 'True' : 'False'
    case 'float': {
      const decimals = originalRaw.split('.')[1]?.length ?? 6
      return Number(newValue).toFixed(decimals)
    }
    case 'integer':
      return String(Math.trunc(Number(newValue)))
    case 'enum':
    default:
      return String(newValue)
  }
}

export function humanizeKey(key: string): string {
  let s = key
  if (/^b[A-Z]/.test(s)) s = s.slice(1)
  s = s.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  s = s.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
  s = s.replace(/_/g, ' ')
  s = s
    .replace(/\bPv P\b/g, 'PvP')
    .replace(/\bHp\b/g, 'HP')
    .replace(/\bU Id\b/g, 'UID')
    .replace(/\bRESTAPI\b/g, 'REST API')
  return s.trim()
}

export interface SettingField {
  key: string
  label: string
  category: string
  kind: FieldKind
  description?: string
  options?: string[]
  min?: number
  max?: number
  step?: number
  defaultValue: string
}

const DEFAULTS_RAW =
  'Difficulty=None,RandomizerType=None,RandomizerSeed="",bIsRandomizerPalLevelRandom=False,DayTimeSpeedRate=1.000000,NightTimeSpeedRate=1.000000,ExpRate=1.000000,PalCaptureRate=1.000000,PalSpawnNumRate=1.000000,PalDamageRateAttack=1.000000,PalDamageRateDefense=1.000000,PlayerDamageRateAttack=1.000000,PlayerDamageRateDefense=1.000000,PlayerStomachDecreaceRate=1.000000,PlayerStaminaDecreaceRate=1.000000,PlayerAutoHPRegeneRate=1.000000,PlayerAutoHpRegeneRateInSleep=1.000000,PalStomachDecreaceRate=1.000000,PalStaminaDecreaceRate=1.000000,PalAutoHPRegeneRate=1.000000,PalAutoHpRegeneRateInSleep=1.000000,BuildObjectHpRate=1.000000,BuildObjectDamageRate=1.000000,BuildObjectDeteriorationDamageRate=1.000000,CollectionDropRate=1.000000,CollectionObjectHpRate=1.000000,CollectionObjectRespawnSpeedRate=1.000000,EnemyDropItemRate=1.000000,DeathPenalty=Item,bEnablePlayerToPlayerDamage=False,bEnableFriendlyFire=False,bEnableInvaderEnemy=True,bActiveUNKO=False,bEnableAimAssistPad=True,bEnableAimAssistKeyboard=False,DropItemMaxNum=3000,PhysicsActiveDropItemMaxNum=-1,DropItemMaxNum_UNKO=100,BaseCampMaxNum=128,BaseCampWorkerMaxNum=15,DropItemAliveMaxHours=1.000000,bAutoResetGuildNoOnlinePlayers=False,AutoResetGuildTimeNoOnlinePlayers=72.000000,GuildPlayerMaxNum=20,BaseCampMaxNumInGuild=4,PalEggDefaultHatchingTime=1.000000,WorkSpeedRate=1.000000,AutoSaveSpan=30.000000,bIsMultiplay=False,bIsPvP=False,bHardcore=False,bPalLost=False,bCharacterRecreateInHardcore=False,bCanPickupOtherGuildDeathPenaltyDrop=False,bEnableNonLoginPenalty=True,bEnableFastTravel=True,bEnableFastTravelOnlyBaseCamp=False,bIsStartLocationSelectByMap=False,bExistPlayerAfterLogout=False,bEnableDefenseOtherGuildPlayer=False,bInvisibleOtherGuildBaseCampAreaFX=False,bBuildAreaLimit=False,ItemWeightRate=1.000000,CoopPlayerMaxNum=4,ServerPlayerMaxNum=32,ServerName="Default Palworld Server",ServerDescription="",AdminPassword="",ServerPassword="",bAllowClientMod=True,PublicPort=8211,PublicIP="",RCONEnabled=False,RCONPort=25575,Region="",bUseAuth=True,BanListURL="https://b.palworldgame.com/api/banlist.txt",RESTAPIEnabled=False,RESTAPIPort=8212,bShowPlayerList=False,ChatPostLimitPerMinute=30,CrossplayPlatforms=(Steam,Xbox,PS5,Mac),bIsUseBackupSaveData=True,LogFormatType=Text,bIsShowJoinLeftMessage=True,SupplyDropSpan=180,EnablePredatorBossPal=True,MaxBuildingLimitNum=0,ServerReplicatePawnCullDistance=15000.000000,bAllowGlobalPalboxExport=True,bAllowGlobalPalboxImport=False,EquipmentDurabilityDamageRate=1.000000,ItemContainerForceMarkDirtyInterval=1.000000,PlayerDataPalStorageUpdateCheckTickInterval=1.000000,ItemCorruptionMultiplier=1.000000,MonsterFarmActionSpeedRate=1.000000,DenyTechnologyList=,GuildRejoinCooldownMinutes=0,AutoTransferMasterCheckIntervalSeconds=3600.000000,AutoTransferMasterThresholdDays=14,MaxGuildsPerFrame=10,BlockRespawnTime=5.000000,RespawnPenaltyDurationThreshold=0.000000,RespawnPenaltyTimeScale=2.000000,bDisplayPvPItemNumOnWorldMap_BaseCamp=False,bDisplayPvPItemNumOnWorldMap_Player=False,AdditionalDropItemWhenPlayerKillingInPvPMode="PlayerDropItem",AdditionalDropItemNumWhenPlayerKillingInPvPMode=1,bAdditionalDropItemWhenPlayerKillingInPvPMode=False,bEnableVoiceChat=False,VoiceChatMaxVolumeDistance=3000.000000,VoiceChatZeroVolumeDistance=15000.000000,bAllowEnhanceStat_Health=True,bAllowEnhanceStat_Attack=True,bAllowEnhanceStat_Stamina=True,bAllowEnhanceStat_Weight=True,bAllowEnhanceStat_WorkSpeed=True,bEnableBuildingPlayerUIdDisplay=False,BuildingNameDisplayCacheTTLSeconds=60'

export const DEFAULT_VALUES: Map<string, string> = parseOptionSettings(`OptionSettings=(${DEFAULTS_RAW})`)

const SERVER_NETWORK_KEYS = [
  'ServerName', 'ServerDescription', 'AdminPassword', 'ServerPassword', 'PublicIP', 'PublicPort',
  'CoopPlayerMaxNum', 'ServerPlayerMaxNum', 'bIsUseBackupSaveData', 'AutoSaveSpan', 'CrossplayPlatforms',
  'LogFormatType', 'bEnableVoiceChat', 'VoiceChatMaxVolumeDistance', 'VoiceChatZeroVolumeDistance',
  'RandomizerType', 'RandomizerSeed', 'bIsRandomizerPalLevelRandom',
]

const GAMEPLAY_BALANCE_KEYS = [
  'Difficulty', 'DayTimeSpeedRate', 'NightTimeSpeedRate', 'ExpRate', 'PalCaptureRate', 'PalSpawnNumRate',
  'PalDamageRateAttack', 'PalDamageRateDefense', 'PalStomachDecreaceRate', 'PalStaminaDecreaceRate',
  'PalAutoHPRegeneRate', 'PalAutoHpRegeneRateInSleep', 'PlayerDamageRateAttack', 'PlayerDamageRateDefense',
  'PlayerStomachDecreaceRate', 'PlayerStaminaDecreaceRate', 'PlayerAutoHPRegeneRate', 'PlayerAutoHpRegeneRateInSleep',
  'BuildObjectHpRate', 'BuildObjectDamageRate', 'BuildObjectDeteriorationDamageRate', 'DropItemMaxNum',
  'ItemWeightRate', 'CollectionDropRate', 'CollectionObjectHpRate', 'CollectionObjectRespawnSpeedRate',
  'EnemyDropItemRate', 'PalEggDefaultHatchingTime', 'bEnableInvaderEnemy', 'EnablePredatorBossPal',
  'DeathPenalty', 'GuildPlayerMaxNum', 'BaseCampMaxNumInGuild', 'BaseCampWorkerMaxNum', 'MaxBuildingLimitNum',
  'SupplyDropSpan', 'ChatPostLimitPerMinute', 'EquipmentDurabilityDamageRate',
  'ItemContainerForceMarkDirtyInterval', 'ItemCorruptionMultiplier', 'MonsterFarmActionSpeedRate',
]

const CATEGORY_LABELS = {
  network: 'Server & Network',
  gameplay: 'Gameplay & Balance',
  advanced: 'Advanced',
} as const

function categoryFor(key: string): string {
  if (SERVER_NETWORK_KEYS.includes(key)) return CATEGORY_LABELS.network
  if (GAMEPLAY_BALANCE_KEYS.includes(key)) return CATEGORY_LABELS.gameplay
  return CATEGORY_LABELS.advanced
}

const CURATED: Record<string, Partial<Omit<SettingField, 'key' | 'category' | 'defaultValue'>>> = {
  ServerName: { label: 'Server Name', kind: 'string' },
  ServerDescription: { label: 'Server Description', kind: 'string' },
  ServerPassword: { label: 'Join Password', kind: 'string' },
  AdminPassword: { label: 'Admin Password', kind: 'string' },
  PublicIP: { label: 'Public IP', kind: 'string' },
  PublicPort: { label: 'Public Port', kind: 'integer' },
  ServerPlayerMaxNum: { label: 'Max Players', kind: 'integer', min: 1, max: 128, description: 'Maximum number of players that can join the server.' },
  CoopPlayerMaxNum: { label: 'Co-op Party Max', kind: 'integer', min: 1, max: 8 },
  AutoSaveSpan: { label: 'Auto-Save Interval (sec)', kind: 'float', min: 10, max: 3600, step: 10, description: 'Seconds between world auto-saves.' },
  Difficulty: { label: 'Difficulty', kind: 'enum', options: ['None', 'Casual', 'Normal', 'Hard'] },
  CrossplayPlatforms: { label: 'Crossplay Platforms', kind: 'platform-list', description: 'Which platforms can join. Steam is always required for RCON/REST/dashboard access, regardless of this setting.' },
  DayTimeSpeedRate: { label: 'Daytime Speed', kind: 'float', min: 0.1, max: 5, step: 0.1, description: 'Day length multiplier. Above 1 makes daytime pass faster.' },
  NightTimeSpeedRate: { label: 'Nighttime Speed', kind: 'float', min: 0.1, max: 5, step: 0.1, description: 'Night length multiplier. Above 1 makes nighttime pass faster.' },
  ExpRate: { label: 'EXP Rate', kind: 'float', min: 0, max: 20, step: 0.1, description: 'Multiplier for EXP earned. 2 = double XP, 0.5 = half.' },
  PalCaptureRate: { label: 'Pal Capture Rate', kind: 'float', min: 0, max: 5, step: 0.1, description: 'Multiplier for Pal capture chance.' },
  PalSpawnNumRate: { label: 'Pal Spawn Rate', kind: 'float', min: 0, max: 5, step: 0.1, description: 'Multiplier for wild Pal spawn count. High values affect performance.' },
  EnemyDropItemRate: { label: 'Enemy Drop Rate', kind: 'float', min: 0, max: 5, step: 0.1, description: 'Multiplier for loot dropped by defeated enemies.' },
  CollectionDropRate: { label: 'Gathering Drop Rate', kind: 'float', min: 0, max: 5, step: 0.1, description: 'Multiplier for items gathered from trees, ore, etc.' },
  PalEggDefaultHatchingTime: { label: 'Egg Hatching Time (hrs)', kind: 'float', min: 0, max: 10, step: 0.1, description: 'Hours a huge egg takes to hatch; other eggs scale down. 0 = instant.' },
  WorkSpeedRate: { label: 'Work Speed Rate', kind: 'float', min: 0, max: 5, step: 0.1, description: 'Multiplier for base work/crafting speed.' },
  DeathPenalty: { label: 'Death Penalty', kind: 'enum', options: ['None', 'Item', 'ItemAndEquipment', 'All'], description: 'What players drop on death.' },
  GuildPlayerMaxNum: { label: 'Guild Max Members', kind: 'integer', min: 1, max: 100 },
  BaseCampWorkerMaxNum: { label: 'Max Workers per Base', kind: 'integer', min: 1, description: 'Raising above 15 can hurt performance.' },
  BaseCampMaxNumInGuild: { label: 'Max Bases per Guild', kind: 'integer', min: 1 },
  DropItemMaxNum: { label: 'Max Dropped Items', kind: 'integer', min: 100, description: 'Maximum dropped items kept in the world before the oldest despawn.' },
  SupplyDropSpan: { label: 'Supply Drop Interval (min)', kind: 'integer', min: 30, description: 'Minutes between supply drops.' },
  bIsPvP: { label: 'PvP Enabled', kind: 'boolean', description: 'Players can damage each other.' },
  bEnablePlayerToPlayerDamage: { label: 'Player-to-Player Damage', kind: 'boolean' },
  bEnableFriendlyFire: { label: 'Friendly Fire', kind: 'boolean' },
  bEnableInvaderEnemy: { label: 'Invader Enemies', kind: 'boolean', description: 'Halves RAM usage if turned off.' },
  bEnableAimAssistPad: { label: 'Aim Assist (Controller)', kind: 'boolean' },
  bEnableAimAssistKeyboard: { label: 'Aim Assist (Keyboard)', kind: 'boolean' },
  bEnableFastTravel: { label: 'Fast Travel', kind: 'boolean' },
  bShowPlayerList: { label: 'Show Player List Publicly', kind: 'boolean' },
  bHardcore: { label: 'Hardcore Mode', kind: 'boolean', description: 'Player death is permanent.' },
  bPalLost: { label: 'Pal Lost on Death', kind: 'boolean', description: 'Pals on a player are lost permanently on death.' },
  RCONEnabled: { label: 'RCON Enabled', kind: 'boolean', description: 'Enables RCON remote console access.' },
  RESTAPIEnabled: { label: 'REST API Enabled', kind: 'boolean', description: 'Enables the REST API used by this dashboard.' },
  PlayerStomachDecreaceRate: { label: 'Player Hunger Rate', kind: 'float', min: 0, max: 5, step: 0.1 },
  PlayerStaminaDecreaceRate: { label: 'Player Stamina Drain', kind: 'float', min: 0, max: 5, step: 0.1 },
  PalStomachDecreaceRate: { label: 'Pal Hunger Rate', kind: 'float', min: 0, max: 5, step: 0.1 },
  PalStaminaDecreaceRate: { label: 'Pal Stamina Drain', kind: 'float', min: 0, max: 5, step: 0.1 },
  PlayerDamageRateAttack: { label: 'Player Attack Damage', kind: 'float', min: 0, max: 5, step: 0.1 },
  PlayerDamageRateDefense: { label: 'Player Damage Taken', kind: 'float', min: 0, max: 5, step: 0.1 },
  PalDamageRateAttack: { label: 'Pal Attack Damage', kind: 'float', min: 0, max: 5, step: 0.1 },
  PalDamageRateDefense: { label: 'Pal Damage Taken', kind: 'float', min: 0, max: 5, step: 0.1 },
}

function buildFields(): SettingField[] {
  return Array.from(DEFAULT_VALUES.keys()).map((key) => {
    const def = DEFAULT_VALUES.get(key)!
    const curated = CURATED[key]
    return {
      key,
      category: categoryFor(key),
      defaultValue: def,
      label: curated?.label ?? humanizeKey(key),
      kind: curated?.kind ?? inferKind(def),
      description: curated?.description,
      options: curated?.options,
      min: curated?.min,
      max: curated?.max,
      step: curated?.step,
    }
  })
}

export const SETTING_FIELDS: SettingField[] = buildFields()
export const SETTING_CATEGORIES = [CATEGORY_LABELS.network, CATEGORY_LABELS.gameplay, CATEGORY_LABELS.advanced]
