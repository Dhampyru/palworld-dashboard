// PATCH (not upstream): the data-driven command registry behind the RCON
// console upgrade (docs/specs/rcon-console.md §4/§5).
//
// One typed array drives the whole feature -- list, search, parameter forms,
// live preview and execution. There are deliberately no per-command React
// components: adding a command means adding a row here.
//
// The PalDefender half was verified on 2026-07-19 against the installed build
// (v1.8.3) using `getrconcmds`, which returns the live registry as
// `name:minArgs;` pairs. Signatures are corroborated by usage/error strings in
// PalDefender.dll. Six signatures that the reference GUI got wrong are
// corrected here -- see the spec's §5 table for the per-command detail.

export type RconCommandSource = 'rcon' | 'paldefender'

export type RconCategory =
  | 'Servers'
  | 'Players'
  | 'Moderation'
  | 'World'
  | 'Items'
  | 'Cleanup'
  | 'Pals'
  | 'Tech'
  | 'Bases'
  | 'Advanced'

// Render order for the command list.
export const RCON_CATEGORIES: RconCategory[] = [
  'Servers',
  'Players',
  'Moderation',
  'World',
  'Items',
  'Cleanup',
  'Pals',
  'Tech',
  'Bases',
  'Advanced',
]

export type RconParamKind =
  | 'player' // combobox of online players (value = UserId) + free text
  | 'text'
  | 'number'
  | 'itemId' // typeahead over data/items.json
  | 'palId' // typeahead over data/pals.json, with a BOSS_ variant toggle
  | 'eggId' // typeahead over data/eggs.json
  // Enumerated live from the server's own `gettechids`, so this picker is
  // populated and correct for the operator's exact build (lib/rcon-datasets.ts).
  | 'techId'
  | 'boolean'
  | 'select'
  // Added while building: the §5 verification turned up three shapes the
  // original union could not express.
  | 'coords' // three number inputs, emitted as `X Y Z`
  | 'palTemplate' // filename under PalDefender/Pals/Templates -- a picker

export type RconParam = {
  key: string
  label: string
  kind: RconParamKind
  optional?: boolean
  placeholder?: string
  default?: string | number
  min?: number
  max?: number
  options?: { value: string; label: string }[]
  // `giveitems`/`delitems` take a variable number of `<ItemId>[:<Amount>]`
  // arguments, which the fixed-params model cannot express. v1 exposes them as
  // one freeform field whose contents are passed through as-is (spec §4).
  variadic?: boolean
  help?: string
}

export type RconCommand = {
  name: string // exact string sent over RCON -- never with a leading `/`
  category: RconCategory
  description: string
  source: RconCommandSource
  dangerous?: boolean // red badge + confirm dialog
  // Present in PalDefender's Config.json `adminCheats` array, so it is refused
  // with `Admin-cheats are disabled!` when `allowAdminCheats` is false. The UI
  // uses this to mark the command rather than let it fail generically (§7).
  adminCheat?: boolean
  // Long output (`whitelist_get`, `gettechids`, ...) -- the log must scroll
  // rather than let the layout blow up.
  longOutput?: boolean
  note?: string
  params: RconParam[]
}

const RELIC_TYPES = [
  'CapturePower',
  'HungerReduction',
  'SwimSpeed',
  'FoodDecayReduction',
  'JumpPower',
  'GliderSpeed',
  'ClimbSpeed',
  'StatusAilmentResist',
  'StaminaReduction',
  'SphereHoming',
  'ExpBonus',
  'RainbowPassiveRate',
  'MoveSpeed',
]

const player = (
  key = 'userId',
  label = 'Player',
  extra: Partial<RconParam> = {},
): RconParam => ({ key, label, kind: 'player', placeholder: 'Name or UserId', ...extra })

// ---------------------------------------------------------------------------
// Vanilla RCON -- always available, handled by the game itself.
// ---------------------------------------------------------------------------

