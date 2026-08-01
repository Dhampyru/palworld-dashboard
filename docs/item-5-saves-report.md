# Palworld Dashboard — Item #5 (Saves & Backups) Report

*Generated 2026-07-26. Covers dashboard commits `cebe074` → `32991e7`, plus the #6 kickoff.
Production server "Palkatraz" (Palworld 1.0, Windows binary under WineHQ stable).*

## 1. Scope & how it evolved

Item #5 began as **Saves & backups** (backup/restore/switch worlds) and grew into a
**full save inspector + editor**. The pivotal unlock: Palworld 1.0 saves are `PlM1`/Oodle-
compressed GVAS, which no community parser read — until `oMaN-Rod/palworld-save-pal`
(MIT, Rust) shipped a **pure-Rust Kraken decoder** (`ooz-rs`, no proprietary `oo2core`
DLL). We vendor its `psp-core` crate and build small CLI helpers the Node app shells out
to. This made native read **and write** of the live saves possible.

## 2. Save-tooling infrastructure (vendored, MIT)

Built in a cached Docker `savtools` Rust stage from the pinned fork
`Dhampyru/palworld-save-pal @ 0d99b04`. Five helper binaries (`savtools/*.rs`), plus
bundled game data (`/usr/local/share/psp-data/json`, 22 MB, for friendly Pal names):

| Binary | Purpose |
|---|---|
| `psp-decode` | PlM1/Oodle `.sav` → GVAS JSON (raw) |
| `psp-inspect` | Level.sav → `{players, guilds, pals}` summaries |
| `psp-player` | One player's inventory (5 containers) + stats + stat-points |
| `psp-delete-player` | Remove a player from Level.sav (+ orphan-guild cleanup) |
| `psp-edit-player` | Write player basics + Pals + item counts |

## 3. Features delivered (in build order)

**A. Backups / worlds core** (`cebe074`, `86d86d2`, `7680456`)
List worlds (active by `DedicatedServerName`), create/restore/switch/delete backups
(tarballs in `game/backups`), authed download. Runs as uid 2001 on the mounted volume —
**no host privilege**. Restore refuses (409) while the server answers, auto-takes a
`prerestore` snapshot first.

**B. Robustness fixes** (`e07b62f`, `e32764d`, `fff39ff`)
- Stopped-server detection requires an **authenticated 200** (port 8212 answers 401 even
  when the container is Exited).
- Restore tolerates non-owner dir metadata errors (files still extract; game re-chowns on
  start).
- A stopped server now clears the stale "Connected" badge + roster.

**C. Per-player saves + native inspector** (`a344a50`, `bda8e45`, `3ed420d`)
List `Players/<uid>.sav`, native inspect showing level + owned Pals (species/level). Works
for **offline** players (the whole reason for native parsing — PalDefender's export fails
for the disconnected).

**D. Roster polish** (`89c1a75`, `5cdaa69`, `b1e937c`, `fc8c324`, `21ac61a`, `551d3e3`)
Fixed the Kick/Ban/⋮ buttons clipping off the panel (root cause: Radix ScrollArea's
`display:table` wrapper defeats flex-shrink — fixed with a scoped `display:block`
override). Player-save rows now show the owner's name **and online/offline state** even
when disconnected. Dropped redundant coords from roster rows.

**E. Delete player from world** (`afa6095`, `e145f1a`) — *live-verified*
Removes a player's character/Pals/inventory/base from Level.sav so they hit character
creation on next join.
- **Key discovery:** deleting the `.sav` file alone does NOT force recreation (the game
  regenerates it from Level.sav).
- **Second discovery (live failure):** every solo player is admin of their own auto-created
  "Unnamed Guild," and leaving that orphan guild caused
  `FailedInvalidLoginPlayerCharacterHandle` on rejoin. Fixed by branching on guild
  membership: solo → delete the whole guild; multi-member non-admin → remove just the
  player; multi-member admin → refuse with a named-guild warning.
- **Confirmed live: player landed in character creation.**

**F. Read-only inventory view** (`dbf0ab5`) — *browser-verified*
Inspect dialog shows a player's 5 containers (Inventory/Key Items/Weapons/Equipment/Food)
with item ID + category/rarity + count, and durability/ammo for gear. Items show game IDs
(no localized names in bundled data — same as the RCON picker).

