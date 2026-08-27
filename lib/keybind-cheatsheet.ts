// SERVER-ONLY. PATCH (not upstream): Keybind Manager Phase 4 — the friend-facing controls cheat-sheet
// as a single source of truth. The AUTO-GENERATED sheet (from the kept mods' detected keybinds,
// override-aware, no hardcoded mod list) is the DEFAULT; an operator-supplied
// `$DATA_DIR/loadout-keybinds.txt` is an OPTIONAL hand-curated override that wins when present. This
// module is the one place both the loadout bundle (lib/client-loadout keybindsTxt) and the dashboard
// UI resolve the effective sheet, so a saved remap always propagates to what friends receive.
import { readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { scanPerModKeybinds } from '@/lib/keybind-scan'

const DATA_DIR = resolve(process.env.DASHBOARD_DATA_DIR ?? './data')
export const operatorSheetPath = (): string => join(DATA_DIR, 'loadout-keybinds.txt')

// Auto-generate the sheet from the effective (override-aware) keybinds of the mods this loadout
// ships. No hardcoded mod list — always current for whatever the operator actually staged.
export async function generateKeybindSheet(): Promise<string> {
  const rows = await scanPerModKeybinds().catch(() => [])
  const lines = [
    'PALWORLD — MOD CONTROLS (this loadout)',
    '=======================================',
    '',
    'Keys detected in the mods this loadout installs. If two mods share a key,',
    'the dashboard flags it as a conflict. Some mods also bind keys in Palworld’s',
    'own Key Config (Options → Key Config) — those are set in-game, not here.',
    '',
  ]
  if (rows.length) {
    const width = Math.min(46, Math.max(...rows.map((r) => r.name.length)))
    for (const r of rows) {
      const gap = r.name.length >= width ? ' ' : ' ' + '.'.repeat(width - r.name.length) + ' '
      lines.push(`  ${r.name}${gap}${r.combos.join(', ')}`)
    }
  } else {
    lines.push('  (No mod keybinds detected in this loadout.)')
  }
  lines.push('')
  return lines.join('\r\n') + '\r\n'
}

// The operator's hand-curated override, or null when absent/blank.
export async function readOperatorSheet(): Promise<string | null> {
  try {
    const c = await readFile(operatorSheetPath(), 'utf8')
    return c.trim() ? c : null
  } catch {
    return null
  }
}

export type EffectiveSheet = { source: 'operator' | 'auto'; text: string; hasOperator: boolean }

// What the bundle will actually ship: the operator file verbatim if present, else the auto sheet.
export async function getEffectiveKeybindSheet(): Promise<EffectiveSheet> {
  const op = await readOperatorSheet()
  if (op != null) return { source: 'operator', text: op, hasOperator: true }
  return { source: 'auto', text: await generateKeybindSheet(), hasOperator: false }
}

// Drop the operator override → the sheet reverts to always-live auto-generation.
export async function clearOperatorSheet(): Promise<boolean> {
  const had = (await readOperatorSheet()) != null
  await rm(operatorSheetPath(), { force: true }).catch(() => {})
  return had
}
