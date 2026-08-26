// SERVER-ONLY. PATCH (not upstream): Keybind Manager Phase 2 — free-key suggester + auto-resolver.
// Built on the descriptor layer (lib/keybind-descriptors): given the conflict scan, propose a
// conflict-free key for a slot, or plan a full auto-resolve for every real conflict. A dry-run is
// mandatory before applying (docs/specs/keybind-manager.md §2 — the earlier naive planner produced
// wrong plans). Every applied move is a reversible loadout config-override tracked in the shared
// keybind-remap ledger, so the manager's "Undo" (remapClear) reverts auto-resolves too.
import { combo, NATIVE_HOTBAR, scanClientKeybinds } from '@/lib/keybind-scan'
import {
  applyRewritePlan,
  listAllBindSlots,
  planSlotRewrite,
  type BindSlot,
  type RewritePlan,
} from '@/lib/keybind-descriptors'
import { recordOverridesInLedger } from '@/lib/keybind-remap'

// Candidate BARE keys the suggester may hand out, best-first. Deliberately excludes the native
// action-bar row (1-8 / ONE-EIGHT), movement/action letters (WASD, E, R, …), and TAB/SPACE/ENTER —
// picking one of those would create a NEW native collision the mod-vs-mod scan can't see. F1-F12
// lead (players expect hotkeys there), then the nav block, then the numpad.
const BARE_POOL: string[] = [
  ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
  'END',
  'INSERT',
  'DELETE',
  'HOME',
  'PAGE_UP',
  'PAGE_DOWN',
  'NUM_ZERO',
  'NUM_ONE',
  'NUM_TWO',
  'NUM_THREE',
  'NUM_FOUR',
  'NUM_FIVE',
  'NUM_SIX',
  'NUM_SEVEN',
  'NUM_EIGHT',
  'NUM_NINE',
  'ADD',
  'SUBTRACT',
  'MULTIPLY',
  'DIVIDE',
  'DECIMAL',
]
const FKEYS = Array.from({ length: 12 }, (_, i) => `F${i + 1}`)
const MODS_ORDER = ['CONTROL', 'ALT', 'SHIFT']

export type Suggestion = { key: string; mods: string[]; combo: string }

// Propose a conflict-free binding for `slot`. `used` = every combo currently taken across the
// loadout (plus reserved natives). When the slot's format can carry a modifier, first try modifying
// the slot's OWN key (Ctrl+F7 keeps the mnemonic — the pattern the manual pass used); otherwise
// move to a free bare key. Returns null only if the pool is genuinely exhausted.
export function suggestFreeKey(used: Set<string>, slot: BindSlot): Suggestion | null {
  const candidates: { mods: string[]; key: string }[] = []
  if (slot.canModify) for (const m of MODS_ORDER) candidates.push({ mods: [m], key: slot.key })
  for (const k of BARE_POOL) candidates.push({ mods: [], key: k })
  if (slot.canModify) for (const m of MODS_ORDER) for (const k of FKEYS) candidates.push({ mods: [m], key: k })
  for (const c of candidates) {
    if (!c.mods.length && NATIVE_HOTBAR.has(c.key)) continue
    const combined = combo(c.mods, c.key)
    if (used.has(combined)) continue
    return { key: c.key, mods: c.mods, combo: combined }
  }
  return null
}

// One-off: suggest a target for a single conflict combo (the UI's per-key "suggest a free key").
export async function suggestForCombo(conflictCombo: string, modId: string): Promise<Suggestion | null> {
  const slots = await listAllBindSlots()
  const used = usedCombos(slots)
  const slot = slots.find((s) => s.combo === conflictCombo && s.modId === modId && s.canRebindKey)
  if (!slot) return null
  return suggestFreeKey(used, slot)
}

function usedCombos(slots: BindSlot[]): Set<string> {
  const used = new Set<string>(slots.map((s) => s.combo))
  // Reserve the native action bar so we never suggest onto it.
  for (const k of NATIVE_HOTBAR) if (!/^\d+$/.test(k)) used.add(combo([], k))
  return used
}

export type MoveStep = { modId: string; modName: string; label: string; file: string; from: string; to: string; detail: string }
export type ConflictResolution = { combo: string; keep: string; moves: MoveStep[]; unresolved: string[] }
export type AutoResolveResult = {
  applied: boolean
  resolutions: ConflictResolution[]
  moved: number
  unresolved: { combo: string; reason: string }[]
}

