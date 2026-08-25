// SERVER-ONLY. PATCH (not upstream): detect keybind conflicts across the CLIENT mods that ship
// together in the loadout. Keybinds only fire on a player's client (the dedicated server is
// headless), so this scans the kept client mods' payloads and reports keys bound by 2+ mods.
// Modifier-aware: Ctrl+F5 (e.g. Smart Production Queue) does NOT clash with plain F5. Detector
// only — it never edits anything; operators remap in each mod's own config.
import AdmZip from 'adm-zip'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { clientModStorePath, listClientMods, type ClientMod } from '@/lib/client-mods'
import { readClientModConfigOverrides } from '@/lib/client-mod-config'
import { reshadeKeybindSignature, reshadeKeybindSources } from '@/lib/reshade-keybinds'

// Recognized UE4SS Key.* tokens (function keys, letters, number-row words, numpad, named keys).
// Mouse buttons are deliberately excluded — mods hook LMB/RMB contextually (their own UI),
// which is not an actionable hotkey conflict and would just add noise.
const KEY_TOKEN =
  /^(F([1-9]|1[0-9]|2[0-4])|[A-Z]|ZERO|ONE|TWO|THREE|FOUR|FIVE|SIX|SEVEN|EIGHT|NINE|NUM(PAD)?_?(?:[0-9]+|ZERO|ONE|TWO|THREE|FOUR|FIVE|SIX|SEVEN|EIGHT|NINE|ADD|SUBTRACT|MULTIPLY|DIVIDE|DECIMAL|SEPARATOR|ENTER|LOCK|MINUS|PLUS|STAR|SLASH)|PAGE_UP|PAGE_DOWN|HOME|END|INSERT|DELETE|TAB|SPACE|ENTER|RETURN|TILDE|SEMICOLON|BACKSLASH|LEFT_BRACKET|RIGHT_BRACKET)$/

const NOT_KEYS = new Set(['FALSE', 'TRUE', 'NIL', 'NONE', 'NULL', 'DISABLED', ''])

// Top-row number keys reserved by Palworld's native action bar (1-8). A mod binding one collides
// with the game's own slot selection — a "native" conflict the mod-vs-mod scan can't see on its own
// (bit us via Toggle Mercy Ring's `HOTKEY = Key.FIVE`). Both the UE4SS word form (ONE..EIGHT) and
// the digit form are covered; NUMPAD/NUM_* are intentionally NOT here (separate from the hotbar).
const NATIVE_HOTBAR = new Set(['ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', '1', '2', '3', '4', '5', '6', '7', '8'])

// Mods that register a NATIVE Palworld Key-Config action rather than a UE4SS config the scanner can
// read, so their key is invisible to config parsing. Surfaced separately (matched by name substring
// — clean-room, no deployment mod-id list baked in) so the operator still knows they exist.
const NATIVE_KEY_MODS: { match: RegExp; action: string; note: string }[] = [
  {
    match: /first[\s-]?person/i,
    action: 'First Person',
    note: 'native Key-Config action (default F6 unless the loadout unbinds it) — rebind in Palworld Options → Key Config',
  },
]

// "Strong" key tokens are unambiguous keybind values (function keys, numpad, named keys) — a
// literal F6 / NUM_FIVE in a config is virtually always a keybind, so we accept it regardless of
// the field name. Single letters and number-WORDS (A, ONE) are ambiguous (could be data), so those
// still require a bind-ish field name to count. Keeps .ini/config parsing high-signal.
const STRONG_KEY =
  /^(F([1-9]|1[0-9]|2[0-4])|NUM(PAD)?_?(?:[0-9]+|ZERO|ONE|TWO|THREE|FOUR|FIVE|SIX|SEVEN|EIGHT|NINE|ADD|SUBTRACT|MULTIPLY|DIVIDE|DECIMAL|SEPARATOR|ENTER|LOCK|MINUS|PLUS|STAR|SLASH)|PAGE_UP|PAGE_DOWN|HOME|END|INSERT|DELETE|TAB|SPACE|ENTER|RETURN|TILDE|SEMICOLON|BACKSLASH|LEFT_BRACKET|RIGHT_BRACKET)$/

