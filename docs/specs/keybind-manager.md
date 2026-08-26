# Spec: Keybind Manager (proposed)

Status: **PROPOSED** — not built. Roadmap-sized; needs an explicit "go" before implementation.
Written 2026-08-25 after a manual keybind pass exposed the gaps below.

## Why

Client-mod keybinds fire on the **player's** machine (the dedicated server is headless), so
conflicts are invisible server-side and the operator manages them by hand. That manual process is
error-prone and keeps recurring. A concrete example from 2026-08-25:

- The scanner reported **"G → BuildFlight + Medicine Hotkeys"**, but Medicine Hotkeys binds
  **Shift+G/Ctrl+G** (a `{ key="G", mods={"SHIFT"} }` table) — the scanner read `key="G"` and
  **missed the modifier sibling**, a false positive.
- It **missed the real conflict**: Toggle Mercy Ring's `TC_HOTKEY = Key.G` (plain G) genuinely
  clashing with Blueprint mode's G — the scanner never parsed that `*_HOTKEY` field.

So a naive pass would "fix" a non-conflict and leave a real one. The operator also hand-edits the
cheat-sheet, config-overrides, and broadcasts separately, which drift. This feature unifies:
**scan → remap → save-as-profile (with backup) → propagate to the cheat-sheet (and optionally the
tips broadcast)** — as a single, public-release-ready system.

The owner's four requirements: (1) scan conflicts, (2) fix by editing mods, (3) save edits with a
backup/profile, (4) any saved change also applies to the `.bat` cheat-sheet and everywhere else the
keybinds are shown.

## Current state (what already exists)

| Piece | Today | Gap |
|---|---|---|
| Scanner | `lib/keybind-scan.ts` + panel badge | modifier siblings, `*_HOTKEY` fields, native keys, number-key↔native-hotbar collisions all missed |
| Fix by editing mods | config-override + payload-edit mechanism (reversible, data volume) | manual per-mod; general auto-remap planner was deferred |
| Save w/ backup | overrides live in the auto-backed-up data volume; a `keybind-remap.json` ledger exists | no **named keybind profiles** |
| Propagate to cheat-sheet | auto-generated cheat-sheet (`scanPerModKeybinds`, override-aware) exists | not the single source of truth when an operator file is used; broadcasts are manual |

## Design

### 1. Hardened scanner (Phase 1)
Fix the proven parser gaps and add awareness:
- **Modifier siblings** — parse `{ key = "G", mods = { "SHIFT" } }` → `SHIFT+G`, not plain G.
- **Bind-field names** — recognize `*_HOTKEY` / `HOTKEY` / `*Key` scalar fields in
  `config/user_config/settings.lua` (e.g. `TC_HOTKEY = Key.G`).
- **Number keys vs native hotbar** — flag top-row `Key.ONE..EIGHT`/`"1".."8"` binds as colliding
  with Palworld's native hotbar, and numpad/`NUM_*` separately.
