# Spec: Official Workshop Mod Support — "UE4SS (Workshop layout)" loader build

Status: **SHELVED (2026-07-31) after a LIVE failure — do not re-enable without the
two fixes below.** The staging validation launched Wine directly and bypassed the
game's `entrypoint.sh`, which turned out to be decisive. On the first live swap: (1)
`swapToWorkshop` wrote `WorkshopRootDir` with the DASHBOARD's mount path
(`/palworld-game`) instead of the game container's (`/palworld`), so the loader
never found the packages; and (2) on start, the entrypoint saw `dwmapi.dll` missing
and **reinstalled the dwmapi proxy**, resurrecting the proxy regime and stranding
PalSchema + custom mods. Recovered via the pre-swap backup. The **"UE4SS (Workshop
layout)" button was removed** (`9002439`); the lib swap engine + route action remain
but are unreachable. **Chosen direction instead: Option B** — install Steam Workshop
mods into the proxy layout via each item's `Info.json` `InstallRule` (see steam-
workshop-download.md), no loader swap. To ever revive this: fix the wine-path
translation AND make the entrypoint skip its UE4SS reinstall in workshop regime,
then validate against the REAL entrypoint boot (not the direct-Wine shortcut).

Prior status (kept for context): **investigated + staging-PROVEN (2026-07-31).**
Decision (single regime, fourth build) made by the owner; investigation (§2) and the
isolated staging experiment (§9) are DONE — **no live-server impact**. **KEY RESULT (outcome a,
confirmed): the official loader deploys + injects UE4SS AND loads PalSchema on this
headless Wine dedicated server with NO dwmapi proxy** — the "remove the proxy /
official injects UE4SS" premise HOLDS. The one requirement that makes it work is
`WorkshopRootDir=<abs path>` pointed at a folder of `<name>/Info.json` packages
(empty `WorkshopRootDir` does nothing headless — see §9). Acquiring Workshop packages
still needs an **owning** Steam account (anonymous can't; §2). PalDefender (d3d9)
coexists in every case. The fourth build is viable and genuinely proxy-free —
**recommend building.** Requires an explicit "start".

---

## 1. Decision

**Single UE4SS regime, always — no coexistence.** Palworld 1.0 ships an official
mod loader (`Mods/PalModSettings.ini` + `Mods/NativeMods/…`). Our production stack
injects UE4SS the community way, via a `Win64/dwmapi.dll` proxy. Two UE4SS runtimes
in one process conflict (gotcha #4 class). So the dashboard treats the official
layout as a **fourth loader build** in the existing swap engine — **"UE4SS (Workshop
layout)"** — selectable exactly like the three community builds (Stable / Beta /
PalSchema-Okaetsu). Selecting it **migrates the whole stack** into the official
layout and removes the proxy; selecting any community build restores the proxy
regime. Only ever one regime is live.

**PalDefender is out of the regime.** It rides the `Win64/d3d9.dll` proxy and does
not use UE4SS; it stays identical in both regimes and is verified alive after the
first boot in each.

---

## 2. Verified current state (live inspection, 2026-07-30)

- Dedicated-server appid **2394010**, game appid **1623730**. Server binary
  `Pal/Binaries/Win64/PalServer-Win64-Shipping-Cmd.exe`, v1.0.x "Palkatraz".
- **Official loader is present and idle on the PUBLIC branch.** `appmanifest_2394010.acf`
  has an **empty `UserConfig {}`** (no `betakey`) → default/public branch, buildid
  `24181105`. The loader auto-generated `/palworld/Mods/PalModSettings.ini`:
  ```ini
  [PalModSettings]
  bGlobalEnableMod=True
  WorkshopRootDir=
  ConfigVersion=1.0
  bNeedShowErrorOnNextStart=True
  ```
  No `ActiveModList=`, no `Mods/NativeMods`, no `Mods/Workshop` → loading nothing.
  It coexists with our stack today only because it is idle.
  **No "Moddable" branch switch is required** — that was the Early-Access-era
  mechanism; 1.0 merged official Workshop support into public. (Community guides
  that still say "recreate on the Moddable branch" are stale for a 1.0 build.)
