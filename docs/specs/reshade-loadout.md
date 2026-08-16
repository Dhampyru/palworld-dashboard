# Spec: ReShade in the Client Loadout

Status: **BUILT + verified (2026-08-16).** Full flow exercised via the API (upload base →
add Nexus preset 197 + upload preset → enable → build → verify Win64 placement + uninstall
tracking → disable excludes it). Browser QA pending (no Chrome extension this session).

## Why

ReShade is a client-side DirectX post-processing injector (color/sharpness/etc.). It runs on
each player's GPU and never touches the game server. Operators wanted to ship a consistent
visual look to friends in ONE install, rather than everyone hand-installing ReShade. This bakes
an operator-chosen ReShade into the client loadout as an **optional toggle**.

## How it works

- **Storage** (global, like client mods — the loadout is shared, not per-instance):
  `data/reshade.json` (config) + `data/reshade/base.zip` (the injector bundle) +
  `data/reshade/presets/*.ini`.
- **Base bundle** — operator uploads ONCE (`lib/reshade.ts saveReshadeBase`): any archive,
  normalized to zip, must contain an injector DLL (`dxgi.dll`/`d3d1x.dll`/`reshade64.dll`…) or
  it's rejected. It's the Win64-relative portable-ReShade layout (DLL + `reshade-shaders/` +
  `ReShade.ini`) exported from the operator's own working install.
- **Presets** — tiny recipe `.ini`s, added by **upload** (`.ini` or archive) or **Nexus URL**
  (`addPresetUrl` → downloads the mod's MAIN file, extracts every `.ini` with `Techniques=`).
  Multiple presets can ship. Nexus 197 ("DECENT ReShade") is the reference case.
- **Toggle** — `setReshadeEnabled`. The UI blocks enabling until a base is present.
- **Loadout hook** — `overlayReshadeInto(win64)` in `lib/client-loadout.ts` (called just before
  the summary). When enabled + base present: extracts the base into `game/Pal/Binaries/Win64/`
  (path-escape guarded) and drops preset `.ini`s next to the DLL. Files land under `game/`, so
  the existing `installed-files.txt` walk tracks them → `uninstall.bat` removes them cleanly.
  Reported in `LoadoutSummary.reshade = { files, presets }`.
- **UI** — `components/reshade-card.tsx` in the Invite/loadout panel (`components/invite-panel.tsx`),
  right under "Build friend loadout": toggle, base upload/replace/remove, preset add-by-URL /
  upload-.ini / remove.
- **API** — `app/api/reshade` (admin-only, global). GET = status; POST JSON = setEnabled /
  clearBase / removePreset / addPresetUrl; POST multipart = base / preset upload. Every mutation
  responds with the full `reshadeStatus()` (incl. `basePresent`).

## Coexistence

Client UE4SS uses the `dwmapi.dll` proxy; ReShade uses `dxgi.dll` — different proxies, verified
side-by-side in a built bundle. No conflict.

## Licensing / clean-room (matters for public release)

- **Nothing ships in the repo.** The base bundle + presets live in the data volume
  (`data/reshade/`, gitignored), operator-supplied.
- The **ReShade injector** is BSD-3-Clause (redistributable *with* its copyright notice) — the
  operator's base zip should include ReShade's own `LICENSE`, which then rides the bundle.
- The **shaders** (`reshade-shaders/*.fx`) are separately + variably licensed (MIT / CC BY-NC /
  no-derivatives / custom). This is the real redistribution risk, which is exactly why the base
  is operator-supplied rather than fetched/bundled by the dashboard — same clean-room stance as
  the Pocketpair game data.
- A **preset alone is not a working ReShade** — it references shaders it doesn't contain (Nexus
  197 is a 400-byte `.ini`). The base (DLL + shaders) is mandatory; the toggle enforces it.

## Verified (2026-08-16, API)

Upload base (4 files) → add Nexus 197 preset + upload a local `.ini` (2 presets) → enable →
build: `summary.reshade = {files:6, presets:[...]}`; bundle Win64 held `dxgi.dll`, `ReShade.ini`,
`reshade-shaders/…`, both preset `.ini`s, alongside `dwmapi.dll`; all 6 tracked in
`installed-files.txt`. Disable → next build ships 0. Browser QA still to do with a real ReShade
base (in-game: friends press **Home** to toggle the overlay).
