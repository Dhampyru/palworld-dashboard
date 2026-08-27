// SERVER-ONLY. PATCH (not upstream): Keybind Manager Phase 4 — turn the effective keybind set into
// rotating in-game tips. Opt-in and dashboard-only: `regenerateKeybindTips` writes the generated tips
// into the instance's broadcast schedule (without touching the operator's own messages), and the
// broadcaster rotates them alongside those messages when the option is enabled. No hardcoded mod
// list — the tips reflect exactly the mods a loadout ships (override-aware, via scanPerModKeybinds).
import { runWithInstance } from '@/lib/instances'
import { scanPerModKeybinds } from '@/lib/keybind-scan'
import { saveScheduleSettings, type BroadcastSchedule } from '@/lib/broadcast-schedule'

// One concise tip per mod that binds keys, e.g. "Keybind - Medicine Hotkeys: Shift+G, Ctrl+G".
// Broadcast-safe by construction: the broadcaster strips non-ASCII and (on vanilla RCON) turns
// spaces into underscores, so these render the same way the operator's own tips do.
export async function generateKeybindTips(): Promise<string[]> {
  const rows = await scanPerModKeybinds().catch(() => [])
  return rows.filter((r) => r.combos.length).map((r) => `Keybind - ${r.name}: ${r.combos.join(', ')}`)
}

// Regenerate tips from the CURRENT keybinds and persist them into the instance's schedule. The scan
// is instance-scoped, so run it inside the instance context; the schedule write is id-addressed.
export async function regenerateKeybindTips(id: string): Promise<{ schedule: BroadcastSchedule; tips: string[] }> {
  const tips = await runWithInstance(id, () => generateKeybindTips())
  const schedule = saveScheduleSettings(id, { keybindTips: tips })
  return { schedule, tips }
}
