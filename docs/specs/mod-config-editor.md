# Spec: Mod Config Editor

Status: **BUILT + browser-verified (2026-08-06).** MVP shipped: `lib/mod-config.ts`
(discovery/read/validate/write/create-from-template) + `app/api/mod-config` (GET
list/content, POST save/create; admin-only, instance-scoped) + a **Config** (sliders)
button on each UE4SS mod row in the Mods tab opening a right-side editor Sheet
(`components/game-mods-panel.tsx`). Verified live via the API: discovery on
BaseRadiusImproved/SmartPalFeeding/PalworldBaseAutomation (Lua filtered to
config-looking only, sorted last, read-only); a save round-trip (edit → `.bak` snapshot
+ atomic write → restore); and rejection of invalid JSON, read-only-Lua writes, and
path traversal. Create-from-template exercised on PalworldBaseAutomation's
`recipe-toggles`. **Browser-verified via Playwright headless** (no Chrome extension this
session; same method as the other QA passes): 10/10 checks — Mods-tab nav, Config button
on the row, sheet opens with the file picker, the JSON config loads its full content, a
save round-trip (edit → Save enabled → "Saved" toast → restore), and the Lua tab renders
read-only with no Save button. Prompted by BaseRadiusImproved (config-file-only, edited
by hand). The config-landscape survey below is from the live box.

Deltas from the proposal, worth noting:
- **Lua is filtered to config-looking names** (`config.lua`/`settings*.lua`), not every
  `.lua` — a mod ships dozens of source modules and listing them all as "config" was
  noise. They remain **read-only** when shown.
- **Discovery lists what exists** + a template placeholder when a `*.default.*`/
  `*.example.*` has no live sibling; the fully-generic "mod wants a Saved config that
  doesn't exist yet" case isn't detectable, so that one (BaseRadiusImproved) was the
  manual pre-create on 2026-08-06 — the editor now finds and edits it.
- **Path guard is a whitelist:** the client can only name a file that discovery
  produced (re-discover + match by id on every read/write), so traversal is impossible
  by construction — verified `../../../../etc/passwd` → "not found".

## 1. Goal
Let an admin view and edit an installed mod's **own** configuration from the Mods
tab — the per-mod settings files that today are only reachable by hand on the game
volume. Scope is UE4SS-mod configs; the game's own configs already have bespoke
editors (World Settings, Engine.ini, PalDefender Config.json) and are out of scope.

## 2. Why this is not trivial — the config landscape (surveyed live 2026-08-06)
There is **no convention**; each mod author does their own thing. Across the ~17
installed UE4SS mods, three formats in scattered locations:

| Format | Where | Examples | Editable? |
|---|---|---|---|
| `config.lua` (most common) | `<mod>/Scripts/config.lua` | AntiWaste, ChestOrganizer, ProgressiveCaptureMastery, PalworldBaseAutomation, BaseRadiusImproved | **No — it's Lua code**; a stray comma bricks the mod |
| JSON | `<mod>/…*.json` | QualityOfLifeConfig.json, RecoverPalSpheres/config.json | Yes (parse + validate) |
| INI | `<mod>/Scripts/*.ini`, `<mod>/*.ini` | SmartPalFeeding.ini, AlphaLuckyPalSurgery/settings.ini, PalworldBaseAutomation/settings.ini | Yes (parse + validate) |

Two wrinkles that shape discovery:
- **Runtime vs shipped config.** Some mods ship a `Scripts/config.lua` holding
  DEFAULTS/logic but read their real editable config from a **runtime** file
  elsewhere — e.g. BaseRadiusImproved reads `Pal/Saved/BaseRadiusImproved/config.json`
  (`../../Saved/<mod>/` relative to `Pal/Binaries/Win64`), which **doesn't exist until
  first boot** (and its own `os.execute` mkdir fallback fails under Wine, so it never
  gets created — the reason this spec exists). Discovery must look in `Pal/Saved/<mod>/`
  too and offer to create a missing runtime config.
- **`.ini` companions:** several mods ship `*.default.ini` / `*.example.ini` templates
  next to the live file (SmartPalFeeding, PalworldBaseAutomation). The template is the
  seed, not the live config — edit the live one; the template is a "reset to defaults"
  source.

