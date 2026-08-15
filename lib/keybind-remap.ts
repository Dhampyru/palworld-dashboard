// SERVER-ONLY. PATCH (not upstream): resolve keybind CONFLICTS across the kept client mods by
// writing OVERRIDES that ship in the loadout (so the remap "writes to install.bat" without
// mutating any staged payload). Detector: lib/keybind-scan.
//
// Two kinds of fix, both hand-verified against the real mod and both delivered as overlay files
// the loadout drops over the produced mod folder (reversible via remapClear; no payload edit):
//   1. CONFLICT_REMAP — a key held in a config.lua the mod actually reads → rewrite the value.
//   2. PAYLOAD_EDITS   — a key HARDCODED in main.lua (RegisterKeyBind) → ship an edited copy of
//      that file as an override (a surgical, luaparse-validated string replacement).
// The anchor (the mod that KEEPS the key) is always left untouched. Apply/undo go through
// lib/client-mod-config so paths + validation match what the loadout overlay reads back.
import { readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { listClientMods } from '@/lib/client-mods'
import {
  clearClientModConfig,
  listClientModConfigs,
  readClientModConfigOverrides,
  readClientModFile,
  saveClientModConfig,
} from '@/lib/client-mod-config'

// ── 1. Config-value remaps (quoted key in a config.lua). Value-based (not field-based) because
// some mods repeat the field name (Ultra Graphics has three `Key =` lines); each OLD value is
// unique within its mod's config, so it targets the right binding. ─────────────────────────────
export type RemapEntry = { modId: string; modName: string; pairs: [string, string][] }
export const CONFLICT_REMAP: RemapEntry[] = [
  { modId: 'ultra-graphics', modName: 'Ultra Graphics', pairs: [['F8', 'F1'], ['F9', 'F3'], ['F10', 'F4']] },
  { modId: 'ultra-weather---with-volumetric-clouds', modName: 'Ultra Weather', pairs: [['F8', 'F11'], ['PAGE_DOWN', 'F12']] },
  { modId: 'pal-insight---native-style-pal-inspection-overlay', modName: 'Pal Insight', pairs: [['F7', 'F5']] },
  { modId: 'palvolve---evolve-your-pals', modName: 'Palvolve', pairs: [['F2', 'Y']] },
]

// ── 2. Payload edits (key hardcoded in main.lua). Exact-string replacements on a specific file,
// verified to parse under luaparse 5.3 both before and after. `from` must match verbatim. ───────
export type PayloadEdit = { modId: string; modName: string; relWithin: string; replacements: [string, string][]; resolves: string }
export const PAYLOAD_EDITS: PayloadEdit[] = [
  {
    // C conflict — Base Automation (copy) vs BaseShift (deliberately rides the stock C, don't move).
    // Move Base Automation's copy to Ctrl+C (mnemonic, and a modified combo never collides with plain C).
    modId: 'palworld-base-automation',
    modName: 'Palworld Base Automation',
    relWithin: 'Scripts/main.lua',
    replacements: [['RegisterKeyBind(Key.C, function()', 'RegisterKeyBind(Key.C, {ModifierKey.CONTROL}, function()']],
    resolves: 'C (→ Ctrl+C)',
  },
  {
    // NUM_4 conflict — Party Hotkey Switcher (slot 4, part of its NUM 1-9 scheme) vs Palvolve's
    // REDUNDANT radial-cancel. Disable Palvolve's NUM_4 bind; FOUR + ESCAPE still cancel the radial.
    modId: 'palvolve---evolve-your-pals',
    modName: 'Palvolve',
    relWithin: 'Scripts/radialmenu.lua',
    replacements: [
      [
        'if Key.NUM_FOUR then RegisterKeyBind(Key.NUM_FOUR, markCancel) end',
        '-- [dashboard remap] NUM_FOUR radial-cancel disabled to avoid Party Hotkey Switcher conflict (FOUR + ESCAPE still cancel)',
      ],
    ],
    resolves: 'NUM_4 (Palvolve side disabled)',
  },
]

export type RemapResult = {
  applied: { modName: string; relWithin: string; detail: string }[]
  skipped: { modName: string; reason: string }[]
}

const stateFile = () => join(process.env.DASHBOARD_DATA_DIR ?? './data', 'keybind-remap.json')

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
function replaceQuotedKey(content: string, from: string, to: string): { content: string; changed: boolean } {
  const re = new RegExp(`(["'])${escapeRe(from)}\\1`, 'g')
  let changed = false
  const next = content.replace(re, (_m, q: string) => {
    changed = true
    return `${q}${to}${q}`
  })
  return { content: next, changed }
}

// Apply everything, idempotently, then (re)write a complete undo ledger from the overrides that
// actually exist for every touched mod — so undo works even across partial/repeat runs.
export async function applyManualRemap(): Promise<RemapResult> {
  const kept = new Set((await listClientMods()).filter((m) => m.keep).map((m) => m.id))
  const applied: RemapResult['applied'] = []
  const skipped: RemapResult['skipped'] = []

  // 1. Config-value remaps.
  for (const entry of CONFLICT_REMAP) {
    if (!kept.has(entry.modId)) {
      skipped.push({ modName: entry.modName, reason: 'not installed/kept' })
      continue
    }
    let landed = false
    for (const cfg of await listClientModConfigs(entry.modId).catch(() => [])) {
      let content = cfg.content
      const done: string[] = []
      for (const [from, to] of entry.pairs) {
        const r = replaceQuotedKey(content, from, to)
        if (r.changed) {
          content = r.content
          done.push(`${from}→${to}`)
        }
      }
      if (done.length) {
        await saveClientModConfig(entry.modId, cfg.relWithin, content)
        applied.push({ modName: entry.modName, relWithin: cfg.relWithin, detail: done.join(', ') })
        landed = true
      }
    }
    if (!landed) skipped.push({ modName: entry.modName, reason: 'config keys already remapped or not found' })
  }

  // 2. Payload edits (hardcoded main.lua binds).
  for (const edit of PAYLOAD_EDITS) {
    if (!kept.has(edit.modId)) {
      skipped.push({ modName: edit.modName, reason: 'not installed/kept' })
      continue
    }
    const original = await readClientModFile(edit.modId, edit.relWithin)
    if (original == null) {
      skipped.push({ modName: edit.modName, reason: `${edit.relWithin} not found` })
      continue
    }
    let content = original
    const done: string[] = []
    let alreadyDone = 0
    for (const [from, to] of edit.replacements) {
      if (content.includes(from)) {
        content = content.replace(from, to)
        done.push(edit.resolves)
      } else if (content.includes(to)) {
        alreadyDone++ // idempotent re-run
      } else {
        skipped.push({ modName: edit.modName, reason: `expected code not found in ${edit.relWithin} (mod updated?)` })
      }
    }
    if (done.length) {
      await saveClientModConfig(edit.modId, edit.relWithin, content) // luaparse-validated
      applied.push({ modName: edit.modName, relWithin: edit.relWithin, detail: done.join(', ') })
    } else if (alreadyDone) {
      skipped.push({ modName: edit.modName, reason: `${edit.resolves} already applied` })
    }
  }

  // Rebuild the undo ledger from every override now present across all touched mods.
  const touched = [...new Set([...CONFLICT_REMAP.map((e) => e.modId), ...PAYLOAD_EDITS.map((e) => e.modId)])]
  const written: { modId: string; relWithin: string }[] = []
  for (const modId of touched)
    for (const o of await readClientModConfigOverrides(modId).catch(() => [])) written.push({ modId, relWithin: o.relWithin })

  await mkdir(dirname(stateFile()), { recursive: true }).catch(() => {})
  await writeFile(stateFile(), JSON.stringify({ written }, null, 2)).catch(() => {})
  return { applied, skipped }
}

// Undo: drop only the overrides this remap wrote (the loadout falls back to shipped files).
export async function clearRemap(): Promise<number> {
  if (!existsSync(stateFile())) return 0
  let n = 0
  try {
    const st = JSON.parse(await readFile(stateFile(), 'utf8')) as { written?: { modId: string; relWithin: string }[] }
    for (const w of st.written ?? []) {
      await clearClientModConfig(w.modId, w.relWithin).catch(() => {})
      n++
    }
  } catch {
    /* ignore */
  }
  await rm(stateFile(), { force: true }).catch(() => {})
  return n
}