- **Anonymous SteamCMD cannot fetch Workshop items — tested on the VPS.**
  `login anonymous` connects, but `workshop_download_item 1623730 3765577035` →
  `ERROR! Download item … failed (Failure).` Palworld is a paid app; Workshop
  content needs an **owning** account. The official docs offer **no** SteamCMD path
  at all — the sanctioned flow is *subscribe on a client → copy the folder to the
  server* (`WorkshopRootDir` / `-workshopdir`). **Consequence:** the official regime
  is a packaging + enable convention, **not** a headless auto-download pipeline; and
  we will **not** put owning Steam creds on the VPS. Our Nexus integration remains
  the acquisition path.
- Current community stack (the "proxy regime"): UE4SS `Win64/ue4ss/` injected by
  `Win64/dwmapi.dll`; PalSchema at `Win64/ue4ss/Mods/PalSchema/mods/`; paks at
  `Pal/Content/Paks/~mods/`; PalDefender = `Win64/d3d9.dll` + `d3d9_config.json`
  (`load_dlls:[PalDefender.dll]`) + `PalDefender.dll`.

---

## 3. The two regimes (exact paths)

| Concern | **Proxy regime** (community; current) | **Workshop regime** (official; new) |
|---|---|---|
| UE4SS root | `Pal/Binaries/Win64/ue4ss/` | `Mods/NativeMods/UE4SS/` |
| UE4SS mods dir | `Pal/Binaries/Win64/ue4ss/Mods/` | `Mods/NativeMods/UE4SS/Mods/` |
| PalSchema sub-mods | `…/ue4ss/Mods/PalSchema/mods/<Pkg>/` | `Mods/NativeMods/UE4SS/Mods/PalSchema/mods/<Pkg>/` |
| Pak mods | `Pal/Content/Paks/~mods/` | `Pal/Content/Paks/~WorkshopMods/<Pkg>/` |
| LogicMods | `Pal/Content/Paks/LogicMods/` | `Pal/Content/Paks/LogicMods/` (same) |
| UE4SS injection | `Win64/dwmapi.dll` proxy (`WINEDLLOVERRIDES dwmapi=n,b`) | **official loader** — see §8 open question |
| Enable mechanism | `Mods/mods.txt` (`Name : 1`) | `Mods/PalModSettings.ini` `ActiveModList=<Pkg>` + each mod's `Info.json` |
| PalDefender | `Win64/d3d9.dll` proxy — **unchanged** | `Win64/d3d9.dll` proxy — **unchanged** |

Install root `Mods/` is beside `PalServer.exe` (i.e. `/palworld/Mods/`), **not**
`Win64/`. `WorkshopRootDir=` empty → the loader's default workshop dir.

---

## 4. Active-regime resolver (dashboard-wide)

**No consumer hardcodes a mod path.** Introduce a single resolver all mod-path
consumers call: PalSchema section, mods listing, install targets (game-mods,
palschema, Nexus install), pak download.

```ts
type ModRegime = 'proxy' | 'workshop'
interface RegimePaths {
  regime: ModRegime
  ue4ssRoot: string       // …/Win64/ue4ss        | …/Mods/NativeMods/UE4SS
  ue4ssModsDir: string    // …/ue4ss/Mods          | …/NativeMods/UE4SS/Mods
  palSchemaModsDir: string
  pakModsDir: string      // Paks/~mods            | Paks/~WorkshopMods
  injection: 'dwmapi' | 'official'
  enable: 'mods.txt' | 'palmodsettings'
}
async function activeRegime(): Promise<ModRegime>
async function resolveRegimePaths(r?: ModRegime): Promise<RegimePaths>
```

- **Active regime is a dashboard-owned marker** (extend `data/ue4ss-staged.json`
  with `regime`, or a sibling `data/mod-regime.json`), written by the swap.
- **Disk-detection fallback** (marker missing) so status is never blank:
  `Win64/dwmapi(.disabled)` present → `proxy`; else `Mods/NativeMods/UE4SS`
  present → `workshop`; else `proxy` (nothing installed).