const VANILLA_COMMANDS: RconCommand[] = [
  { name: 'Info', category: 'Servers', source: 'rcon', description: 'Server name and version.', params: [] },
  { name: 'Save', category: 'Servers', source: 'rcon', description: 'Write the world to disk now.', params: [] },
  {
    name: 'ShowPlayers',
    category: 'Players',
    source: 'rcon',
    description: 'List online players as CSV (name, playeruid, steamid).',
    params: [],
  },
  {
    name: 'Broadcast',
    category: 'Servers',
    source: 'rcon',
    description: 'Send a server-wide message.',
    // Palworld truncates Broadcast at the first space. The registry prefers
    // pgbroadcast whenever PalDefender is present (§7).
    note: 'No spaces — Palworld truncates at the first one. Use pgbroadcast if PalDefender is installed.',
    params: [{ key: 'message', label: 'Message', kind: 'text', placeholder: 'Server_restarting_soon' }],
  },
  {
    name: 'KickPlayer',
    category: 'Moderation',
    source: 'rcon',
    description: 'Disconnect a player.',
    params: [player()],
  },
  {
    name: 'BanPlayer',
    category: 'Moderation',
    source: 'rcon',
    description: 'Ban a player from the server.',
    dangerous: true,
    params: [player()],
  },
  {
    name: 'UnBanPlayer',
    category: 'Moderation',
    source: 'rcon',
    description: 'Lift a ban.',
    params: [player()],
  },
  {
    name: 'Shutdown',
    category: 'Servers',
    source: 'rcon',
    description: 'Shut down after a countdown, with an optional message.',
    dangerous: true,
    note: 'Docker restarts the container afterwards — use the Stop button for a real stop.',
    params: [
      { key: 'seconds', label: 'Seconds', kind: 'number', min: 1, max: 3600, default: 30 },
      { key: 'message', label: 'Message', kind: 'text', optional: true, placeholder: 'Restarting' },
    ],
  },
  {
    name: 'DoExit',
    category: 'Servers',
    source: 'rcon',
    description: 'Kill the server immediately, with no save and no warning.',
    dangerous: true,
    params: [],
  },
]

// ---------------------------------------------------------------------------
// PalDefender -- shown only when detected (§8).
// ---------------------------------------------------------------------------

