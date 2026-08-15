// SERVER-ONLY. PATCH (not upstream): detect keybind conflicts across the CLIENT mods that ship
// together in the loadout. Keybinds only fire on a player's client (the dedicated server is
// headless), so this scans the kept client mods' payloads and reports keys bound by 2+ mods.
// Modifier-aware: Ctrl+F5 (e.g. Smart Production Queue) does NOT clash with plain F5. Detector
// only — it never edits anything; operators remap in each mod's own config.
import AdmZip from 'adm-zip'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { clientModStorePath, listClientMods, type ClientMod } from '@/lib/client-mods'

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

// Pull keybind combos out of one file's text, by file type.
function extractFromText(name: string, text: string, out: Set<string>): void {
  const lower = name.toLowerCase()

  // Lua RegisterKeyBind(Key.X, { ModifierKey.Y, … }, …)
  const rk = /RegisterKeyBind\s*\(\s*Key\.([A-Z0-9_]+)\s*(?:,\s*\{([^}]*)\})?/g
  let m: RegExpExecArray | null
  while ((m = rk.exec(text))) {
    const key = normKey(m[1]!)
    if (!KEY_TOKEN.test(key) || NOT_KEYS.has(key)) continue
    const mods = (m[2] ?? '').match(/ModifierKey\.([A-Z_]+)/g)?.map((x) => x.replace('ModifierKey.', '')) ?? []
    out.add(combo(mods, key))
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

  // config.lua / config.json → fields whose NAME looks like a keybind (…Key/…Hotkey/…Bind, or
  // Toggle…), with a value that is a recognized key token.
  if (/config\.(lua|json)$/i.test(lower)) {
    for (let line of text.split(/\r?\n/)) {
      const c = line.indexOf('--') // strip trailing Lua comment
      if (c >= 0) line = line.slice(0, c)
      const mm = /([A-Za-z0-9_]+)\s*[:=]\s*"?([A-Za-z0-9_]+)"?/.exec(line)
      if (!mm) continue
      const field = mm[1]!.toLowerCase()
      if (!/key|hotkey|bind/.test(field) && !/^toggle/.test(field)) continue
      const key = normKey(mm[2]!)
      if (KEY_TOKEN.test(key) && !NOT_KEYS.has(key)) out.add(combo([], key))
    }
  }
}

async function combosFromPayloadZip(zipPath: string): Promise<Set<string>> {
  const out = new Set<string>()
  let zip: AdmZip
  try {
    zip = new AdmZip(zipPath)
  } catch {
    return out
  }
  for (const e of zip.getEntries()) {
    if (e.isDirectory) continue
    const n = e.entryName.replace(/\\/g, '/')
    if (!/(\.lua|\.modconfig\.json|config\.json)$/i.test(n)) continue
    try {
      extractFromText(n, e.getData().toString('utf8'), out)
    } catch {
      /* skip unreadable entry */
    }
  }
  return out
}

async function combosFromContentDir(dir: string, out: Set<string>): Promise<void> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) await combosFromContentDir(p, out)
    else if (/(\.lua|\.modconfig\.json|config\.json)$/i.test(e.name)) {
      try {
        extractFromText(e.name, await readFile(p, 'utf8'), out)
      } catch {
        /* skip */
      }
    }
  }
}

async function combosForMod(m: ClientMod): Promise<Set<string>> {
  const store = clientModStorePath(m.id)
  if (m.payload === 'payload.zip') return combosFromPayloadZip(join(store, 'payload.zip'))
  if (m.payload === 'content') {
    const out = new Set<string>()
    await combosFromContentDir(join(store, 'content'), out)
    return out
  }
  return new Set()
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
  // signature: ids + payload sizes (a re-staged mod changes its size)
  const sigParts: string[] = []
  for (const m of kept) {
    const p = m.payload === 'payload.zip' ? join(clientModStorePath(m.id), 'payload.zip') : null
    const size = p ? await stat(p).then((s) => s.size).catch(() => 0) : 0
    sigParts.push(`${m.id}:${size}`)
  }
  const sig = sigParts.join('|')
  if (cache && cache.sig === sig) return cache.scan

  const modCombos: { id: string; name: string; combos: Set<string> }[] = []
  for (const m of kept) modCombos.push({ id: m.id, name: m.name, combos: await combosForMod(m) })

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