- `resolveUe4ssModsDir()` / `PAK_MODS_DIR` / `resolvePalSchemaModsDir()` become
  thin wrappers over the resolver. Existing proxy-regime callers keep working
  unchanged because the resolver returns today's paths for `proxy`.

---

## 5. The fourth build: swap TO "UE4SS (Workshop layout)"

Reuses the swap engine's shape (refuse unless stopped → tar backup → wipe →
install → restore config → record staged) with regime-aware steps:

1. **Guard:** server stopped (caller-enforced, like every swap).
2. **Snapshot / backup** the current proxy install (existing `backupUe4ss()` tar of
   `Win64/{ue4ss,dwmapi.dll,…}`), plus snapshot operator config + custom Lua/BP mods
   (existing `snapshotTree` path). Skip ABI-locked C++ mods (existing behavior) —
   PalSchema/other C++ mods are re-provisioned for the target build.
3. **Remove proxy regime:** `wipeUe4ssLayouts()` (deletes `Win64/dwmapi.dll` +
   `Win64/ue4ss/` + flat artifacts). **Do NOT touch** `d3d9.dll`, `d3d9_config.json`,
   `PalDefender*`, or game files.
4. **Let the official loader deploy + inject UE4SS (no proxy).** VALIDATED by §9:
   do **not** hand-place UE4SS in `NativeMods` and do **not** keep a dwmapi proxy.
   Instead stage the UE4SS package (folder with `Info.json` Type `UE4SS`) into a
   **`WorkshopRootDir`** folder, set `ActiveModList=UE4SSExperimentalPW`, and the
   game itself deploys it to `Mods/NativeMods/UE4SS/` (tracked in `Mods/ManagedMods/
   <Pkg>/InstallManifest.json`) and injects it at boot — fresh `UE4SS.log`, no proxy.
   Use the same Okaetsu `experimental-palworld` UE4SS the community build uses
   (Workshop package `UE4SSExperimentalPW` = that exact build, so PalSchema parity is
   preserved).
5. **Migrate mods** into the NativeMods tree via the resolver's `workshop` paths:
   Lua → `…/UE4SS/Mods/<Pkg>/`, PalSchema sub-mods → `…/PalSchema/mods/<Pkg>/`,
   paks → `Paks/~WorkshopMods/<Pkg>/`.
6. **Package each migrated mod** — write `Info.json` (§6) + append `ActiveModList=<Pkg>`
   to `PalModSettings.ini` (§7).
7. **Record staged** `{ source:'workshop', regime:'workshop', version }`; set
   `pendingRestart`. PalModSettings stays `bGlobalEnableMod=True`.

**Swap BACK to any community build** must fully restore the proxy regime — this is
the acceptance bar (§7 of the last swap engine proved round-trip works):
- Remove `Mods/NativeMods/UE4SS/` and the `ActiveModList=` lines we added (the
  config writer removes only keys it owns; unknowns preserved).
- Reinstall the chosen community UE4SS build at `Win64/ue4ss/` + restore
  `Win64/dwmapi.dll`; re-home migrated mods back to the proxy paths; rebuild
  `mods.txt`. Roll paks back from `~WorkshopMods/` to `~mods/`.
- Or simplest and safest: **restore the pre-swap tar** taken in step 2 (exact
  byte-for-byte proxy regime) and reset the regime marker. Round-trip = the
  original proxy install, verified by boot + UE4SS banner + PalDefender alive.

---

## 6. Info.json packaging (official format)

Format from Pocketpair's own **PalworldModUploader** docs (`docs/en/02-Package.md`,
`04-Tech.md`). `InstallRule` is an **array** of `{Type, Targets, IsServer?}` — there
is **no** top-level `IsServer`; a rule carries `"IsServer": true` to apply on the
dedicated server.

```json
{
  "ModName": "<display name>",
  "PackageName": "<technical id; = Steam item id for real Workshop mods>",
  "Thumbnail": "thumbnail.png",
  "Version": "1.0.0-1",
  "DebugMode": false,
  "MinRevision": 82182,
  "Author": "<author>",
  "Dependencies": [],
  "Tags": [],
  "InstallRule": [
    { "Type": "Lua", "IsServer": true, "Targets": ["./Scripts"] }
  ]
}
```

