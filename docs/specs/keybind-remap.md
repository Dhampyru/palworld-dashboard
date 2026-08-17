# Spec: Client-Mod Keybind Conflicts — Detector + Remap

Status: **BUILT + verified (2026-08-15).** Detector shipped 2026-08-14
(`5094dd1`); remap + override-aware detector + payload edits 2026-08-15. Applied
live on this box: **8 conflicts → 0**, verified in the generated loadout bundle
(`configOverrides: 7`, `skipped: []`) and via the override-aware detector.

## Why

Every client mod's keybinds fire on the **player's** machine — the dedicated
server is headless, so a keybind conflict is invisible server-side. When you
bundle 30+ UE4SS Lua mods into one client loadout (`install.bat`), two mods can
grab the same key and one silently loses. This feature (a) **detects** keys bound
by 2+ kept client mods and (b) **remaps** the losers onto free keys, shipping the
change as loadout **overrides** — no payload mutated, live server untouched, fully
reversible.

## Detector — `lib/keybind-scan.ts`

Scans the **kept** client mods (`listClientMods().filter(keep)`) and reports every
key bound by 2+ of them.

- **Sources per mod:** Lua `RegisterKeyBind(Key.X, {ModifierKey.Y}, …)`,
  `config.lua`/`config.json` fields whose name looks like a keybind
  (`…Key`/`…Hotkey`/`…Bind`, or `Toggle…`) with a recognized key value, and
  DekModConfigMenu `.modconfig.json` settings of `type: "keybind"`.
- **Modifier-aware:** `Ctrl+F5` (Smart Production Queue) does **not** clash with
  plain `F5`. Modifiers are sorted so the combo is order-independent.
- **Mouse buttons excluded** — mods hook LMB/RMB contextually (their own UI); not
  an actionable hotkey conflict, just noise.
- **Override-aware (2026-08-15):** the config-overrides that ship in the loadout
  *replace* the payload's shipped config, so the scan reflects what will actually
  load. A payload config file is skipped when an override targets it (matched by
  its mod-root-relative path as a suffix) and the override is scanned instead.
  This is why the badge count drops the moment a remap is applied.
- **Cached** by a signature of `{id : payloadSize : override(relWithin@size.mtime)}`
  per kept mod — re-scans only when a payload or an override actually changes.

**API:** `GET /api/client-mods/keybinds` (admin-only, instance-scoped) →
`{conflicts:[{combo,mods}], perMod:{modId:[{combo,others}]}, scannedAt}`.
**UI:** amber ⚠ chip per conflicting row + an "N keybind conflicts" summary in
`components/client-mods-panel.tsx`.

## Remap — `lib/keybind-remap.ts`

Applies a **hand-verified** spec (not an auto-planner — see "Why not auto" below).
Each fix leaves the **anchor** (the mod that keeps the key) untouched and moves the
loser(s). Two mechanisms, both delivered as overlay files the loadout drops over
the produced mod folder:

1. **`CONFLICT_REMAP` — config-value overrides.** The key lives in a `config.lua`
   the mod actually reads → rewrite the quoted value. Value-based (not field-based)
   because some mods repeat the field name (Ultra Graphics has three `Key =` lines);
   each OLD value is unique within its mod's config, so it targets the right bind.
   Saved via `saveClientModConfig` (luaparse-validated, atomic).
2. **`PAYLOAD_EDITS` — main.lua overrides.** The key is **hardcoded** in a
   `RegisterKeyBind(Key.X)` with no config field. Ship an edited copy of that file
   as an override — a surgical, exact-string replacement, verified to parse under
   luaparse 5.3 both before and after. `readClientModFile` (in
   `lib/client-mod-config.ts`) reads the current (override-aware) content to edit.

