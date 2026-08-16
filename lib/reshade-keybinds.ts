// SERVER-ONLY. PATCH (not upstream): expose ReShade toggle-keys to the client keybind conflict
// detector (lib/keybind-scan). A ReShade preset can bind an effect to a key (`Key<Effect>=<vk>,…`)
// and the base ReShade.ini has global hotkeys (overlay/effects/screenshot/next-preset). Those keys
// fire on the same client as the UE4SS mods, so if a preset's key collides with a mod's keybind,
// one silently loses — same class of bug the detector already catches for mods. ReShade stores
// keys as Windows VIRTUAL-KEY CODES (numbers), so we map them to the detector's key-name vocab.
import AdmZip from 'adm-zip'
import { readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { readReshadeConfig } from '@/lib/reshade'

const DATA_DIR = resolve(process.env.DASHBOARD_DATA_DIR ?? './data')
const RESHADE_DIR = join(DATA_DIR, 'reshade')
const PRESETS_DIR = join(RESHADE_DIR, 'presets')
const BASE_ZIP = join(RESHADE_DIR, 'base.zip')

// Windows VK code → key name matching lib/keybind-scan's vocabulary (so combos compare equal).
const VK: Record<number, string> = (() => {
  const m: Record<number, string> = {}
  for (let i = 1; i <= 24; i++) m[0x6f + i] = `F${i}` // F1..F24 = 0x70..0x87
  for (let c = 65; c <= 90; c++) m[c] = String.fromCharCode(c) // A..Z
  const rowWords = ['ZERO', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE']
  for (let d = 0; d <= 9; d++) {
    m[0x30 + d] = rowWords[d] // number row 0..9 → word names (UE4SS uses Key.FOUR etc.)
    m[0x60 + d] = `NUM_${rowWords[d]}` // numpad 0..9 → NUM_ZERO..NUM_NINE
  }
  Object.assign(m, {
    0x08: 'BACKSPACE', 0x09: 'TAB', 0x0d: 'RETURN', 0x1b: 'ESCAPE', 0x20: 'SPACE',
    0x21: 'PAGE_UP', 0x22: 'PAGE_DOWN', 0x23: 'END', 0x24: 'HOME',
    0x25: 'LEFT', 0x26: 'UP', 0x27: 'RIGHT', 0x28: 'DOWN',
    0x2d: 'INSERT', 0x2e: 'DELETE',
  })
  return m
})()

// `Key<Effect>=<vk>,<ctrl>,<shift>,<alt>` → combo string in keybind-scan's format ("CONTROL+F8").
function comboFor(vk: number, ctrl: number, shift: number, alt: number): string | null {
  const key = VK[vk]
  if (!key) return null
  const mods: string[] = []
  if (ctrl) mods.push('CONTROL')
  if (shift) mods.push('SHIFT')
  if (alt) mods.push('ALT')
  return (mods.length ? mods.sort().join('+') + '+' : '') + key
}

// Pull every `Key…=<vk>,<m>,<m>,<m>` binding out of a ReShade .ini (preset or ReShade.ini).
function combosFromIni(text: string): Set<string> {
  const out = new Set<string>()
  const re = /^\s*Key[A-Za-z0-9_]*\s*=\s*(\d+)\s*,\s*(\d)\s*,\s*(\d)\s*,\s*(\d)\s*$/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const c = comboFor(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]))
    if (c) out.add(c)
  }
  return out
}

export type KeybindSource = { id: string; name: string; combos: Set<string> }

// ReShade keybind sources for the conflict scan — only when ReShade will actually SHIP (enabled +
// base present). Each enabled preset is a source (any could be the active one in-game); the base
// ReShade.ini's global hotkeys are one more source.
export async function reshadeKeybindSources(): Promise<KeybindSource[]> {
  const c = await readReshadeConfig().catch(() => null)
  if (!c || !c.enabled || !c.base) return []
  const out: KeybindSource[] = []

  // Base ReShade.ini global hotkeys (overlay/effects/screenshot/next-preset…).
  if (existsSync(BASE_ZIP)) {
    try {
      const e = new AdmZip(await readFile(BASE_ZIP)).getEntries().find((x) => /(^|\/)ReShade\.ini$/i.test(x.entryName.replace(/\\/g, '/')))
      if (e) {
        const combos = combosFromIni(e.getData().toString('utf8'))
        if (combos.size) out.push({ id: 'reshade:__base', name: 'ReShade (overlay/controls)', combos })
      }
    } catch {
      /* skip */
    }
  }

  // Per-preset effect toggle keys.
  for (const p of c.presets) {
    const txt = await readFile(join(PRESETS_DIR, p.file), 'utf8').catch(() => '')
    if (!txt) continue
    const combos = combosFromIni(txt)
    if (combos.size) out.push({ id: `reshade:${p.file}`, name: `ReShade: ${p.name}`, combos })
  }
  return out
}

// Cache signature: ReShade state that affects the keys (enabled + presets + base mtime).
export async function reshadeKeybindSignature(): Promise<string> {
  const c = await readReshadeConfig().catch(() => null)
  if (!c || !c.enabled) return 'reshade:off'
  const presets = c.presets.map((p) => p.file).sort().join(',')
  const baseMt = existsSync(BASE_ZIP) ? await stat(BASE_ZIP).then((s) => Math.round(s.mtimeMs)).catch(() => 0) : 0
  return `reshade:on:${baseMt}:${presets}`
}