// Field name that clearly denotes a keybind (so an ambiguous value like a single letter counts).
const BINDISH_FIELD = (field: string) => /key|hotkey|bind/.test(field) || /^toggle/.test(field)

// The config files whose scalar `Field = Value` assignments we parse for keybinds. Previously only
// literal `config.lua`/`config.json`; broadened to the common config filenames so a mod that keeps
// its binds in settings.lua / keybinds.lua / options.json is covered too (but NOT main.lua, which
// holds Key.* NAME TABLES that would be false positives). The optional `[a-z0-9_]*` prefix also
// matches prefixed names like `user_config.lua` (Toggle Mercy Ring kept `TC_HOTKEY = Key.G` there,
// and the un-prefixed pattern silently missed it — a real 2026-08-25 conflict-detection gap).
const CONFIG_SCALAR_FILE = /(?:^|\/)[a-z0-9_]*(config|settings|keybinds?|hotkeys?|options|controls?)\.(lua|json)$/i

// Files worth reading for keybinds: any Lua (RegisterKeyBind), the config/menu JSONs, and .ini.
const SCANNABLE_FILE = /(\.lua|\.modconfig\.json|config\.json|\.ini)$/i

function normKey(k: string): string {
  return k.trim().toUpperCase().replace(/^KEY\./, '')
}

// A modifier+key combo string, e.g. "F8" or "CONTROL+F5". Modifiers sorted so order-independent.
function combo(mods: string[], key: string): string {
  const m = [...new Set(mods.map((x) => x.toUpperCase()))].sort()
  return (m.length ? m.join('+') + '+' : '') + key
}