const PALDEFENDER_COMMANDS: RconCommand[] = [
  // --- Servers ---
  { name: 'version', category: 'Servers', source: 'paldefender', description: 'PalDefender version.', params: [] },
  {
    name: 'reloadcfg',
    category: 'Servers',
    source: 'paldefender',
    description: 'Reload PalDefender config and whitelist without a restart.',
    params: [],
  },
  {
    name: 'pgbroadcast',
    category: 'Servers',
    source: 'paldefender',
    description: 'Server-wide message that supports spaces.',
    note: 'Preferred over vanilla Broadcast, which truncates at the first space.',
    params: [{ key: 'message', label: 'Message', kind: 'text', placeholder: 'Server restarting in 5 minutes' }],
  },
  {
    name: 'alert',
    category: 'Servers',
    source: 'paldefender',
    description: 'On-screen alert to all players.',
    params: [{ key: 'message', label: 'Message', kind: 'text' }],
  },
  {
    name: 'getrconcmds',
    category: 'Servers',
    source: 'paldefender',
    description: 'List the live PalDefender RCON registry as name:minArgs pairs.',
    longOutput: true,
    note: 'Also how this console detects PalDefender and checks for version drift.',
    params: [],
  },
  {
    name: 'iwantplayerlist',
    category: 'Players',
    source: 'paldefender',
    description: "PalDefender's own player list.",
    longOutput: true,
    params: [],
  },

  // --- Players ---
  {
    name: 'getpos',
    category: 'Players',
    source: 'paldefender',
    description: "Show a player's coordinates.",
    // Verified by execution 2026-07-19: minArgs=0 and the spec both called the
    // player optional, but running `getpos` bare over RCON returns
    // `You have to specify an UserId to perform this command`. Same trap as
    // spawnpal/exportpals -- the parser minimum is not the valid input.
    note: 'Player is required over RCON despite the parser reporting it optional.',
    params: [player()],
  },
  {
    name: 'renameplayer',
    category: 'Players',
    source: 'paldefender',
    description: 'Rename a player.',
    params: [player(), { key: 'newName', label: 'New name', kind: 'text' }],
  },
  {
    name: 'give_exp',
    category: 'Players',
    source: 'paldefender',
    description: 'Grant experience points.',
    adminCheat: true,
    params: [player(), { key: 'amount', label: 'Amount', kind: 'number', min: 1, default: 1000 }],
  },
  {
    name: 'givestats',
    category: 'Players',
    source: 'paldefender',
    // Corrected: takes no stat-name argument. Grants unused stat *points*.
    description: 'Grant unused stat points. Negative values take them away.',
    adminCheat: true,
    params: [player(), { key: 'count', label: 'Points', kind: 'number', optional: true, default: 1 }],
  },
  {
    name: 'send',
    category: 'Players',
    source: 'paldefender',
    description: 'Direct message to one player. No vanilla equivalent.',
    params: [
      { key: 'type', label: 'Type', kind: 'text', placeholder: 'e.g. normal' },
      player(),
      { key: 'message', label: 'Message', kind: 'text' },
    ],
  },

  // --- Moderation ---
  {
    name: 'setadmin',
    category: 'Moderation',
    source: 'paldefender',
    // Corrected: no on|off argument -- that belongs to godmode, which is chat-only.
    description: 'Grant admin to a player.',
    dangerous: true,
    params: [player()],
  },
  {
    name: 'addadminip',
    category: 'Moderation',
    source: 'paldefender',
    description: 'Add an IP to the admin whitelist.',
    params: [{ key: 'ip', label: 'IP address', kind: 'text', placeholder: '127.0.0.1' }],
  },
  {
    name: 'getip',
    category: 'Moderation',
    source: 'paldefender',
    description: "Show a player's IP address.",
    params: [player()],
  },
  {
    name: 'kick',
    category: 'Moderation',
    source: 'paldefender',
    description: 'Kick a player, with an optional reason.',
    params: [player(), { key: 'reason', label: 'Reason', kind: 'text', optional: true, placeholder: 'Kicked by Admin.' }],
  },
  {
    name: 'ban',
    category: 'Moderation',
    source: 'paldefender',
    description: 'Ban a player, with an optional reason.',
    dangerous: true,
    params: [player(), { key: 'reason', label: 'Reason', kind: 'text', optional: true, placeholder: 'Banned by Admin.' }],
  },
  {
    name: 'ipban',
    category: 'Moderation',
    source: 'paldefender',
    description: "Ban a player's IP address.",
    dangerous: true,
    params: [player(), { key: 'reason', label: 'Reason', kind: 'text', optional: true }],
  },
  {
    name: 'unban',
    category: 'Moderation',
    source: 'paldefender',
    description: 'Lift a ban.',
    params: [player(), { key: 'reason', label: 'Reason', kind: 'text', optional: true, placeholder: 'Unbanned by admin.' }],
  },
  {
    name: 'banip',
    category: 'Moderation',
    source: 'paldefender',
    description: 'Ban an IP address outright.',
    dangerous: true,
    params: [{ key: 'ip', label: 'IP address', kind: 'text' }],
  },
  {
    name: 'unbanip',
    category: 'Moderation',
    source: 'paldefender',
    description: 'Lift an IP ban.',
    params: [{ key: 'ip', label: 'IP address', kind: 'text' }],
  },
  {
    name: 'whitelist_add',
    category: 'Moderation',
    source: 'paldefender',
    description: 'Add a player to the whitelist.',
    params: [player()],
  },
  {
    name: 'whitelist_remove',
    category: 'Moderation',
    source: 'paldefender',
    description: 'Remove a player from the whitelist.',
    params: [player()],
  },
  {
    name: 'whitelist_get',
    category: 'Moderation',
    source: 'paldefender',
    description: 'Show the whitelist.',
    longOutput: true,
    params: [],
  },

  // --- World ---
  {
    name: 'settime',
    category: 'World',
    source: 'paldefender',
    // Corrected: integer hour 0-23 only, not free text.
    description: 'Set the in-game hour.',
    params: [{ key: 'hour', label: 'Hour', kind: 'number', min: 0, max: 23, default: 8 }],
  },

  // --- Items ---
  {
    name: 'give',
    category: 'Items',
    source: 'paldefender',
    description: 'Give an item to a player.',
    adminCheat: true,
    params: [
      player(),
      { key: 'itemId', label: 'Item', kind: 'itemId' },
      { key: 'amount', label: 'Amount', kind: 'number', optional: true, min: 1, default: 1 },
    ],
  },
  {
    name: 'delitem',
    category: 'Items',
    source: 'paldefender',
    description: 'Remove an item from a player.',
    params: [
      player(),
      { key: 'itemId', label: 'Item', kind: 'itemId' },
      { key: 'amount', label: 'Amount', kind: 'text', optional: true, placeholder: '1 or all', help: 'Accepts a number or the literal "all".' },
    ],
  },
  {
    name: 'give_relic',
    category: 'Items',
    source: 'paldefender',
    description: 'Grant relic (Lifmunk effigy) bonuses.',
    adminCheat: true,
    // minArgs reports 1, but the binary rejects a missing RelicType. Required here.
    note: 'Relic type is required despite the parser reporting it optional.',
    params: [
      player(),
      {
        key: 'relicType',
        label: 'Relic type',
        kind: 'select',
        options: RELIC_TYPES.map((value) => ({ value, label: value })),
      },
      { key: 'amount', label: 'Amount', kind: 'number', optional: true, min: 1 },
    ],
  },

  // --- Cleanup ---
  {
    name: 'clearinv',
    category: 'Cleanup',
    source: 'paldefender',
    description: "Clear a player's container.",
    dangerous: true,
    // The wiki calls Container optional; minArgs=2 says otherwise, so it is
    // required here. The accepted values are not enumerated anywhere -- `items`
    // is the documented default and the only one confirmed.
    note: 'Container values are undocumented beyond "items".',
    params: [
      player(),
      { key: 'container', label: 'Container', kind: 'text', default: 'items', placeholder: 'items' },
    ],
  },
  {
    name: 'deletepals',
    category: 'Cleanup',
    source: 'paldefender',
    // Corrected: UserId comes first.
    description: 'Delete Pals belonging to a player.',
    dangerous: true,
    note: 'Filter grammar is unspecified — expect "too many sub-arguments" on a wrong guess.',
    params: [player(), { key: 'palFilter', label: 'Pal filter', kind: 'text' }],
  },
  {
    name: 'killnearestbase',
    category: 'Cleanup',
    source: 'paldefender',
    // Corrected: coordinates, NOT a player. Mandatory over RCON.
    description: 'Destroy the base nearest to a set of coordinates.',
    dangerous: true,
    note: 'Coordinates, not a player. The binary requires at least X and Y over RCON.',
    params: [{ key: 'coords', label: 'Coordinates', kind: 'coords' }],
  },

  // --- Pals ---
  {
    name: 'givepal',
    category: 'Pals',
    source: 'paldefender',
    description: "Add a Pal to a player's party.",
    adminCheat: true,
    params: [
      player(),
      { key: 'palId', label: 'Pal', kind: 'palId' },
      { key: 'level', label: 'Level', kind: 'number', optional: true, min: 1, max: 60, default: 1 },
    ],
  },
  {
    name: 'spawnpal',
    category: 'Pals',
    source: 'paldefender',
    description: 'Spawn a Pal into the world at coordinates.',
    adminCheat: true,
    // Corrected: over RCON the binary refuses without coordinates --
    // `RCON usage needs to provide coordinates for /spawnpal!`
    note: 'Coordinates are mandatory over RCON, even though the parser reports otherwise.',
    params: [
      { key: 'palId', label: 'Pal', kind: 'palId' },
      { key: 'coords', label: 'Coordinates', kind: 'coords' },
      { key: 'level', label: 'Level', kind: 'number', optional: true, min: 1, max: 60, default: 1 },
    ],
  },
  {
    name: 'giveegg',
    category: 'Pals',
    source: 'paldefender',
    description: 'Give an egg containing a specific Pal.',
    adminCheat: true,
    params: [
      player(),
      { key: 'eggId', label: 'Egg', kind: 'eggId' },
      { key: 'palId', label: 'Pal', kind: 'palId' },
      { key: 'level', label: 'Level', kind: 'number', optional: true, min: 1, max: 60 },
    ],
  },
  {
    name: 'exportpals',
    category: 'Pals',
    source: 'paldefender',
    description: "Export a player's Pals to a file.",
    note: 'The player is required over RCON despite the parser reporting it optional.',
    params: [player()],
  },
  {
    name: 'getskinids',
    category: 'Pals',
    source: 'paldefender',
    description: 'List every skin ID.',
    longOutput: true,
    params: [],
  },
  {
    name: 'summon',
    category: 'Pals',
    source: 'paldefender',
    description: 'Summon a Pal by summon name.',
    params: [{ key: 'palSummon', label: 'Summon', kind: 'text' }],
  },

  // --- Tech ---
  {
    name: 'learntech',
    category: 'Tech',
    source: 'paldefender',
    description: 'Unlock a technology for a player.',
    adminCheat: true,
    params: [player(), { key: 'tech', label: 'Technology', kind: 'techId', placeholder: 'Tech ID or "all"' }],
  },
  {
    name: 'unlearntech',
    category: 'Tech',
    source: 'paldefender',
    description: 'Remove a technology from a player.',
    params: [player(), { key: 'tech', label: 'Technology', kind: 'techId', placeholder: 'Tech ID or "all"' }],
  },
  {
    name: 'givetechpoints',
    category: 'Tech',
    source: 'paldefender',
    description: 'Grant technology points.',
    adminCheat: true,
    params: [player(), { key: 'amount', label: 'Amount', kind: 'number', optional: true, default: 1 }],
  },
  {
    name: 'givebosstechpoints',
    category: 'Tech',
    source: 'paldefender',
    description: 'Grant boss technology points.',
    adminCheat: true,
    params: [player(), { key: 'amount', label: 'Amount', kind: 'number', optional: true, default: 1 }],
  },
  {
    name: 'gettechids',
    category: 'Tech',
    source: 'paldefender',
    description: 'List every technology ID.',
    longOutput: true,
    params: [],
  },

  // --- Bases ---
  {
    name: 'getnearestbase',
    category: 'Bases',
    source: 'paldefender',
    // Corrected: coordinates, not a player.
    description: 'Find the base nearest to a set of coordinates.',
    note: 'Coordinates, not a player.',
    params: [{ key: 'coords', label: 'Coordinates', kind: 'coords' }],
  },
  {
    name: 'setguildleader',
    category: 'Bases',
    source: 'paldefender',
    description: 'Make a player the leader of their guild.',
    params: [player()],
  },
  {
    name: 'exportguilds',
    category: 'Bases',
    source: 'paldefender',
    description: 'Write every guild to guildexport.json.',
    longOutput: true,
    params: [],
  },

  // --- Advanced ---
  {
    name: 'givepal_j',
    category: 'Advanced',
    source: 'paldefender',
    // Corrected: a template FILENAME, not inline JSON.
    description: 'Give a Pal built from a saved template file.',
    adminCheat: true,
    params: [player(), { key: 'palTemplate', label: 'Template', kind: 'palTemplate' }],
  },
  {
    name: 'giveegg_j',
    category: 'Advanced',
    source: 'paldefender',
    description: 'Give an egg built from a saved template file.',
    adminCheat: true,
    // minArgs=3 confirms the UserId the wiki's line omits.
    params: [
      player(),
      { key: 'eggId', label: 'Egg', kind: 'eggId' },
      { key: 'palTemplate', label: 'Template', kind: 'palTemplate' },
      { key: 'level', label: 'Level', kind: 'number', optional: true, min: 1, max: 60 },
    ],
  },
  {
    name: 'spawnpal_j',
    category: 'Advanced',
    source: 'paldefender',
    description: 'Spawn a Pal from a saved template file at coordinates.',
    adminCheat: true,
    params: [
      { key: 'palTemplate', label: 'Template', kind: 'palTemplate' },
      { key: 'coords', label: 'Coordinates', kind: 'coords', optional: true },
    ],
  },
  {
    name: 'giveitems',
    category: 'Advanced',
    source: 'paldefender',
    description: 'Give several items at once.',
    adminCheat: true,
    params: [
      player(),
      {
        key: 'items',
        label: 'Items',
        kind: 'text',
        variadic: true,
        placeholder: 'ItemId:10 OtherItemId:2',
        help: 'Space-separated ItemId[:Amount] pairs.',
      },
    ],
  },
  {
    name: 'delitems',
    category: 'Advanced',
    source: 'paldefender',
    description: 'Remove several items at once.',
    params: [
      player(),
      {
        key: 'items',
        label: 'Items',
        kind: 'text',
        variadic: true,
        placeholder: 'ItemId:10 OtherItemId:2',
        help: 'Space-separated ItemId[:Amount] pairs.',
      },
    ],
  },
  {
    name: 'tp',
    category: 'Advanced',
    source: 'paldefender',
    description: 'Teleport. Takes more forms than a single parameter set can express.',
    adminCheat: true,
    note: 'Forms: <UserId> · <UserId1> <UserId2> · <X> <Y> [Z] · home|oilrig[:Lv##].',
    params: [
      {
        key: 'args',
        label: 'Arguments',
        kind: 'text',
        variadic: true,
        placeholder: 'steam_7656… or 100 200 30',
        help: 'Passed through verbatim — pick one of the forms above.',
      },
    ],
  },
]