Both go through `lib/client-mod-config.ts`, so paths + validation match exactly
what the loadout overlay (`lib/client-loadout.ts`, `readClientModConfigOverrides`)
reads back. Overrides only apply when a mod produced **exactly one** ue4ss folder
(the common case; paks routed to `~mods`/`LogicMods` don't count against this).

**The mapping applied on this box (2026-08-15):**

| Was | Mod moved | New key | Anchor (keeps key) | Mechanism |
|---|---|---|---|---|
| F8/F9/F10 | Ultra Graphics | F1/F3/F4 | Condenser IQ | config |
| F8 | Ultra Weather (sync) | F11 | Condenser IQ | config |
| PAGE_DOWN | Ultra Weather (restore) | F12 | Base Automation | config |
| F7 | Pal Insight (potential vision) | F5 | Accessory Toggler¹ | config |
| F6 | Pal Insight (settings) | O⁵ | GuildSight | config |
| F2 | Palvolve (evolve-confirm) | Y² | Hotkey Quick Stack | config |
| C | Base Automation (copy) | **Ctrl+C** | BaseShift³ | payload edit |
| NUM_4 | Palvolve (radial-cancel) | **disabled**⁴ | Party Hotkey Switcher | payload edit |

¹ Accessory Toggler kept F7 deliberately — its live config is in *My Games*
(Documents), so a payload edit wouldn't reach existing installs anyway.
² `Y` = mnemonic (Yes/confirm); the only non-F-key pick (F1–F12 were exhausted).
³ BaseShift's `Key.C` is "observation-only … does not consume the stock C input" —
it's *meant* to ride the game's C, so Base Automation's copy moved instead.
⁴ Palvolve's `NUM_FOUR` radial-cancel was redundant (`FOUR` + `ESCAPE` still
cancel), so disabling it keeps Party Hotkey Switcher's NUM 1–9 scheme intact.
⁵ F6 was double-bound with **GuildSight**'s overlay toggle. GuildSight stores its
key in `config.ini` (which the detector doesn't scan — see limitations), so this
conflict was invisible to the badges; GuildSight keeps the frequent F6, Pal
Insight's rarely-used settings menu moved to O.

**API:** `POST /api/client-mods/keybinds` (admin-only, instance-scoped):
- `{action:'remapPlan'}` → the spec (`CONFLICT_REMAP` + `PAYLOAD_EDITS`), preview only.
- `{action:'remapApply'}` → apply everything (idempotent) → `{applied,skipped}`.
- `{action:'remapClear'}` → undo. A ledger (`data/keybind-remap.json`) records every
  override written, so undo removes **only** those (falls back to shipped configs).

**UI (2026-08-15):** a **Keybind auto-remap** card in the client-mods panel
(`components/client-mods-panel.tsx`), shown when there are conflicts to fix or a
remap is active. Not-applied → an **Auto-remap conflicts** button (`remapApply`);
applied → an **active** badge + **Undo remap** button (`remapClear`); either way a
collapsible "What it changes" lists the full mapping. If conflicts remain after a
remap (both sides hardcode the key, or a mod was added since), the card says so.
`remapPlan` also returns `applied` so the card knows which state to show.

## Supporting fix — luaparse 5.3 (`lib/mod-config.ts`)

The Lua config validator parsed as Lua **5.1**, which rejects bitwise operators
(`~`, `&`, `|`, `//`) that real mod configs use — it would have wrongly flagged a
valid config as broken (and blocked this remap on Ultra Graphics' 211 KB config).
Now pinned to `luaVersion: '5.3'`. Affects the server Mod Config Editor too — a
strict improvement (accepts more valid Lua; still parse-only, never executed).

## Detector parsing fix + more remaps (2026-08-16)

The config scanner (`lib/keybind-scan` `extractFromText`) had two blind spots that hid real
conflicts: (1) a value written as `Key.NUM_FIVE` (dotted UE4SS ref) was read as just "Key" and
dropped; (2) a keybind on a non-standard field name (`SummonAdditionalPal = Key.G`) was skipped
because the field didn't match `key|hotkey|bind|toggle`. Fixed: a `Key.X` value is now treated as
a keybind regardless of field name, dotted refs parse correctly, and the config-table form
`Field = { Key.G, ModifierKey.SHIFT }` is parsed. This immediately surfaced conflicts the earlier
remap had created/missed. `lib/keybind-remap` gained `replaceKeyRef` (rewrites the unquoted
`Key.X` form, word-boundary safe) and three new `CONFLICT_REMAP` entries: **FOV Control** Numpad
5/6 → Numpad +/- (was clashing with Party Hotkey presets), **Multi Party Pals Summon** G → Numpad 0
(clashed with Simple Building Blueprints' G, which lives in a non-config .lua so only the summon
side is remappable), and **Base Chest Organiser** F4/F5/F10 → END/INSERT/Numpad-decimal (its dotted
`Key.F4/F5/F10` were invisible pre-fix, so Ultra Graphics/Pal Insight had been remapped on top of
them). Applied live → 0 detectable conflicts.

## Letter keybinds fire while typing → add a modifier (2026-08-17)

A friend hit Pal Insight's SETTINGS menu popping open whenever he typed a word with "O" in a text
box. Root cause: **UE4SS keybinds fire even while a game text field has focus**, so a bind on a
plain LETTER triggers mid-typing. Two of our own remaps had moved binds onto bare letters —
Pal Insight settings F6→**O** and Palvolve evolve-confirm F2→**Y**. Fix: add a **Ctrl** modifier
(Ctrl+O / Ctrl+Y) so plain typing is safe but the action is still reachable. Both are now robust
`PAYLOAD_EDITS` (Palvolve: add `{ModifierKey.CONTROL}` to the `RegisterKeyBind(Key[Config.confirmKey]…)`
in evolution.lua; Pal Insight: flip `settingsCtrl = false → true` in config.lua) so a remapClear +
remapApply re-derives the modifier instead of reverting to the bare letter. **Lesson (public
release):** never remap to a bare letter — modified combos, function keys, or numpad only, because
plain letters get typed. Broadcast tips updated (Palvolve → Ctrl+Y, added a Pal Insight controls tip).

## Config-gated keybinds not counted (2026-08-16, public-friendly)

The detector was false-flagging keybinds that never actually register — a common DEBUG/optional
pattern where a `RegisterKeyBind(...)` (or config bind) sits inside `if Config.<FLAG> … then` and
the mod sets `<FLAG> = false` (e.g. Base Trimmer's F7/F8/F9 mesh-scan keys behind
`DEBUG_SCAN_ENABLED = false`; the trim itself is automatic). `lib/keybind-scan` now, per mod,
collects flags assigned `false` across ALL its files (`collectDisabledFlags` — the gate often lives
in config.lua while the bind is in another script), then skips any bind whose ENCLOSING `if <flag>
… then` names a disabled flag (`gatedByDisabledFlag` — an indentation-based enclosing-if walk).
Safe-by-construction: bad/odd indentation just doesn't gate (falls back to counting the bind), and a
flag being false means the bind genuinely doesn't fire, so skipping it matches runtime. This removes
a whole false-positive class for the public release.

## Limitations / why not a general auto-planner

- The remap spec is **hand-verified**, not auto-generated. A first auto-planner
  attempt (2026-08-15, dry-run) produced a wrong plan — moved both sides of a
  conflict, moved non-conflicting keys, and picked non-existent F13–F15 — because
  correct anchor selection, a keyboard-real key pool, and scan consistency are
  non-trivial and a bad rewrite silently breaks a player's controls. So the manual,
  reviewed spec was shipped; the auto-planner is deferred.
- **Dynamic binds are invisible.** A mod that does `RegisterKeyBind(Key[name])`
  (BaseShift's configurable pickup/cancel) or reads a key into a variable isn't
  matched by the static scan.
- **Game-default collisions aren't detected** — the scan only compares mods to each
  other, not to Palworld's own default binds. (Hence the `Y` caveat above.)
- **`config.ini` keybinds aren't scanned** — the detector reads `config.lua`/
  `config.json`/`.modconfig.json`, not `.ini` (GuildSight's `ToggleKey` lives there),
  so an INI-configured bind can conflict undetected. The remap can still fix it by
  moving the *other* side if that side is scannable (as F6 → O did).
- Effective for players after a **loadout rebuild + reinstall** (client mods — no
  game restart needed).
