# PalSchema data editor (with client parity)

Edit ANY installed PalSchema mod's data files (`items/`, `raw/`, `blueprints/` `*.jsonc/.json`)
from the dashboard, and have the edit reach clients too.

## Why
PalSchema data (tech tree, recipes, items, buildings) is **read by the client**, not just the
server — so a server-side edit must also ship to clients or the two desync (see the earlier
"Technology Tree Overhaul not working" finding: server had it, client rendered vanilla).

## Model (overlay)
One edit, applied to both sides:
1. **Server:** the live file `…/ue4ss/Mods/PalSchema/mods/<submod>/<rel>` is written through the
   shared `writeConfigFileWithBackup` (timestamped `.bak` + atomic), validated as JSON/JSONC
   first (a bad edit is refused). Effective on the next **server restart**.
2. **Client parity:** the same content is stored as an **overlay** under
   `data/palschema-overlays/<submod>/<rel>` (per-instance suffixed). The loadout generator
   calls `overlayPalSchemaInto(bundleSubmodsDir)` after placing PalSchema submods, copying each
   overlay onto the client-placed submod — matched by `safeName(submod)` (the bundle folder is
   safeName'd: spaces → underscores). Only submods actually present in the bundle are touched.
   Reported as `summary.palSchemaEdits`.

## Pieces
- `lib/palschema-config.ts` — discovery (`listPalSchemaSubmods`/`listPalSchemaFiles`), read,
  validated write + overlay store, and `overlayPalSchemaInto` (the loadout hook).
- `app/api/palschema-config/route.ts` — admin-only, instance-scoped. GET lists submods / a
  submod's files / one file's content; POST saves.
- `components/palschema-editor.tsx` — the UI (submod → files → Sheet editor), mounted in the
  Mods workspace under **Server mods**. Files with an overlay show an "edited" badge.
- `lib/client-loadout.ts` — calls `overlayPalSchemaInto`; adds `palSchemaEdits` to the summary.

## Guards
- Admin-tier only; path-guarded (client can only name a file discovery produced; `..`/absolute
  rejected); JSON/JSONC validated on save (invalid refused, never written); backups reversible.

## Verified (2026-08-09, live)
Edited Nexus 3205 (`ZZZ_MelwenMods - Technology Tree Overhaul`) `raw/technology_overhaul.jsonc`
via the API → server file written + overlay stored → regenerated loadout reported
`palSchemaEdits: 1` (overlay applied to the client-placed submod). UI browser-verification
pending.