// `resetoilrig` is deliberately absent: it appears in Config.json's adminCheats
// array but NOT in `getrconcmds`, so like `godmode` and `spectate` it is
// chat-only. Validated against the live v1.8.3 build on 2026-07-19 -- every
// other name here matched, and the only live names we omit are the ones below.
//
// The `giveme*` self-targeting variants are RCON-exposed but meaningless over
// RCON, where there is no "me". Deliberately excluded from the registry (§5).
export const EXCLUDED_FROM_REGISTRY = [
  'giveme',
  'giveme_exp',
  'givemestats',
  'giveme_relic',
  'givemepal',
  'givemepal_j',
  'givemeegg',
  'givemeegg_j',
  'givemetechpoints',
  'givemebosstechpoints',
]

export const RCON_COMMANDS: RconCommand[] = [...VANILLA_COMMANDS, ...PALDEFENDER_COMMANDS]

// ---------------------------------------------------------------------------
// Command-string assembly.
//
// THE single builder. The live preview and the executed payload must both come
// through here -- if they are ever computed by two code paths they will drift,
// and the preview stops being a safety mechanism (spec §6).
// ---------------------------------------------------------------------------

export type ParamValues = Record<string, string>

// No quoting: RCON has no shell, and every message-bearing PalDefender command
// consumes the rest of the line. Vanilla Broadcast's space mangling is a
// server-side quirk that quoting cannot fix -- it is surfaced as a note instead.
export function buildCommandString(command: RconCommand, values: ParamValues): string {
  const tokens = [command.name]
  for (const param of command.params) {
    const raw = (values[param.key] ?? '').trim()
    if (!raw) continue // optional and empty -> omitted entirely
    tokens.push(raw)
  }
  return tokens.join(' ')
}