`InstallRule.Type` ∈ **`UE4SS` | `Lua` | `PalSchema` | `LogicMods` | `Paks`**, deploy
targets per §3. `Tags` vocab: `PalSchema, UE4SS, Model Replacement, Utilities,
Gameplay, User Interface`. `MinRevision` = last 5 digits of the game version.
**Generator rules for migrated mods:**
- `PackageName` — our mod key (folder name), sanitized to the loader's id rules.
- `InstallRule` — derive `Type` from what we're migrating (a PalSchema sub-mod →
  `PalSchema`; a Lua mod → `Lua`; a pak → `Paks`), always with `IsServer:true` (our
  mods are server-side). A mod is skipped from the official regime if we can't map
  it to a server-eligible rule.
- Preserve any **existing** `Info.json` the mod already shipped (real Workshop mods
  carry one) — only synthesize when absent.

---

## 7. PalModSettings.ini config writer

A proper config writer, same discipline as the PalDefender surgical JSON writer and
`lib/config-write.ts`:
- **Snapshot** (timestamped `.bak` via `writeConfigFileWithBackup`) before writing.
- **Preserve unknowns** byte-for-byte — the loader may add keys
  (`bNeedShowErrorOnNextStart`, `WorkshopRootDir`, future keys) we don't manage.
- We own exactly: `bGlobalEnableMod` and the set of `ActiveModList=` lines for mods
  we migrated. Adding/removing a mod edits only its `ActiveModList` line. `.ini`
  allows repeated `ActiveModList=` keys (one per mod) — the writer treats it as a
  multi-valued key, not last-wins.
