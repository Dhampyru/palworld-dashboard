# Spec: UE4SS Loader + version-gated mod install (Mods tab)

Adds a **UE4SS Loader** section to the Mods tab: shows the loaded UE4SS build,
installs/swaps between builds, and disables UE4SS entirely. Then splits the
install-a-mod area into **three version-gated parts** (pak / UE4SS / PalSchema).
Pairs with `palschema-support.md` (the PalSchema sub-mod section).

**This rewrites the injection layer on a LIVE server.** Every swap is guarded:
backup-first, server-stopped, verify-after, one-click rollback. The dashboard
never swaps on its own — the operator clicks, with the server down.

## 0. Sources (confirmed 2026-07-26)

| Action | Source repo / tag | Notes |
|---|---|---|
| Latest **official** | `UE4SS-RE/RE-UE4SS` latest stable (v3.0.1) | = what's installed now (`c2ac246`) |
| Latest **beta** | `UE4SS-RE/RE-UE4SS` `experimental-latest` (pre-release) | rolling |
| **Experimental (PalSchema)** | `Okaetsu/RE-UE4SS` tag `experimental-palworld` (`c838a8a`, 2026-07-19) | the build PalSchema 0.6.1 requires |
| Operator upload | uploaded zip / pasted release-asset URL | risk-warned; user vets it |

PalSchema **the mod** ships separately (`Okaetsu/PalSchema` 0.6.1) and installs
as a UE4SS mod (see `palschema-support.md`); it does NOT bundle UE4SS.

**Fetch model (hybrid, per owner):** official + beta auto-download from GitHub;
experimental + any custom build require the operator-upload path (with a warning)
— that dangerous swap gets human vetting. All downloads pinned to the source
repos above; nothing else.

## 1. Loaded-version display

Read the live `ue4ss/UE4SS.log` startup banner: version (`v3.0.1 Beta #0`), git
SHA (`c2ac246`), build config (MSVC / Shipping / Win64), and infer the SOURCE
(official vs experimental-palworld vs beta) from the SHA against the known set.
Also show enabled/disabled (dwmapi present?). If UE4SS never loaded (no banner),
say so. This is the source of truth for the version-gating below.

## 2. Version actions (the four buttons) + guardrails

Each install/swap:
1. **Refuse unless the server is stopped** (409) — same gate as save edits; a
   live swap corrupts the running Wine session.
2. **Backup the current UE4SS first** — tar `Win64/ue4ss/` + `Win64/dwmapi.dll`
   to the backups area as `ue4ss-<loadedver>-<stamp>.tar.gz`. Reversible.
3. **Validate the incoming zip** — must contain a `ue4ss/` dir (or the files that
   belong under it) + a `dwmapi.dll`; reject anything else with a clear message.
   Preserve `UE4SS-settings.ini` (official's own note: replace all but settings)
   and the existing `ue4ss/Mods/` unless the operator opts to reset.
4. **Extract** into `Win64/` (dwmapi + ue4ss), atomically where possible.
5. **Surface the new banner after restart** — the display re-reads UE4SS.log; the
   operator confirms the intended version loaded. **Rollback** button restores
   the pre-swap tarball.
- **Disable UE4SS** = rename `Win64/dwmapi.dll` → `dwmapi.dll.disabled` (the
  loader stops injecting; Wine falls back to builtin). Re-enable renames back.
  Reversible, no download. (Mirrors the PalDefender d3d9 toggle discipline.)

**Wine note (CLAUDE.md):** the dwmapi override (`WINEDLLOVERRIDES dwmapi=n,b`) is
what makes the proxy load; a swap only replaces the DLL behind that override — it
does NOT change the override. Also carries the known UE4SS character-creation
regression risk (gotcha #4): verify "existing character loads," not just "joins,"
after any swap.

## 3. Install-a-mod, split three ways + version-gated

- **Pak mods** — always enabled (engine feature, UE4SS-independent).
- **UE4SS mods** — enabled when ANY UE4SS build is loaded + enabled; greyed with
  a reason when UE4SS is disabled/absent.
- **PalSchema mods** — enabled ONLY when the **experimental-palworld** build is
  loaded (PalSchema won't run on official/beta); greyed otherwise with "requires
  the PalSchema UE4SS build — swap in the Loader above." Backed by
  `palschema-support.md` (`ue4ss/Mods/PalSchema/Mods/*`).

Existing UE4SS/pak install + toggle paths are reused, just regrouped — no
regression to current behavior (spec acceptance).

## 4. Defaults / deployment posture

- **Public release:** UE4SS **disabled by default** — a mod loader shouldn't be
  live for someone standing up a fresh server; they enable + choose a build.
- **This deployment:** target the **experimental-palworld** build so PalSchema
  works. The swap to it is the operator's click (server stopped), not automatic.

## 5. Out of scope (v1)

- Auto-updating UE4SS on a schedule (manual, deliberate only).
- Editing UE4SS-settings.ini in-dashboard (raw SSH for now).
- Managing multiple UE4SS installs side by side (one active loader).

## 6. Acceptance

1. Loaded-version card shows the correct version/SHA/source + enabled state.
2. Disable → `dwmapi.dll.disabled`, UE4SS-mods + PalSchema sections grey out;
   re-enable restores. Server-restart notice shown.
3. Swap (operator-upload of the experimental build) on a STOPPED server: current
   UE4SS is tarred to backups first → extracted → after restart the banner shows
   the experimental build → PalSchema section un-greys. Rollback restores the
   prior build.
4. Official/beta auto-download install works the same (backup → extract → verify).
5. Pak/UE4SS/PalSchema install parts gate correctly on the loaded build.
6. Existing pak + UE4SS mod list/toggle/install unaffected.

## Build order

1. ~~Spec~~ (this doc).
2. Loaded-version display + Disable/enable toggle (safe, no download).
3. Three-way gated mod-install split (regroup existing + wire the gate).
4. Swap engine: operator-upload validate → backup → extract → rollback; then the
   official/beta auto-download buttons.
5. PalSchema mod section (`palschema-support.md`) — unlocks once experimental is
   loaded.