export function missingRequiredParams(command: RconCommand, values: ParamValues): RconParam[] {
  return command.params.filter((param) => !param.optional && !(values[param.key] ?? '').trim())
}

export function isRunnable(command: RconCommand, values: ParamValues): boolean {
  return missingRequiredParams(command, values).length === 0
}

// ---------------------------------------------------------------------------
// Lookup and search.
// ---------------------------------------------------------------------------

export function findCommand(name: string): RconCommand | undefined {
  const lowered = name.toLowerCase()
  return RCON_COMMANDS.find((command) => command.name.toLowerCase() === lowered)
}

// Availability: vanilla always; PalDefender only when detected (§5/§8).
export function availableCommands(palDefenderDetected: boolean): RconCommand[] {
  return palDefenderDetected ? RCON_COMMANDS : RCON_COMMANDS.filter((c) => c.source === 'rcon')
}

// Search spans name, description, category and notes, so "ban" surfaces every
// ban-related command across categories (acceptance criterion 2).
export function searchCommands(commands: RconCommand[], query: string): RconCommand[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return commands
  return commands.filter((command) =>
    [command.name, command.description, command.category, command.note ?? '']
      .join(' ')
      .toLowerCase()
      .includes(needle),
  )
}

export function groupByCategory(commands: RconCommand[]): [RconCategory, RconCommand[]][] {
  return RCON_CATEGORIES.map(
    (category) => [category, commands.filter((c) => c.category === category)] as [RconCategory, RconCommand[]],
  ).filter(([, list]) => list.length > 0)
}