// Modifiers from a same-line `mods = { "SHIFT", "CONTROL" }` string-list table (distinct from the
// `ModifierKey.X` form). For configs that pair the key with its modifiers in one table entry, e.g.
// Medicine Hotkeys' `{ key = "G", mods = { "SHIFT" } }` — this makes it read Shift+G, not a phantom
// plain G that false-conflicts with another mod's real G (a 2026-08-25 false positive).
function extractModsTable(line: string): string[] {
  const t = /\bmods?\s*=\s*\{([^}]*)\}/i.exec(line)
  if (!t) return []
  return [...t[1]!.matchAll(/["'](ctrl|control|shift|alt)["']/gi)].map((m) =>
    m[1]!.toUpperCase() === 'CTRL' ? 'CONTROL' : m[1]!.toUpperCase(),
  )
}

function walkModconfig(node: unknown, out: Set<string>): void {
  if (!node || typeof node !== 'object') return
  const n = node as Record<string, unknown>
  if (n.type === 'keybind' && n.init != null) {
    const key = normKey(String(n.init))
    if (KEY_TOKEN.test(key)) out.add(combo([], key))
  }
  for (const v of Object.values(n)) if (v && typeof v === 'object') walkModconfig(v, out)
}

// Leading-indent width (tabs → 4 spaces) — for the config-gate enclosing-if walk.
function indentOf(s: string): number {
  const m = /^([ \t]*)/.exec(s)
  return (m ? m[1]! : '').replace(/\t/g, '    ').length
}

// A keybind line is "gated off" when an ENCLOSING `if <flag> … then` names a config flag the mod
// set to false — a common debug/optional pattern (e.g. `if Config.DEBUG_SCAN_ENABLED then
// RegisterKeyBind(…)`). Such a bind never registers in-game, so it must NOT count as a conflict.
// Walk up through enclosing lines (strictly decreasing indentation); gate if any enclosing
// if-condition references a disabled flag. Well-formatted Lua only — bad indentation just doesn't
// gate (falls back to counting the bind, i.e. the pre-existing behavior).
function gatedByDisabledFlag(lines: string[], idx: number, disabled: Set<string>): boolean {
  if (!disabled.size) return false
  let curInd = indentOf(lines[idx]!)
  for (let j = idx - 1; j >= 0 && curInd > 0; j--) {
    const t = lines[j]!.trim()
    if (t === '' || t.startsWith('--')) continue
    const li = indentOf(lines[j]!)
    if (li >= curInd) continue // sibling / deeper — not an enclosing line
    curInd = li
    if (/^if\b/.test(t) && /\bthen\b/.test(t)) {
      for (const f of disabled) if (new RegExp(`\\b${f}\\b`).test(t)) return true
    }
  }
  return false
}

// Config flags the mod assigns `false` (Lua `X = false` / JSON `"X": false`). The gate may live in
// config.lua while the bind is in another script, so these are collected mod-wide (see combosForMod).
export function collectDisabledFlags(text: string): string[] {
  const out: string[] = []
  for (let line of text.split(/\r?\n/)) {
    const c = line.indexOf('--')
    if (c >= 0) line = line.slice(0, c)
    let m = /([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*false\b/.exec(line)
    if (m) {
      out.push(m[1]!.split('.').pop()!)
      continue
    }
    m = /"([A-Za-z_][A-Za-z0-9_]*)"\s*:\s*false\b/.exec(line)
    if (m) out.push(m[1]!)
  }
  return out
}

// Pull keybind combos out of one file's text. `disabled` = mod-wide flags set to false; a bind
// gated behind one (see gatedByDisabledFlag) is skipped so it never shows as a phantom conflict.
function extractFromText(name: string, text: string, out: Set<string>, disabled: Set<string>): void {
  const lower = name.toLowerCase()
  const lines = text.split(/\r?\n/)

  // Lua RegisterKeyBind(Key.X, { ModifierKey.Y, … }, …) — line-based so each can be gate-checked.
  for (let i = 0; i < lines.length; i++) {
    const rk = /RegisterKeyBind\s*\(\s*Key\.([A-Z0-9_]+)\s*(?:,\s*\{([^}]*)\})?/g
    let m: RegExpExecArray | null
    while ((m = rk.exec(lines[i]!))) {
      const key = normKey(m[1]!)
      if (!KEY_TOKEN.test(key) || NOT_KEYS.has(key)) continue
      if (gatedByDisabledFlag(lines, i, disabled)) continue
      const mods = (m[2] ?? '').match(/ModifierKey\.([A-Z_]+)/g)?.map((x) => x.replace('ModifierKey.', '')) ?? []
      out.add(combo(mods, key))
    }
  }

  // DekModConfigMenu .modconfig.json → settings of type "keybind"
  if (lower.endsWith('.modconfig.json')) {
    try {
      walkModconfig(JSON.parse(text), out)
    } catch {
      /* not valid json — skip */
    }
    return
  }

  // .ini keybind assignments — `Overlay = F6`, `toggle = F3`, `ScanKey=F8`, `HealPal = F2`.
  // .ini was the scanner's blind spot: Hotkey Consumables, the Aetherion scanners, Base
  // Automation, and GuildSight keep their binds here, so their conflicts went unseen. Inline
  // modifiers supported: `Shift+F6`, `Ctrl + F1`, `Alt+F1`. A value that's a strong key token
  // (F-key / numpad / named) counts regardless of the field name; ambiguous values (a single
  // letter) still need a bind-ish field, keeping data lines (colors, scales) out.
  if (lower.endsWith('.ini')) {
    for (let i = 0; i < lines.length; i++) {
      let line = lines[i]!
      const cm = line.search(/[;#]/) // strip ini comment
      if (cm >= 0) line = line.slice(0, cm)
      const mm = /^\s*([A-Za-z0-9_]+)\s*[:=]\s*(.+?)\s*$/.exec(line)
      if (!mm) continue
      const field = mm[1]!.toLowerCase()
      let val = mm[2]!.replace(/^["']|["']$/g, '').trim()
      const mods: string[] = []
      for (;;) {
        const mx = /^(ctrl|control|shift|alt)\s*\+\s*(.+)$/i.exec(val)
        if (!mx) break
        mods.push(mx[1]!.toUpperCase() === 'CTRL' ? 'CONTROL' : mx[1]!.toUpperCase())
        val = mx[2]!.trim()
      }
      const key = normKey(val)
      if (!KEY_TOKEN.test(key) || NOT_KEYS.has(key)) continue
      if (!STRONG_KEY.test(key) && !BINDISH_FIELD(field)) continue
      out.add(combo(mods, key))
    }
    return
  }

  // config.lua / config.json → keybind assignments. Catches:
  //   Field = "F8"  |  Field = F8  |  Field = Key.NUM_FIVE  (dotted UE4SS ref)
  //   Field = { Key.G, ModifierKey.SHIFT }  (config table, e.g. Multi Party SummonAll)
  // A value written as `Key.X` is treated as a keybind REGARDLESS of the field name (catches
  // fields like `SummonAdditionalPal = Key.G`); otherwise the field name must look like a bind.
  if (CONFIG_SCALAR_FILE.test(lower)) {
    // Some mods express modifiers as sibling booleans rather than inline: e.g. Pal Insight's
    // `settingsKey = "F6"` + `settingsAlt = true` (= Alt+F6). Map each shared prefix → its
    // enabled modifiers so `<prefix>Key` emits the combined chord, not the bare key.
    const modFlags = new Map<string, string[]>()
    for (const ln of lines) {
      const mf = /\b([A-Za-z0-9_]*?)(Shift|Ctrl|Control|Alt)\s*[:=]\s*true\b/.exec(ln)
      if (mf) {
        const pre = mf[1]!.toLowerCase()
        const mod = mf[2]!.toUpperCase() === 'CTRL' ? 'CONTROL' : mf[2]!.toUpperCase()
        modFlags.set(pre, [...(modFlags.get(pre) ?? []), mod])
      }
    }
    for (let i = 0; i < lines.length; i++) {
      let line = lines[i]!
      const c = line.indexOf('--') // strip trailing Lua comment
      if (c >= 0) line = line.slice(0, c)
      // Skip Lua CODE lines in a config.lua that's really a module, not pure data: a `local x = …`
      // declaration or a string-concat (`..`) is code, not a keybind. Bit us via Pal Base Info's
      // `local body = "return { … }"` → a phantom RETURN. Config data fields never start with `local`.
      if (/^\s*local\b/.test(line) || /\.\./.test(line)) continue
      // Table form: … = { Key.X, ModifierKey.Y, … }
      const tbl = /[:=]\s*\{([^}]*\bKey\.[A-Za-z0-9_]+[^}]*)\}/.exec(line)
      if (tbl) {
        if (gatedByDisabledFlag(lines, i, disabled)) continue
        const km = /\bKey\.([A-Za-z0-9_]+)/.exec(tbl[1]!)
        const mods = (tbl[1]!.match(/ModifierKey\.([A-Z_]+)/g) ?? []).map((x) => x.replace('ModifierKey.', ''))
        if (km) {
          const key = normKey(km[1]!)
          if (KEY_TOKEN.test(key) && !NOT_KEYS.has(key)) out.add(combo(mods, key))
        }
        continue
      }
      // Scalar form: Field = value. Value may carry a `Key.` prefix and/or an inline modifier
      // prefix ("Shift+F8" / "Ctrl+F1"), so `+` is allowed in the captured value.
      const mm = /([A-Za-z0-9_]+)\s*[:=]\s*"?((?:Key\.)?[A-Za-z0-9_+]+)"?/.exec(line)
      if (!mm) continue
      const field = mm[1]!.toLowerCase()
      let val = mm[2]!
      const isKeyRef = /^Key\./i.test(val)
      // Peel inline modifier prefixes off the value (Shift+ / Ctrl+ / Alt+).
      const inlineMods: string[] = []
      for (;;) {
        const mx = /^(ctrl|control|shift|alt)\s*\+\s*(.+)$/i.exec(val)
        if (!mx) break
        inlineMods.push(mx[1]!.toUpperCase() === 'CTRL' ? 'CONTROL' : mx[1]!.toUpperCase())
        val = mx[2]!.trim()
      }
      const key = normKey(val)
      if (!KEY_TOKEN.test(key) || NOT_KEYS.has(key)) continue
      // Value must be unambiguous (Key.X ref or a strong token) OR the field must denote a bind
      // — so ambiguous single-letter/number-word data doesn't get miscounted.
      if (!isKeyRef && !STRONG_KEY.test(key) && !BINDISH_FIELD(field)) continue
      if (gatedByDisabledFlag(lines, i, disabled)) continue
      // Combine THREE modifier sources: sibling-boolean (settingsKey + settingsAlt), inline-prefix
      // (Shift+F8), and a same-entry `mods = { "SHIFT" }` table (Medicine Hotkeys).
      const pre = field.endsWith('key') ? field.slice(0, -3) : field
      out.add(combo([...(modFlags.get(pre) ?? []), ...inlineMods, ...extractModsTable(line)], key))
    }
  }
}

type ScanFile = { name: string; text: string }

async function filesFromPayloadZip(zipPath: string, skip: (p: string) => boolean): Promise<ScanFile[]> {
  let zip: AdmZip
  try {
    zip = new AdmZip(zipPath)
  } catch {
    return []
  }
  const out: ScanFile[] = []
  for (const e of zip.getEntries()) {
    if (e.isDirectory) continue
    const n = e.entryName.replace(/\\/g, '/')
    if (!SCANNABLE_FILE.test(n)) continue
    if (skip(n)) continue // a config-override replaces this file — scan the override instead
    try {
      out.push({ name: n, text: e.getData().toString('utf8') })
    } catch {
      /* skip unreadable entry */
    }
  }
  return out
}

async function filesFromContentDir(dir: string, base: string, skip: (p: string) => boolean): Promise<ScanFile[]> {
  const out: ScanFile[] = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...(await filesFromContentDir(p, base, skip)))
    else if (SCANNABLE_FILE.test(e.name)) {
      if (skip(p.slice(base.length + 1).replace(/\\/g, '/'))) continue
      try {
        out.push({ name: e.name, text: await readFile(p, 'utf8') })
      } catch {
        /* skip */
      }
    }
  }
  return out
}

// Scan a mod's EFFECTIVE keybinds — the config-overrides that ship in the loadout replace the
// payload's shipped config, so the conflict view reflects what will actually load (e.g. after an
// auto/manual remap). A payload config file is skipped when an override targets it (matched by
// its mod-root-relative path as a path suffix), and the override content is scanned in its place.
// Two-pass: gather all files, collect the flags the mod sets false (the gate may be in config.lua
// while the bind is in another script), then scan each with those config gates applied.
async function combosForMod(m: ClientMod): Promise<Set<string>> {
  const store = clientModStorePath(m.id)
  const out = new Set<string>()
  const overrides = await readClientModConfigOverrides(m.id).catch(() => [])
  const skip = (p: string) => overrides.some((o) => p === o.relWithin || p.endsWith('/' + o.relWithin))

  const files: ScanFile[] = []
  if (m.payload === 'payload.zip') files.push(...(await filesFromPayloadZip(join(store, 'payload.zip'), skip)))
  else if (m.payload === 'content') files.push(...(await filesFromContentDir(join(store, 'content'), join(store, 'content'), skip)))
  else return out
  for (const o of overrides) {
    if (!SCANNABLE_FILE.test(o.relWithin)) continue
    try {
      files.push({ name: o.relWithin, text: await readFile(o.absPath, 'utf8') })
    } catch {
      /* skip */
    }
  }

  const disabled = new Set<string>()
  for (const f of files) for (const flag of collectDisabledFlags(f.text)) disabled.add(flag)
  for (const f of files) {
    try {
      extractFromText(f.name, f.text, out, disabled)
    } catch {
      /* skip */
    }
  }
  return out
}

export type KeybindConflict = { combo: string; mods: string[] }
export type KeybindScan = {
  conflicts: KeybindConflict[] // key combo → the (2+) kept mods that bind it
  perMod: Record<string, { combo: string; others: string[] }[]> // modId → its conflicting binds
  perModAll: { name: string; combos: string[] }[] // full table: every kept mod that binds ≥1 key
  hotbarCollisions: KeybindConflict[] // a mod binds a native action-bar number key (1-8)
  nativeActions: { mod: string; action: string; note: string }[] // native Key-Config actions surfaced
  scannedAt: number
}

// Cache keyed by the kept-mod set signature (id+size), so re-scans only happen when it changes.
let cache: { sig: string; scan: KeybindScan } | null = null

export async function scanClientKeybinds(): Promise<KeybindScan> {
  const kept = (await listClientMods()).filter((m) => m.keep)
  // signature: ids + payload sizes (a re-staged mod changes its size) + config-override
  // relWithins (a remap adds/removes an override → the effective binds change).
  const sigParts: string[] = []
  for (const m of kept) {
    const p = m.payload === 'payload.zip' ? join(clientModStorePath(m.id), 'payload.zip') : null
    const size = p ? await stat(p).then((s) => s.size).catch(() => 0) : 0
    const ovs = await readClientModConfigOverrides(m.id).catch(() => [])
    const ov = (
      await Promise.all(
        ovs.map(async (o) => `${o.relWithin}@${await stat(o.absPath).then((s) => `${s.size}.${Math.round(s.mtimeMs)}`).catch(() => '0')}`),
      )
    )
      .sort()
      .join(',')
    sigParts.push(`${m.id}:${size}:${ov}`)
  }
  // ReShade preset/overlay keys ship on the same client, so fold them into the same conflict
  // scan (a preset effect-key vs a mod keybind is the same class of collision).
  const reshadeSources = await reshadeKeybindSources().catch(() => [])
  const sig = `${sigParts.join('|')}||${await reshadeKeybindSignature().catch(() => 'reshade:?')}`
  if (cache && cache.sig === sig) return cache.scan

  const modCombos: { id: string; name: string; combos: Set<string> }[] = []
  for (const m of kept) modCombos.push({ id: m.id, name: m.name, combos: await combosForMod(m) })
  for (const s of reshadeSources) modCombos.push(s)

  // combo → modIds that bind it
  const byCombo = new Map<string, string[]>()
  for (const mc of modCombos) for (const c of mc.combos) byCombo.set(c, [...(byCombo.get(c) ?? []), mc.id])

  const nameOf = new Map(modCombos.map((mc) => [mc.id, mc.name]))
  const conflicts: KeybindConflict[] = []
  const perMod: Record<string, { combo: string; others: string[] }[]> = {}
  for (const [c, ids] of byCombo) {
    if (ids.length < 2) continue
    conflicts.push({ combo: c, mods: ids.map((i) => nameOf.get(i)!).sort() })
    for (const id of ids) {
      ;(perMod[id] ??= []).push({ combo: c, others: ids.filter((x) => x !== id).map((i) => nameOf.get(i)!).sort() })
    }
  }
  conflicts.sort((a, b) => a.combo.localeCompare(b.combo))

  // Full per-mod table (feeds the cheat-sheet / UI), native action-bar collisions, and the
  // native-registered actions the config parser can't see.
  const perModAll = modCombos
    .filter((mc) => mc.combos.size)
    .map((mc) => ({ name: mc.name, combos: [...mc.combos].sort() }))
    .sort((a, b) => a.name.localeCompare(b.name))
  const hotbarCollisions: KeybindConflict[] = []
  for (const [c, ids] of byCombo) {
    const bare = c.includes('+') ? c.slice(c.lastIndexOf('+') + 1) : c
    if (NATIVE_HOTBAR.has(bare)) hotbarCollisions.push({ combo: c, mods: ids.map((i) => nameOf.get(i)!).sort() })
  }
  hotbarCollisions.sort((a, b) => a.combo.localeCompare(b.combo))
  const nativeActions = kept.flatMap((m) => {
    const hit = NATIVE_KEY_MODS.find((r) => r.match.test(m.name))
    return hit ? [{ mod: m.name, action: hit.action, note: hit.note }] : []
  })

  const scan: KeybindScan = { conflicts, perMod, perModAll, hotbarCollisions, nativeActions, scannedAt: Date.now() }
  cache = { sig, scan }
  return scan
}

// Per-mod keybind listing for the generated friend cheat-sheet (keybinds.txt). Unlike
// scanClientKeybinds (which only reports keys bound by 2+ mods), this returns EVERY kept client
// mod that binds at least one key, with its detected combos — so the cheat-sheet is accurate for
// whatever mods an operator actually ships, with no hardcoded mod list. Override-aware (reflects
// loadout config-overrides) and includes ReShade preset/overlay keys.
export async function scanPerModKeybinds(): Promise<{ name: string; combos: string[] }[]> {
  const kept = (await listClientMods()).filter((m) => m.keep)
  const rows: { name: string; combos: string[] }[] = []
  for (const m of kept) {
    const combos = await combosForMod(m)
    if (combos.size) rows.push({ name: m.name, combos: [...combos].sort() })
  }
  for (const s of await reshadeKeybindSources().catch(() => [])) {
    if (s.combos.size) rows.push({ name: s.name, combos: [...s.combos].sort() })
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name))
}
