// SERVER-ONLY. PATCH (not upstream): Keybind Manager Phase 2 — the descriptor layer that turns the
// scanner's read-only conflict view into a one-click REMAP. For a kept client mod it LOCATES every
// bind (file + line + format) and knows, per format, what rewrite that mod's OWN parser actually
// understands — the "safe capability matrix" the spec (docs/specs/keybind-manager.md §2) requires:
//
//   format                     | rebind key | change modifiers
//   register-keybind-payload   |    yes     | yes  (UE4SS parses `RegisterKeyBind(Key.X,{ModifierKey.Y},…)`)
//   table-with-mods            |    yes     | yes  (the mod reads a `{Key.X,ModifierKey.Y}` / `mods={}` list)
//   scalar-lua (sibling-bool)  |    yes     | yes  (toggle the mod's own `…Alt=true` sibling flags)
//   scalar-lua / ini (inline)  |    yes     | yes  (the value already carries `Shift+` → the mod parses it)
//   scalar-lua / ini (bare)    |    yes     | NO   (no evidence the mod parses a modifier here)
//   modconfig-json             |    no      | no   (surfaced only — rebind via the mod's in-game menu)
//
// So a bare scalar can only move to another BARE key (why the manual pass added modifiers via
// PAYLOAD edits, not config); the free-key suggester respects this. Rewrites are written as loadout
// config-overrides (reversible; data volume) via lib/client-mod-config, exactly like the manual
// remap, and .lua writes are luaparse-validated on save so a syntax-breaking edit is refused.
//
// The locator MIRRORS lib/keybind-scan's extractFromText branch-for-branch and reuses its exact
// primitives (KEY_TOKEN, combo(), normKey(), extractModsTable(), gatedByDisabledFlag) so a slot's
// `combo` is byte-identical to the conflict combo the scanner reports — that identity is what lets
// the UI map "conflict on CONTROL+F5" back to the precise slot(s) that produce it.
import { listClientMods, type ClientMod } from '@/lib/client-mods'
import { readClientModFile, saveClientModConfig } from '@/lib/client-mod-config'
import {
  BINDISH_FIELD,
  CONFIG_SCALAR_FILE,
  collectModScanFiles,
  combo,
  extractModsTable,
  gatedByDisabledFlag,
  KEY_TOKEN,
  normKey,
  NOT_KEYS,
  STRONG_KEY,
  type ScanFile,
} from '@/lib/keybind-scan'

export type BindFormat =
  | 'register-keybind-payload'
  | 'table-with-mods'
  | 'scalar-lua'
  | 'ini'
  | 'modconfig-json'