// ---------------------------------------------------------------------------
// `getrconcmds` parsing -- PalDefender detection plus version-drift checking.
//
// Response shape is `name:minArgs;` repeated. Being PalDefender-only, a
// successful response both detects the mod and enumerates exactly what this
// build supports, which beats probing `version` (spec §8).
// ---------------------------------------------------------------------------

export type LiveRegistry = Map<string, number>

export function parseRconCmds(response: string): LiveRegistry {
  const registry: LiveRegistry = new Map()
  for (const entry of response.split(';')) {
    const trimmed = entry.trim()
    if (!trimmed) continue
    const separator = trimmed.lastIndexOf(':')
    if (separator < 1) continue
    const name = trimmed.slice(0, separator).trim()
    const minArgs = Number(trimmed.slice(separator + 1).trim())
    if (name && Number.isFinite(minArgs)) registry.set(name, minArgs)
  }
  return registry
}

export type RegistryDrift = {
  // Specced here but absent from the operator's build -- likely older PalDefender.
  missing: string[]
  // In their build but not in our registry -- likely newer, or deliberately excluded.
  unknown: string[]
}

export function compareWithLiveRegistry(live: LiveRegistry): RegistryDrift {
  const ours = new Set(RCON_COMMANDS.filter((c) => c.source === 'paldefender').map((c) => c.name))
  const excluded = new Set(EXCLUDED_FROM_REGISTRY)
  return {
    missing: [...ours].filter((name) => !live.has(name)).sort(),
    unknown: [...live.keys()].filter((name) => !ours.has(name) && !excluded.has(name)).sort(),
  }
}