**G. Stage 3 editing** — *verified on live-world copies* (`90bf680`, `a230caf`, `9385742`)
The inspector became a **writer**, all through one atomic Level.sav write with a
server-stopped guard (409 otherwise) + automatic `preedit` backup:
- **Player basics:** level, exp, HP, stomach, sanity, stat-point allocations.
- **Pals:** per-Pal level + one-click "heal all" (heal runs after level edits so HP resets
  to the new level's max).
- **Items:** edit/remove existing counts (0 removes; clamped to each item's real
  max-stack). *Removal gotcha:* `apply_item_container_dto` deletes a slot only when marked
  `"None"`, not by dropping it.

Safe-by-construction: each edit builds the player's **full** current DTO, mutates only the
touched fields, and round-trips everything else (techs, quests, inventory, Pals all
preserved).

**H. Scheduled auto-backups** (`32991e7`) — *live-verified in-container*
An "Auto-backup" card: master on/off, interval (min), keep-N, "skip when no players
online," last-run status, Save/Test. Runs **in-process** via Next `instrumentation.ts` on
server boot (no sidecar/host unit). Settings persist to `./data`. Ticks every 60s, backs up
when due (survives restarts). Auto-backups are prefixed `palworld-save-auto-` so
**retention prunes only those** — never daily/manual/preedit/prerestore. Verified:
scheduled tick created a backup, retention pruned to newest N, skip-when-empty skipped with
no players. **Ships disabled by default.**

## 4. Verification status

- **Live-verified in production:** delete-player (character creation confirmed),
  auto-backup scheduler (create/prune/skip), the earlier browser QA pass.
- **Verified on exact copies of the live world:** all Stage 3 edits (persist correctly,
  everything else preserved, Level.sav re-parses valid).
- **Not yet done by owner:** in-game spot-check of the edit results
  (stop → edit → start → observe).

## 5. Hard-won gotchas (recorded in CLAUDE.md)

1. `.sav` deletion ≠ character reset (data lives in Level.sav).
2. Solo players are their own Unnamed-Guild admin; orphan guilds break rejoin.
3. Item removal needs the `"None"` sentinel.
4. Port 8212 returns 401 even when the container is stopped.
5. Radix ScrollArea `display:table` defeats flex truncation.

## 6. Open threads on #5 (optional)

- **Public-release gate:** the bundled 22 MB game data is a redistribution question (fine
  for private deploy).
- **Add brand-new items:** needs an item-ID picker; overlaps RCON `give` — deliberately
  deferred.

## 7. #6 (Auto-restart) — just kicked off, awaiting a decision

Purpose: crash/hang-triggered + memory-threshold restarts, hourly cap against loops, manual
stops not counted as crashes. Builds on the flag-file → host-systemd restart path.

**Architecture finding:** crash/hang detection + trigger + cap + manual-stop exclusion is
fully doable inside the dashboard (it already writes `restart.request` and can see
`/run/palworld/*` lifecycle flags + REST health). **But the dashboard cannot read the game
container's memory** (no Docker socket, no cgroup, and REST metrics omit memory). So the
memory-threshold half needs a host-side memory source. **Pending decision:**
(a) host publishes memory → panel decides, (b) full host-side watcher, or
(c) dashboard-only now + defer memory.

---

## Appendix — dashboard commits for item #5 (newest first)

```
32991e7 feat(saves): scheduled auto-backups (interval, retention, skip-when-empty)
9385742 feat(saves): Stage 3 item editing — edit/remove existing item counts
a230caf feat(saves): Stage 3 Pal editing — per-Pal level + heal-all
90bf680 feat(saves): Stage 3 player-basics editing (level/exp/hp/stomach/sanity/stats)
dbf0ab5 feat(saves): read-only per-player inventory in the Save Inspector
e145f1a fix(saves): remove the player's orphan guild so rejoin isn't rejected
551d3e3 refactor(roster): drop world coordinates from roster rows
fc8c324 feat(saves): show online/offline state on each player-save row
21ac61a fix(roster): stop Kick/Ban/⋮ clipping off the panel's right edge
afa6095 feat(saves): delete player from world to force character recreation
b1e937c feat(saves): show a player save's owner name even when offline
5cdaa69 fix(roster): stop the Kick/Ban/⋮ buttons clipping off the panel
89c1a75 fix(ui): visible roster ⋮ menu; drop Vercel analytics
3ed420d feat(saves): Stage 2 — per-player level + Pals from Level.sav (native)
bda8e45 feat(saves): Stage 1 — native save inspector (read-only) via psp-core
a344a50 feat(saves): per-player save management (list + delete)
fff39ff fix(saves): restore succeeds despite non-owner dir metadata errors
e32764d fix(saves): restore up-check requires an authenticated 200, not any response
e07b62f fix(status): reflect a stopped server — clear stale Connected badge + roster
7680456 feat(saves): Saves tab UI + authed backup download
86d86d2 feat(saves): mutating actions — backup / switch / restore / delete
cebe074 feat(saves): groundwork for item 5 — spec + read-only listing
```