// A single editable (or at least surfaced) keybind, with everything the rewriter needs.
export type BindSlot = {
  modId: string
  modName: string
  file: string // relWithin the produced Mods/<folder> — the override target path
  lineIndex: number // 0-based, in the effective file text
  format: BindFormat
  field: string | null // config field name (scalar/ini/table), null for payload
  key: string // bare key token, e.g. "F7"
  mods: string[] // current modifiers, e.g. ["CONTROL"]
  combo: string // current effective combo (matches the scanner's conflict combo exactly)
  canRebindKey: boolean
  canModify: boolean // can the mod's parser accept a modifier change in THIS slot?
  label: string // human label for the UI (field name or "RegisterKeyBind")
  raw: string // the exact source line (preview + re-location anchor)
  // ── internal rewrite hints (not for display) ──
  matchText?: string // payload: the exact `RegisterKeyBind(Key.X[,{…}]` prefix to replace
  hadQuotes?: boolean // scalar: value was quoted in source
  isKeyRef?: boolean // scalar: value written as `Key.X`
  modMechanism?: 'inline' | 'mods-table' | 'sibling-bool' | 'none' // how modifiers are expressed
  siblingFlags?: { field: string; mod: string; enabled: boolean }[] // scalar sibling-boolean flags for this prefix
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Locator — mirrors extractFromText, but records source + capability instead of just a combo.
// ────────────────────────────────────────────────────────────────────────────────────────────

function pushPayloadSlots(m: ClientMod, f: ScanFile, disabled: Set<string>, lines: string[], slots: BindSlot[]): void {
  for (let i = 0; i < lines.length; i++) {
    const rk = /RegisterKeyBind\s*\(\s*Key\.([A-Z0-9_]+)\s*(?:,\s*\{([^}]*)\})?/g
    let mm: RegExpExecArray | null
    while ((mm = rk.exec(lines[i]!))) {
      const key = normKey(mm[1]!)
      if (!KEY_TOKEN.test(key) || NOT_KEYS.has(key)) continue
      if (gatedByDisabledFlag(lines, i, disabled)) continue
      const mods = (mm[2] ?? '').match(/ModifierKey\.([A-Z_]+)/g)?.map((x) => x.replace('ModifierKey.', '')) ?? []
      slots.push({
        modId: m.id,
        modName: m.name,
        file: f.name,
        lineIndex: i,
        format: 'register-keybind-payload',
        field: null,
        key,
        mods,
        combo: combo(mods, key),
        canRebindKey: true,
        canModify: true,
        label: 'RegisterKeyBind',
        raw: lines[i]!,
        matchText: mm[0],
        modMechanism: 'mods-table',
      })
    }
  }
}

function pushIniSlots(m: ClientMod, f: ScanFile, lines: string[], slots: BindSlot[]): void {
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!
    const cm = line.search(/[;#]/)
    if (cm >= 0) line = line.slice(0, cm)
    const mm = /^\s*([A-Za-z0-9_]+)\s*[:=]\s*(.+?)\s*$/.exec(line)
    if (!mm) continue
    const field = mm[1]!.toLowerCase()
    const rawVal = mm[2]!.trim()
    let val = rawVal.replace(/^["']|["']$/g, '').trim()
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
    slots.push({
      modId: m.id,
      modName: m.name,
      file: f.name,
      lineIndex: i,
      format: 'ini',
      field: mm[1]!,
      key,
      mods,
      combo: combo(mods, key),
      canRebindKey: true,
      canModify: mods.length > 0, // only if the value already proves the mod parses `Shift+`
      label: mm[1]!,
      raw: lines[i]!,
      hadQuotes: /^["']/.test(rawVal),
      modMechanism: mods.length > 0 ? 'inline' : 'none',
    })
  }
}

function pushScalarSlots(m: ClientMod, f: ScanFile, disabled: Set<string>, lines: string[], slots: BindSlot[]): void {
  // Sibling-boolean modifier flags (Pal Insight's `settingsKey="F6"` + `settingsAlt=true`). Capture
  // BOTH true and false so a modifier change can flip them; keyed by shared prefix.
  const modFlags = new Map<string, { field: string; mod: string; enabled: boolean }[]>()
  for (const ln of lines) {
    const mf = /\b([A-Za-z0-9_]*?)(Shift|Ctrl|Control|Alt)\s*[:=]\s*(true|false)\b/.exec(ln)
    if (mf) {
      const pre = mf[1]!.toLowerCase()
      const mod = mf[2]!.toUpperCase() === 'CTRL' ? 'CONTROL' : mf[2]!.toUpperCase()
      modFlags.set(pre, [...(modFlags.get(pre) ?? []), { field: `${mf[1]}${mf[2]}`, mod, enabled: mf[3] === 'true' }])
    }
  }

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!
    const c = line.indexOf('--')
    if (c >= 0) line = line.slice(0, c)
    if (/^\s*local\b/.test(line) || /\.\./.test(line)) continue

    // Table form: … = { Key.X, ModifierKey.Y, … }
    const tbl = /[:=]\s*\{([^}]*\bKey\.[A-Za-z0-9_]+[^}]*)\}/.exec(line)
    if (tbl) {
      if (gatedByDisabledFlag(lines, i, disabled)) continue
      const km = /\bKey\.([A-Za-z0-9_]+)/.exec(tbl[1]!)
      const mods = (tbl[1]!.match(/ModifierKey\.([A-Z_]+)/g) ?? []).map((x) => x.replace('ModifierKey.', ''))
      if (km) {
        const key = normKey(km[1]!)
        if (KEY_TOKEN.test(key) && !NOT_KEYS.has(key)) {
          const fieldM = /([A-Za-z0-9_]+)\s*[:=]\s*\{/.exec(line)
          slots.push({
            modId: m.id,
            modName: m.name,
            file: f.name,
            lineIndex: i,
            format: 'table-with-mods',
            field: fieldM ? fieldM[1]! : null,
            key,
            mods,
            combo: combo(mods, key),
            canRebindKey: true,
            canModify: true,
            label: fieldM ? fieldM[1]! : 'keybind',
            raw: lines[i]!,
            modMechanism: 'mods-table',
          })
        }
      }
      continue
    }

    // Scalar form: Field = value
    const mm = /([A-Za-z0-9_]+)\s*[:=]\s*"?((?:Key\.)?[A-Za-z0-9_+]+)"?/.exec(line)
    if (!mm) continue
    const field = mm[1]!.toLowerCase()
    let val = mm[2]!
    const isKeyRef = /^Key\./i.test(val)
    const inlineMods: string[] = []
    for (;;) {
      const mx = /^(ctrl|control|shift|alt)\s*\+\s*(.+)$/i.exec(val)
      if (!mx) break
      inlineMods.push(mx[1]!.toUpperCase() === 'CTRL' ? 'CONTROL' : mx[1]!.toUpperCase())
      val = mx[2]!.trim()
    }
    const key = normKey(val)
    if (!KEY_TOKEN.test(key) || NOT_KEYS.has(key)) continue
    if (!isKeyRef && !STRONG_KEY.test(key) && !BINDISH_FIELD(field)) continue
    if (gatedByDisabledFlag(lines, i, disabled)) continue

    const pre = field.endsWith('key') ? field.slice(0, -3) : field
    const sibs = modFlags.get(pre) ?? []
    const tableMods = extractModsTable(line)
    const curMods = [...sibs.filter((s) => s.enabled).map((s) => s.mod), ...inlineMods, ...tableMods]
    // Which mechanism can express a modifier change?
    let modMechanism: BindSlot['modMechanism'] = 'none'
    if (tableMods.length > 0 || /\bmods?\s*=\s*\{/i.test(line)) modMechanism = 'mods-table'
    else if (sibs.length > 0) modMechanism = 'sibling-bool'
    else if (inlineMods.length > 0) modMechanism = 'inline'

    slots.push({
      modId: m.id,
      modName: m.name,
      file: f.name,
      lineIndex: i,
      format: 'scalar-lua',
      field: mm[1]!,
      key,
      mods: [...new Set(curMods)],
      combo: combo(curMods, key),
      canRebindKey: true,
      canModify: modMechanism !== 'none',
      label: mm[1]!,
      raw: lines[i]!,
      hadQuotes: new RegExp(`"${mm[2]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).test(line),
      isKeyRef,
      modMechanism,
      siblingFlags: sibs.length ? sibs : undefined,
    })
  }
}

function pushModconfigSlots(m: ClientMod, f: ScanFile, slots: BindSlot[]): void {
  let json: unknown
  try {
    json = JSON.parse(f.text)
  } catch {
    return
  }
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    const n = node as Record<string, unknown>
    if (n.type === 'keybind' && n.init != null) {
      const key = normKey(String(n.init))
      if (KEY_TOKEN.test(key)) {
        slots.push({
          modId: m.id,
          modName: m.name,
          file: f.name,
          lineIndex: -1,
          format: 'modconfig-json',
          field: typeof n.name === 'string' ? n.name : null,
          key,
          mods: [],
          combo: combo([], key),
          canRebindKey: false, // rebind via the mod's in-game config menu — JSON reformat too risky
          canModify: false,
          label: (typeof n.title === 'string' && n.title) || (typeof n.name === 'string' && n.name) || 'keybind',
          raw: `"${n.name ?? 'keybind'}": "${n.init}"`,
        })
      }
    }
    for (const v of Object.values(n)) if (v && typeof v === 'object') walk(v)
  }
  walk(json)
}

function locateInFile(m: ClientMod, f: ScanFile, disabled: Set<string>, slots: BindSlot[]): void {
  const lower = f.name.toLowerCase()
  const lines = f.text.split(/\r?\n/)
  // RegisterKeyBind runs for every file (mirrors extractFromText), then the format-specific branch.
  pushPayloadSlots(m, f, disabled, lines, slots)
  if (lower.endsWith('.modconfig.json')) return pushModconfigSlots(m, f, slots)
  if (lower.endsWith('.ini')) return pushIniSlots(m, f, lines, slots)
  if (CONFIG_SCALAR_FILE.test(lower)) return pushScalarSlots(m, f, disabled, lines, slots)
}

// All editable/surfaced binds for one kept mod (override-aware — reflects what will actually ship).
export async function listModBindSlots(modId: string): Promise<BindSlot[]> {
  const m = (await listClientMods()).find((x) => x.id === modId)
  if (!m) return []
  const { files, disabled } = await collectModScanFiles(m)
  const slots: BindSlot[] = []
  for (const f of files) {
    // Never LOCATE a bind in a template the mod doesn't read (`*.example.ini`, `config.default.lua`,
    // `*.sample.json`) — rewriting one is a no-op the operator can't see, and it doubles every slot
    // (a real 2026-08 gotcha: BuildFlight reads BuildFlightConfig.ini, not the shipped .example.ini).
    if (/\.(example|sample|default)\.[^./]+$/i.test(f.name)) continue
    try {
      locateInFile(m, f, disabled, slots)
    } catch {
      /* skip a malformed file rather than fail the whole mod */
    }
  }
  // Dedupe exact duplicates (same file+line+combo+format) that a doubly-matching line could yield.
  const seen = new Set<string>()
  return slots.filter((s) => {
    const k = `${s.file}#${s.lineIndex}#${s.format}#${s.combo}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

// All binds across every kept mod (feeds the UI table + the auto-resolver).
export async function listAllBindSlots(): Promise<BindSlot[]> {
  const kept = (await listClientMods()).filter((m) => m.keep)
  const all: BindSlot[] = []
  for (const m of kept) all.push(...(await listModBindSlots(m.id)))
  return all
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Rewriter — produce the edited file content for a slot → new key/modifiers.
// ────────────────────────────────────────────────────────────────────────────────────────────

export type RewritePlan =
  | { ok: true; modId: string; modName: string; file: string; before: string; after: string; detail: string }
  | { ok: false; reason: string }

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function modTableLua(mods: string[]): string {
  return mods.length ? `{ ${mods.map((x) => `ModifierKey.${x}`).join(', ')} }` : ''
}

// Rewrite the single located line for scalar/ini/table/payload forms. Returns the new line, or null
// if the edit isn't expressible in this format.
function rewriteLine(slot: BindSlot, line: string, toKey: string, toMods: string[]): string | null {
  switch (slot.format) {
    case 'register-keybind-payload': {
      if (!slot.matchText) return null
      const rebuilt = `RegisterKeyBind(Key.${toKey}${toMods.length ? `, ${modTableLua(toMods)}` : ''}`
      return line.replace(slot.matchText, rebuilt)
    }
    case 'table-with-mods': {
      // … = { Key.OLD, ModifierKey.X, … } → { Key.NEW, ModifierKey.Y, … }
      return line.replace(/(\{)([^}]*\bKey\.[A-Za-z0-9_]+[^}]*)(\})/, (_full, open, _inner, close) => {
        const parts = [`Key.${toKey}`, ...toMods.map((x) => `ModifierKey.${x}`)]
        return `${open} ${parts.join(', ')} ${close}`
      })
    }
    case 'ini': {
      // Field = [mods+]KEY [; comment]  — edit only the value segment, preserving the field, the
      // inline `;`/`#` comment, quoting, and (for a key-only change) the existing modifier prefix.
      const sep = line.search(/[:=]/)
      if (sep < 0) return null
      const head = line.slice(0, sep + 1)
      let rest = line.slice(sep + 1)
      const cIdx = rest.search(/[;#]/)
      const comment = cIdx >= 0 ? rest.slice(cIdx) : ''
      let valSeg = cIdx >= 0 ? rest.slice(0, cIdx) : rest
      const keyRe = new RegExp(`\\b${esc(slot.key)}\\b`, 'i')
      if (!keyRe.test(valSeg)) return null
      valSeg = valSeg.replace(keyRe, toKey)
      if (combo(toMods, 'X') !== combo(slot.mods, 'X')) {
        const upper = /(?:CTRL|CONTROL|SHIFT|ALT)\s*\+/.test(rest)
        const fmt = (m: string) => (upper ? m : m === 'CONTROL' ? 'Ctrl' : m[0] + m.slice(1).toLowerCase())
        const prefix = toMods.map((x) => `${fmt(x)}+`).join('')
        valSeg = valSeg.replace(new RegExp(`(["']?)(?:[A-Za-z]+\\s*\\+\\s*)*${esc(toKey)}`, 'i'), `$1${prefix}${toKey}`)
      }
      return `${head}${valSeg}${comment}`
    }
    case 'scalar-lua': {
      let out = line
      const modsChanged = combo(toMods, 'X') !== combo(slot.mods, 'X')
      // 1) Replace ONLY the bare key token, preserving any existing inline modifier prefix and the
      // Key./quote form. (A key-only change must not disturb the modifier text — re-casing `ALT+` →
      // `Alt+` could break a mod whose own prefix parser is case-sensitive.)
      if (slot.isKeyRef) {
        const re = new RegExp(`\\bKey\\.${esc(slot.key)}(?![A-Za-z0-9_])`)
        if (!re.test(out)) return null
        out = out.replace(re, `Key.${toKey}`)
      } else if (slot.hadQuotes) {
        const re = new RegExp(`("(?:[A-Za-z]+\\s*\\+\\s*)*)${esc(slot.key)}(")`, 'i')
        if (!re.test(out)) return null
        out = out.replace(re, `$1${toKey}$2`)
      } else {
        const re = new RegExp(`([:=]\\s*(?:[A-Za-z]+\\s*\\+\\s*)*)${esc(slot.key)}\\b`, 'i')
        if (!re.test(out)) return null
        out = out.replace(re, `$1${toKey}`)
      }
      // 2) Rewrite modifiers ONLY when they actually change. inline/mods-table are edited on this
      // line; sibling-bool flags live on OTHER lines and are handled by the caller via siblingFlags.
      if (modsChanged) {
        if (slot.modMechanism === 'mods-table') {
          out = out.replace(/\bmods?\s*=\s*\{[^}]*\}/i, `mods = { ${toMods.map((x) => `"${x}"`).join(', ')} }`)
        } else if (slot.modMechanism === 'inline' && slot.hadQuotes) {
          // Preserve the mod's casing convention (UPPERCASE `ALT+` vs Title `Alt+`) so a case-
          // sensitive prefix parser keeps working.
          const upper = /"(?:CTRL|CONTROL|SHIFT|ALT)\s*\+/.test(line)
          const fmt = (m: string) => (upper ? m : m === 'CONTROL' ? 'Ctrl' : m[0] + m.slice(1).toLowerCase())
          const prefix = toMods.map((x) => `${fmt(x)}+`).join('')
          out = out.replace(new RegExp(`"(?:[A-Za-z]+\\s*\\+\\s*)*${esc(toKey)}"`, 'i'), `"${prefix}${toKey}"`)
        }
      }
      return out
    }
    default:
      return null
  }
}

// Plan a remap of one slot to a new key (+ optional modifiers). Reads the CURRENT effective file
// (override-aware) and produces the full edited content — nothing is written.
export async function planSlotRewrite(slot: BindSlot, toKey: string, toModsIn: string[] = []): Promise<RewritePlan> {
  const toMods = [...new Set(toModsIn.map((x) => (x.toUpperCase() === 'CTRL' ? 'CONTROL' : x.toUpperCase())))].sort()
  if (!KEY_TOKEN.test(toKey)) return { ok: false, reason: `"${toKey}" is not a recognized key token` }
  if (!slot.canRebindKey) return { ok: false, reason: `${slot.modName}'s ${slot.label} is not remappable here (${slot.format})` }
  if (toMods.length && !slot.canModify)
    return { ok: false, reason: `${slot.modName}'s ${slot.label} (${slot.format}) can't take a modifier — pick a bare key` }

  const before = await readClientModFile(slot.modId, slot.file)
  if (before == null) return { ok: false, reason: `${slot.file} not found for ${slot.modName}` }
  const lines = before.split(/\r?\n/)

  // Re-locate by exact source line (robust to lineIndex drift); require a unique anchor.
  const anchors = lines.map((l, i) => (l === slot.raw ? i : -1)).filter((i) => i >= 0)
  if (anchors.length === 0) return { ok: false, reason: `couldn't find the bind line in ${slot.file} (mod updated?)` }
  if (anchors.length > 1 && slot.lineIndex >= 0 && lines[slot.lineIndex] !== slot.raw)
    return { ok: false, reason: `ambiguous bind line in ${slot.file}` }
  const idx = anchors.includes(slot.lineIndex) ? slot.lineIndex : anchors[0]!

  const newLine = rewriteLine(slot, lines[idx]!, toKey, toMods)
  if (newLine == null) return { ok: false, reason: `couldn't rewrite ${slot.label} in ${slot.file}` }
  lines[idx] = newLine

  // Sibling-boolean modifier flags (scalar-lua) — set each known flag on the file to match toMods.
  if (slot.format === 'scalar-lua' && slot.modMechanism === 'sibling-bool' && slot.siblingFlags) {
    for (const flag of slot.siblingFlags) {
      const want = toMods.includes(flag.mod)
      for (let i = 0; i < lines.length; i++) {
        const re = new RegExp(`(\\b${esc(flag.field)}\\s*[:=]\\s*)(true|false)\\b`)
        if (re.test(lines[i]!)) lines[i] = lines[i]!.replace(re, `$1${want}`)
      }
    }
  }

  const after = lines.join('\n')
  if (after === before) return { ok: false, reason: `no change (${slot.combo} already ${combo(toMods, toKey)}?)` }
  return {
    ok: true,
    modId: slot.modId,
    modName: slot.modName,
    file: slot.file,
    before,
    after,
    detail: `${slot.combo} → ${combo(toMods, toKey)} (${slot.label})`,
  }
}

// Write an approved plan as a loadout config-override (.lua saves are luaparse-validated).
export async function applyRewritePlan(plan: Extract<RewritePlan, { ok: true }>): Promise<void> {
  await saveClientModConfig(plan.modId, plan.file, plan.after)
}
