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
  /^(F([1-9]|1[0-9]|2[0-4])|[A-Z]|ZERO|ONE|TWO|THREE|FOUR|FIVE|SIX|SEVEN|EIGHT|NINE|NUM(PAD)?_?[A-Z0-9]+|PAGE_UP|PAGE_DOWN|HOME|END|INSERT|DELETE|TAB|SPACE|ENTER|RETURN|TILDE|SEMICOLON|BACKSLASH|LEFT_BRACKET|RIGHT_BRACKET)$/

const NOT_KEYS = new Set(['FALSE', 'TRUE', 'NIL', 'NONE', 'NULL', 'DISABLED', ''])

function normKey(k: string): string {
  return k.trim().toUpperCase().replace(/^KEY\./, '')
}

// A modifier+key combo string, e.g. "F8" or "CONTROL+F5". Modifiers sorted so order-independent.
function combo(mods: string[], key: string): string {
  const m = [...new Set(mods.map((x) => x.toUpperCase()))].sort()
  return (m.length ? m.join('+') + '+' : '') + key
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

  // config.lua / config.json → keybind assignments. Catches:
  //   Field = "F8"  |  Field = F8  |  Field = Key.NUM_FIVE  (dotted UE4SS ref)
  //   Field = { Key.G, ModifierKey.SHIFT }  (config table, e.g. Multi Party SummonAll)
  // A value written as `Key.X` is treated as a keybind REGARDLESS of the field name (catches
  // fields like `SummonAdditionalPal = Key.G`); otherwise the field name must look like a bind.
  if (/config\.(lua|json)$/i.test(lower)) {
    for (let i = 0; i < lines.length; i++) {
      let line = lines[i]!
      const c = line.indexOf('--') // strip trailing Lua comment
      if (c >= 0) line = line.slice(0, c)
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
      // Scalar form: Field = value  (value may carry a `Key.` prefix).
      const mm = /([A-Za-z0-9_]+)\s*[:=]\s*"?((?:Key\.)?[A-Za-z0-9_]+)"?/.exec(line)
      if (!mm) continue
      const field = mm[1]!.toLowerCase()
      const val = mm[2]!
      const isKeyRef = /^Key\./i.test(val)
      if (!isKeyRef && !/key|hotkey|bind/.test(field) && !/^toggle/.test(field)) continue
      const key = normKey(val)
      if (!KEY_TOKEN.test(key) || NOT_KEYS.has(key)) continue
      if (gatedByDisabledFlag(lines, i, disabled)) continue
      out.add(combo([], key))
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
    if (!/(\.lua|\.modconfig\.json|config\.json)$/i.test(n)) continue
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
    else if (/(\.lua|\.modconfig\.json|config\.json)$/i.test(e.name)) {
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
    if (!/(\.lua|\.modconfig\.json|config\.json)$/i.test(o.relWithin)) continue
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
  const scan: KeybindScan = { conflicts, perMod, scannedAt: Date.now() }
  cache = { sig, scan }
  return scan
}