// Lower score = keep (harder to move). A non-remappable slot (modconfig / native) must be the
// anchor; a bare-only mod (can't take a modifier) is kept over a modifiable one, since the
// modifiable mod can move cheaply by gaining Ctrl/Alt while keeping its key.
function anchorScore(slots: BindSlot[]): number {
  if (slots.some((s) => !s.canRebindKey)) return 0
  if (slots.every((s) => !s.canModify)) return 1
  return 2
}

// Plan (and optionally apply) a resolution for every REAL mod-vs-mod conflict. Deterministic, so
// re-running at apply-time re-derives the same plan against the current files (safer than caching a
// stale before/after across the confirm step).
export async function autoResolve(dryRun: boolean): Promise<AutoResolveResult> {
  const scan = await scanClientKeybinds()
  const slots = await listAllBindSlots()
  const used = usedCombos(slots)

  const byCombo = new Map<string, BindSlot[]>()
  for (const s of slots) byCombo.set(s.combo, [...(byCombo.get(s.combo) ?? []), s])

  const resolutions: ConflictResolution[] = []
  const unresolved: { combo: string; reason: string }[] = []
  const plans: Extract<RewritePlan, { ok: true }>[] = []

  for (const conflict of scan.conflicts) {
    const producing = byCombo.get(conflict.combo) ?? []
    if (!producing.length) {
      unresolved.push({ combo: conflict.combo, reason: 'conflict not attributable to an editable config (ReShade preset / opaque bind)' })
      continue
    }
    // Group the producing slots by mod.
    const byMod = new Map<string, BindSlot[]>()
    for (const s of producing) byMod.set(s.modId, [...(byMod.get(s.modId) ?? []), s])
    const modEntries = [...byMod.entries()].map(([modId, ss]) => ({ modId, name: ss[0]!.modName, slots: ss, score: anchorScore(ss) }))
    // Keep the hardest-to-move (min score); tie → first by name for stability.
    modEntries.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name))
    const keep = modEntries[0]!
    const moves: MoveStep[] = []
    const modUnresolved: string[] = []

    for (const mod of modEntries.slice(1)) {
      const target = suggestFreeKey(used, mod.slots[0]!)
      if (!target) {
        modUnresolved.push(`${mod.name}: no free key available`)
        continue
      }
      let movedOne = false
      for (const slot of mod.slots) {
        const plan = await planSlotRewrite(slot, target.key, target.mods)
        if (plan.ok) {
          plans.push(plan)
          moves.push({ modId: mod.modId, modName: mod.name, label: slot.label, file: slot.file, from: slot.combo, to: target.combo, detail: plan.detail })
          movedOne = true
        } else {
          modUnresolved.push(`${mod.name} (${slot.label}): ${plan.reason}`)
        }
      }
      if (movedOne) used.add(target.combo) // reserve so a later conflict can't reuse it
    }

    resolutions.push({ combo: conflict.combo, keep: keep.name, moves, unresolved: modUnresolved })
    if (modUnresolved.length) unresolved.push({ combo: conflict.combo, reason: modUnresolved.join('; ') })
  }

  if (!dryRun && plans.length) {
    for (const p of plans) await applyRewritePlan(p)
    await recordOverridesInLedger(plans.map((p) => ({ modId: p.modId, relWithin: p.file })))
  }

  return { applied: !dryRun, resolutions, moved: plans.length, unresolved }
}

// Single-slot plan (dry-run) for the per-key "Change" action.
export async function planSingleRemap(modId: string, fromCombo: string, toKey: string, toMods: string[]): Promise<RewritePlan> {
  const slot = (await listAllBindSlots()).find((s) => s.modId === modId && s.combo === fromCombo && s.canRebindKey)
  if (!slot) return { ok: false, reason: `no editable bind ${fromCombo} found for that mod` }
  return planSlotRewrite(slot, toKey, toMods)
}

// Single-slot apply used by the per-key "Change" action: plan → apply → ledger.
export async function applySingleRemap(modId: string, fromCombo: string, toKey: string, toMods: string[]): Promise<RewritePlan> {
  const plan = await planSingleRemap(modId, fromCombo, toKey, toMods)
  if (!plan.ok) return plan
  await applyRewritePlan(plan)
  await recordOverridesInLedger([{ modId: plan.modId, relWithin: plan.file }])
  return plan
}