## 3. Discovery (`lib/mod-config.ts`, new)
`listModConfigs(modName)` → the editable config file(s) for one UE4SS mod. Search, in
priority order, and classify each hit:
- `Pal/Saved/<mod>/*.json|*.ini` (runtime config — the one that usually matters)
- `<mod>/*.json|*.jsonc|*.ini` and `<mod>/Scripts/*.json|*.jsonc|*.ini`
- `<mod>/Scripts/config.lua` and `<mod>/Scripts/*.lua` → classified **read-only (Lua)**
Each result: `{ path, relLabel, format: 'json'|'jsonc'|'ini'|'lua', editable, exists }`.
Reuse `resolveUe4ssModsDir()`; resolve `Pal/Saved` from the same game dir
(`currentGameDir()`), instance-aware. Skip `*.default.*`/`*.example.*` as *live*
targets (offer them as "reset" sources instead). Path-traversal guarded — every
resolved path must stay under the mod dir or `Pal/Saved/<mod>/`.

## 4. Editability rules
- **JSON / JSONC / INI → editable.** Validate on save: `JSON.parse` (JSON), a tolerant
  JSONC strip-then-parse (JSONC), and an INI round-trip (ini parse). **Reject an
  invalid edit with the parser error — never write a config that would break the mod.**
- **Lua → read-only.** Show it (so the admin can see the defaults/logic) but do not
  offer to save; editing executable Lua as text is how you brick a mod. A future phase
  could allow it behind a scary confirm, but MVP does not.
- **Missing runtime config → offer "Create default".** For a known runtime location
  (`Pal/Saved/<mod>/`) that doesn't exist, create the dir (the volume's `Pal/Saved` is
  `0777`, so the dashboard uid 2001 can) and seed from the mod's `*.default.*`/
  `*.example.*` template if present, else an empty `{}`/blank. (This is exactly the
  manual fix applied to BaseRadiusImproved on 2026-08-06.)

## 5. Write path — reuse, don't reinvent
Edits go through **`writeConfigFileWithBackup`** (`lib/config-write.ts`): snapshot the
current file to a timestamped `<file>.<stamp>.bak` (newest 10 kept), then atomic
temp+rename. Fully reversible, same as World Settings / Engine.ini / PalDefender.
Atomic rename needs only dir-write (satisfied by `Pal/Saved` `0777` and the mods dir),
so an edit works even if the game later `chown`s the file to `steam` (CLAUDE.md gotcha
9). **Effective on the next server restart** — mods read their config at load; the UI
says so and never implies a live reload.

## 6. API + UI
- `app/api/mod-config` (admin-only, instance-scoped via `runWithInstance`):
  - `GET ?mod=<name>` → the discovered config list + each editable file's current text.
  - `POST { mod, path, content }` → validate for the file's format → `writeConfigFile
    WithBackup`. `POST { mod, action: 'create', path }` → seed a missing runtime config.
  - Reject any `path` that escapes the mod dir / `Pal/Saved/<mod>/`.
- **Mods tab:** a **Config** affordance on a UE4SS mod row when it has any discovered
  config; opens a sheet/dialog listing its file(s). Editable files get a textarea +
  format-validated **Save** (inline parser-error on failure) + a "restart to apply"
  note; Lua files render read-only with a "config is code — edit on disk" note; a
  missing runtime config shows **Create default**. Reuse `dropdown`/`sheet`/`alert-
  dialog` primitives; no new tab.

## 7. Safety
- Admin-tier only (same bar as installing/removing mods); mod tier rejected.
- Never write invalid content (§4); never overwrite with a template a config that
  already exists (mirror the mods' own guard).
- Path-traversal guarded on every resolved path; edits confined to the mod dir +
  `Pal/Saved/<mod>/`.
- Reversible via the `.bak` snapshots; `.bak` files stay gitignored (game volume, not
  the config repo).

## 8. Phasing
- **MVP:** discovery + JSON/INI edit with validation + Lua read-only + create-missing-
  runtime-config, through the shared backup write path. Covers the majority of
  *tunable* settings without touching Lua.
- **Later (optional):** JSONC for PalSchema mod data; per-known-mod structured forms
  (schema-driven) instead of raw text for the popular mods; opt-in Lua editing behind a
  hard confirm; a "reset to template" action from `*.default.*`.

## 9. Verification
- Discovery lists the real files found live (§2 table) with correct format/editable
  flags; Lua marked read-only; BaseRadiusImproved's runtime `Pal/Saved/...config.json`
  discovered and editable.
- A bad JSON/INI edit is rejected with the parser error and leaves the file untouched;
  a good edit lands, creates a `.bak`, and is picked up after a restart.
- Typecheck → rebuild → verify on preview `:3001` → deploy → commit, per working style.

## 10. Out of scope
- Editing the game's own configs (already covered elsewhere).
- Editing `config.lua`/executable Lua in the MVP (read-only; risk of bricking a mod).
- A generic "any file on the volume" editor — this is scoped to mod configs only.
- Live-reloading configs without a restart (mods read at load; not our call).