- Never touch `.env`/token files (they aren't config surfaces here anyway).

---

## 8. Open question — ANSWERED (outcome a, 2026-07-31)

**Q: Does the official loader inject UE4SS into the dedicated-server process under
Wine, or is a proxy DLL still required in the Workshop layout?**
**A: The official loader injects UE4SS itself — NO proxy required (outcome a).**
Proven with the real Workshop packages `UE4SSExperimentalPW` + `PalSchema` and
`WorkshopRootDir` set: the game deployed them to `ManagedMods` + `NativeMods` and
injected UE4SS (fresh `UE4SS.log`, no `dwmapi.dll` anywhere), then loaded PalSchema.
The official UE4SS package **ships no proxy DLL** precisely because the game is the
injector. Two earlier false negatives (§9) were config errors, not the loader:
(1) hand-placing UE4SS in `NativeMods` — the game only injects what the loader
*deploys* from the workshop dir, it doesn't scan `NativeMods`; (2) empty
`WorkshopRootDir` — headless there are no Steam subscriptions to read, so the loader
had no source. The fix is the documented dedicated-server knob:
`WorkshopRootDir=<abs path to a folder of <name>/Info.json packages>`.

Historical framing (kept for context):
**Does the official loader inject UE4SS into the dedicated-server process under
Wine, or is a proxy DLL still required in the Workshop layout?** The official loader
manages Workshop mod *deployment* (`ManagedMods/<Pkg>/InstallManifest.json`) and
*enable* (`ActiveModList`), but UE4SS still needs a DLL-injection vector into
`PalServer-Win64-Shipping-Cmd.exe`. On the client the launcher injects; on a headless
Wine server this is unproven. Outcomes:
- **(a) Loader injects UE4SS** → §5 step 4 is a pure file placement; the "no dwmapi"
  claim holds. Best case.
- **(b) Loader does NOT inject** → the Workshop layout still needs an injection shim
  (e.g. a proxy DLL pointing at `Mods/NativeMods/UE4SS/UE4SS.dll`). Then the "remove
  the proxy" story is really "re-point the proxy" and the spec's §3 injection row
  changes. The experiment decides this **before** any dashboard code.

Also verify: PalDefender (`d3d9`) still injects with the official loader active;
the migrated mod actually loads/executes; the server reaches ready.

---

## 9. Staging experiment (step 2 — run before touching Palkatraz)

**Isolation:** a throwaway container against a **COPY** of the game install (never
the live `/palworld` volume/container). No published ports. CPU-capped so the live
server is unaffected (host: 32 cores, load ~0.6, 139G free — ample).

**Procedure:**
1. Copy `/palworld` → scratch dir (rsync from the live volume, read-only source).
2. In the copy: remove `Win64/dwmapi.dll` + `Win64/ue4ss/`; install UE4SS under
   `Mods/NativeMods/UE4SS/`; add ONE server-eligible mod (a minimal spec-compliant
   Lua package with `Info.json IsServer:true` writing a load marker — a literal
   Workshop download is impossible anonymously, §2); `ActiveModList=<Pkg>` in
   PalModSettings.ini; leave PalDefender (`d3d9`) intact.
3. Boot the Windows server under Wine in the isolated container far enough for mod
   load (~first 60–120s), capture: UE4SS.log (did UE4SS inject, and from where?),
   the mod's load marker, PalDefender's log/section, `Mods/ManagedMods/` contents,
   and whether the server logs "ready".
4. Kill it. Report §8 outcome (a) vs (b), PalDefender status, and any path/format
   corrections back into this spec.

**Results (run 2026-07-30, isolated copy `/root/palworld-staging`, no live impact):**
- **Control boot (proxy regime, as-copied):** fresh `Win64/ue4ss/UE4SS.log` at boot
  (`UE4SS v3.0.1 Beta #0 #c838a8ac … Loading mods from …\ue4ss\Mods`) + fresh
  PalDefender log → both UE4SS (dwmapi) and PalDefender (d3d9) inject in the isolated
  container. Rig validated.
- **Official-regime boot (UE4SS under `Mods/NativeMods/UE4SS`, dwmapi REMOVED,
  `ActiveModList=ZZWorkshopTest` + `Info.json IsServer:true`, PalDefender kept):**
  - **UE4SS did NOT inject.** No fresh `NativeMods/UE4SS/UE4SS.log`; the Lua probe's
    marker file was never written. Manually populating NativeMods + PalModSettings +
    Info.json is **not sufficient** to load UE4SS on the dedicated server.
  - **The server booted fine anyway** — `Running Palworld dedicated server on :8211`.
  - **PalDefender still injected** via d3d9 (fresh log; `[RESTAPI] Running PalDefender
    RESTAPI on port 17993`) — confirmed regime-independent.
  - **No `Mods/ManagedMods/`** was created; the game's stdout logged nothing about
    UE4SS / NativeMods / workshop. The official loader did not deploy or inject our
    hand-placed mod.

**Interim (manual placement) — a false negative.** Hand-placing UE4SS in
`NativeMods` with no proxy did not inject (no log, no Lua). This looked like
outcome (b) but was a config error: the game does **not** scan `NativeMods`
directly — it only injects what the *loader deploys* there from the workshop dir.
Superseded by the real-package runs below.

**Follow-up runs with the REAL Workshop packages (2026-07-31).** Owner downloaded
the two packages via a secondary owning account (`steamcmd +login … +workshop_
download_item`, run as the non-root `steam` user — running as root failed on the
account's cloud-sync write): `UE4SSExperimentalPW` (item 3625223587) + `PalSchema`
(3625280368), placed as Steam-subscribed content in `steamapps/workshop/content/
1623730/<id>/`, `ActiveModList` set for both, dwmapi removed, PalDefender kept.
- **Run 2 — `WorkshopRootDir=` empty:** loader did **nothing** — no ManagedMods, no
  NativeMods, no UE4SS. Server booted; PalDefender alive. (Empty ⇒ the loader looks
  to Steam *subscriptions*, which a headless anonymous server doesn't have.)
- **Run 3 — `WorkshopRootDir=Z:\palworld\steamapps\workshop\content\1623730`
  (documented dedicated-server knob):** ✅ **full success.** Loader created
  `Mods/ManagedMods/{UE4SSExperimentalPW,PalSchema}/InstallManifest.json`, deployed
  UE4SS to `Mods/NativeMods/UE4SS/`, **injected it** (fresh `NativeMods/UE4SS/
  UE4SS.log`: `UE4SS v3.0.1 #c838a8ac … Loading mods from …\NativeMods\UE4SS\Mods`),
  and **loaded PalSchema** (`Starting C++ mod 'PalSchema'` + hook scan). PalDefender
  fresh log + REST up. Server ready on :8211. **No dwmapi proxy anywhere.**

**Conclusion → OUTCOME (a) CONFIRMED.** The official loader deploys + injects UE4SS
and loads PalSchema on a headless Wine dedicated server, proxy-free — provided
`WorkshopRootDir` points at the package folder. The proxy is NOT required. Working
recipe: `bGlobalEnableMod=True` + `WorkshopRootDir=<abs>` + one
`ActiveModList=<PackageName>` per mod; each package is a folder with `Info.json`
(PackageName + `InstallRule` incl. `IsServer:true`) under `WorkshopRootDir`; the game
does the rest at boot. Acquisition still needs an owning Steam account (§2).

**Implementation increments (built):**
- **Inc 1 (`1147ca3`)** — active-regime resolver (§4).
- **Inc 2 (`9cc9723`)** — swap engine `swapToWorkshop`/`swapToProxy` + PalModSettings
  writer; round-trip proven; synthesized packages + synthetic ids work.
- **Inc 3 (2026-07-31)** — regime-aware status + mod-management findings:
  - **The loader does NOT clobber operator edits.** Staging: after boot 1 deployed
    the tree, an edit to the deployed `NativeMods/UE4SS/Mods/mods.txt` survived
    boot 2 (`InstallManifest.json` tracks the deployed file set; `DebugMode:false`
    ⇒ deploy-once). So ongoing mod management (install/toggle/remove) operates
    **directly on the deployed `NativeMods` tree** via the Inc 1 resolvers — no need
    to edit the source package. (Caveat: a package *version* bump or clearing
    `ManagedMods` would trigger a redeploy that overwrites `NativeMods` — not a
    steady-state concern.)
  - **Our Lua mods + PalSchema sub-mods migrate inside the two synthesized packages**
    (Inc 2), and load via UE4SS's own `mods.txt` — so **no per-mod Info.json /
    ActiveModList generation is needed** (one `ActiveModList=UE4SSExperimentalPW`
    covers all UE4SS sub-mods). That part of the original Inc 3 scope is moot.
  - **Paks are regime-agnostic:** `~mods` is an engine-level auto-mount, so managed
    paks stay in `~mods` in both regimes (swap doesn't move them). `pakModsDir`
    resolves to `~mods` for both; `~WorkshopMods` is only the loader's own deploy
    target for workshop-sourced paks, not a path we manage. (Mounting in workshop
    regime is reasoned from the shared engine, not boot-verified — no pak-mount log
    signal.)
  - **`readUe4ssStatus()` is now regime-aware:** in workshop regime it finds UE4SS
    at `NativeMods/UE4SS` (or the staged package), reads the log/banner there,
    reports `enabled` from `bGlobalEnableMod`, and adds `regime` + `injection`
    (`dwmapi`|`official`) to the status. Nuance (regime-independent): a mod folder's
    `enabled.txt` overrides `mods.txt` in UE4SS's own enable logic.

---

## 10. Acceptance criteria

1. Selecting "UE4SS (Workshop layout)" migrates UE4SS + PalSchema + Lua + paks into
   the official tree, generates valid `Info.json` + `ActiveModList`, removes the
   proxy, and boots with UE4SS active and PalDefender alive.
2. Selecting any community build **fully restores the proxy regime** (round-trip to
   the byte-for-byte pre-swap install); UE4SS banner + PalDefender verified.
3. Every mod-path consumer resolves through the active-regime resolver — no
   hardcoded `~mods` / `ue4ss/Mods` paths remain.
4. PalModSettings.ini round-trips unknown keys untouched.
5. No Steam owning-credentials on the server; Workshop acquisition stays manual /
   via Nexus.

---

## 11. Out of scope
- Auto-downloading Workshop items on the server (anonymous SteamCMD can't; no creds
  on the VPS).
- Client-side mod distribution / parity tooling (the official model expects clients
  to subscribe to matching Workshop mods — a separate track).
- Publishing/uploading mods to the Workshop.