- **Native rebindable keys** — a small registry of mods that register a NATIVE Key-Config action
  (e.g. True First Person's `FP_HOTKEY_DEFAULT_KEY`) so they're SURFACED as "native — rebind
  in-game / editable via default-key payload edit", even though they never appear in a config.
- Output a **full per-mod keybind table** (combo → mods, with a confidence flag), not just the
  conflict list. New API `GET /api/client-mods/keybinds?full=1`.

### 2. One-click remap, generalized (Phase 2) — **BUILT 2026-08-26**
Descriptor-DRIVEN rather than a hand-authored per-mod table, so it works for ANY kept mod with no
deployment-specific list in code (clean-room). Files:
- `lib/keybind-descriptors.ts` — **the locator + rewrite engine.** `listModBindSlots(modId)` mirrors
  the scanner's `extractFromText` branch-for-branch (reusing its exported primitives — `KEY_TOKEN`,
  `combo()`, `normKey()`, `extractModsTable()`, `gatedByDisabledFlag`, `collectModScanFiles`, so a
  slot's `combo` is byte-identical to the conflict combo the scanner reports) and records each bind's
  SOURCE + FORMAT + a **capability matrix**:

  | format | rebind key | change modifiers |
  |---|---|---|
  | `register-keybind-payload` | yes | yes (UE4SS parses `RegisterKeyBind(Key.X,{ModifierKey.Y},…)`) |
  | `table-with-mods` | yes | yes (mod reads a `{Key.X,ModifierKey.Y}` / `mods={}` list) |
  | `scalar-lua` sibling-bool | yes | yes (toggle the mod's own `…Alt=true` sibling flags) |
  | `scalar-lua`/`ini` inline | yes | yes (value already carries `Shift+` → mod parses it) |
  | `scalar-lua`/`ini` bare | yes | **no** (no evidence the mod parses a modifier here) |
  | `modconfig-json` | no | no (surfaced only — rebind in the mod's in-game menu) |

  `planSlotRewrite(slot,toKey,toMods)` reads the effective (override-aware) file and produces the
  full edited content — **surgical**: it swaps ONLY the bare key token, preserving the existing
  modifier-prefix TEXT and its casing (`ALT+` stays `ALT+`, not `Alt+` — a case-sensitive prefix
  parser would break), quotes, `Key.` form, and inline comments; modifiers are rewritten only when
  they actually change. `applyRewritePlan` writes it as a loadout config-override via
  `lib/client-mod-config` (`.lua` saves are luaparse-validated → a syntax-breaking edit is refused).
  **relWithin = the mod-root-relative path** (the produced `Mods/<folder>` path) — the content-dir
  scanner now emits that, not just a basename. Template files (`*.example.ini`, `config.default.lua`)
  are excluded from location (the mod never reads them).
- `lib/keybind-autoremap.ts` — **suggester + auto-resolver.** `suggestFreeKey(used,slot)` proposes a
  free binding best-first: if the slot can carry a modifier, first modify its OWN key (`Ctrl+F7` keeps
  the mnemonic), else move to a free bare key from a pool that EXCLUDES the native hotbar
  (1-8/ONE-EIGHT) and movement/action letters. `autoResolve(dryRun)` iterates the real conflicts,
  keeps the hardest-to-move mod as anchor (a non-remappable or bare-only mod is kept; a modifiable mod
  moves cheaply by gaining Ctrl/Alt), suggests a free target per moved mod, and reserves it so a later
  conflict can't reuse it. Deterministic (re-derives the same plan at apply-time). `planSingleRemap`/
  `applySingleRemap` back the per-key path.
- Every applied move is tracked in the SHARED `keybind-remap.json` ledger (via the new
  `recordOverridesInLedger` union writer), so the card's "Undo remap" (`clearRemap`) reverts
  descriptor auto-resolves too.
- API `app/api/client-mods/keybinds` POST actions: `binds` (full editable table), `suggest`,
  `remapKeyPlan`/`remapKeyApply` (single), `autoResolvePlan`/`autoResolveApply`.
- UI: a **Smart auto-resolve** block in the keybind-remap card (`components/client-mods-panel.tsx`),
  shown while conflicts remain: **Preview auto-resolve** (mandatory dry-run — shows `combo: mod from →
  to (keeps anchor)`) → **Apply N moves** / **Cancel**. Browser-verified 2026-08-26 (headless) against
  a temporary induced conflict, fully reverted.
- **Verified live** across all rewrite paths (payload modifier-add, ini bare-key change, scalar inline
  key-only with casing preserved, scalar sibling-bool modifier-add + key-change, mods-table, bare-
  scalar modifier correctly rejected) and the resolver on a real conflict — every test reverted with
  the loadout + ledger byte-identical.

**Still open (Phase 2 follow-up, not built):** a fully-manual per-key "Change to <key>" picker in the
UI (backend `remapKeyPlan`/`remapKeyApply` + `suggest` already support it) — auto-resolve covers the
common case; the manual picker is a nicety.

### 3. Keybind profiles + backup (Phase 3)
- A named **keybind profile** = the current set of keybind overrides. Save / restore / rename /
  delete (mirrors `lib/mod-profiles.ts`, but for keybinds). Stored `data/keybind-profiles.json`;
  each save snapshots the override files. Reversible; auto-backed-up with the data volume.

### 4. Propagation — one source of truth (Phase 4)
- The effective keybind set (hardened scanner + overrides) is the single source that feeds:
  - the **cheat-sheet** (`keybinds.txt`) — default to the **auto-generated** one so it's always
    live; the operator file becomes an optional hand-curated override only;
  - an optional **tips-broadcast generator** — turn the keybind set into rotating in-game tips
    (the owner's "tips-only broadcast" idea), opt-in, dashboard-only;
  - the UI table.
- So a saved remap propagates to the cheat-sheet (and, if enabled, the broadcasts) automatically —
  requirement (4).

## UI
A **Keybinds** panel (or a section in the Mods area): grouped keybind table, conflicts highlighted
(real vs native vs uncertain), per-key **Change** + **Auto-resolve conflicts** (dry-run first),
**profiles** (save/restore), and **Regenerate cheat-sheet** / **Generate tips broadcast** actions.

## Public-release notes
- Clean-room: descriptor registry ships with common-mod descriptors; operator supplies their own via
  a `mod_data`-style file. No deployment-specific mod list in code.
- The auto-generated cheat-sheet is already generic (`scanPerModKeybinds`) — this makes it the default.

## Phasing
1. Harden scanner + full per-mod table API.
2. Descriptor registry + one-click remap + free-key suggester + auto-resolve dry-run.
3. Keybind profiles + backups.
4. Propagation (auto cheat-sheet default + optional tips broadcast) + UI.

## Gotchas to bake in (learned the hard way)
- Scanner: modifier siblings, `*_HOTKEY` fields, native keys, number-key↔native-hotbar collisions.
- Override **relWithin is relative to the produced `Mods/<folder>`**, not the payload's full path
  (guts-at-`Pal/Binaries/...` payloads mislead — cf. Toggle Mercy Ring, Pal Insight).
- Broadcast API: **GET returns `{schedule:{messages}}`; POST replaces `settings.messages`** —
  parsing the wrong path and re-saving WIPES the list (recover from the `dashboard-data-*` backup).
- Native rebindable keys (First Person F6) can only be defaulted-off via a payload edit of the mod's
  default-key constant; a player who saved a binding in-game must clear it once in Key Config.

See also `docs/specs/keybind-remap.md` (the earlier detector + remap spec this supersedes/extends).
