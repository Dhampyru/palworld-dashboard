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

### 2. One-click remap, generalized (Phase 2)
- A **keybind descriptor registry**: per mod (or per mod-family/format), where the key lives and how
  to rewrite it — `{ file, field, format: scalar-lua | table-with-mods | register-keybind-payload |
  native-default }`. Ships with descriptors for common mods; operator-extensible via a data file
  (clean-room — no one deployment's list baked into code).
- Reassign a key from the UI → the system writes the right **config-override / payload-edit** using
  the descriptor (reusing today's override mechanism). **relWithin = path within the produced
  `Mods/<folder>`**, not the payload path (a real 2026-08-25 mistake to bake into the writer).
- **Free-key suggester** — propose a conflict-free key from the free pool, excluding native
  hotbar/movement/action keys.
- **Auto-resolve all** — plan overrides for every real conflict; show a dry-run diff before applying
  (the earlier naive auto-planner produced wrong plans, so a hand-confirm dry-run is required).

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
