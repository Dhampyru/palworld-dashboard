# Palworld Dashboard — Progress Report (handoff)

*Generated 2026-07-26. Production server "Palkatraz" (Palworld 1.0, Windows binary under
WineHQ stable, single VPS). Two local-only git repos, no remotes by design:
`~/palworld-dashboard` (the Next.js app) and `~/palworld-server` (config: Dockerfile,
compose, host scripts, doc mirror).*

## TL;DR — what shipped this session

1. **Roadmap #5 (Saves & Backups) — completed**, including a full native save **inspector
   + editor** (player stats, Pals, items) and a **scheduled auto-backup** system.
2. **Roadmap #6 (Auto-restart) — completed and live-verified**: a host metrics publisher +
   an in-process dashboard monitor (memory/hang triggers, hourly cap, manual-stop
   exclusion).
3. **Refinement:** PalDefender now appears in the **Mods** tab as a toggleable,
   non-removable **built-in**.

Both automation features (auto-backup, auto-restart) ship **disabled by default**.

---

## 1. Roadmap #5 — Saves & Backups (DONE)

Grew from backup/restore into a full **native save inspector + editor**. Unlocked by
vendoring `oMaN-Rod/palworld-save-pal` (MIT, Rust) — a pure-Rust Kraken/Oodle decoder that
reads Palworld 1.0's `PlM1` saves with no proprietary `oo2core` DLL. Built into the Docker
image as small CLI helpers (`savtools/psp-*`) the Node app shells out to.

- **Backups:** manual + **scheduled auto-backup** (interval, retention, "skip when no
  players online"), restore, switch world, download, delete. Runs as uid 2001 on the
  mounted volume — no host privilege. Auto-backups are prefixed `palworld-save-auto-` so
  retention only prunes those.
- **Save Inspector (read):** per-player level, Pals, and full inventory (5 containers) —
  works for **offline** players (native parse, not PalDefender REST).
- **Delete player from world:** removes character/Pals/inventory/base from `Level.sav` so
  the player hits character creation. Handles the orphan-guild trap (a solo player is admin
  of their own auto-created "Unnamed Guild"; leaving it caused a rejoin failure). **Live-
  verified.**
- **Stage 3 editing (write):** player basics (level/exp/HP/stomach/sanity/stat-points),
  Pals (per-Pal level + heal-all), and item counts (edit/remove, max-stack clamped) — all
  through one atomic `Level.sav` write, guarded by "server must be stopped" (409 otherwise)
  + an automatic `preedit` backup. Verified on copies of the live world; the player-basics
  edit was also confirmed **in-game**.

Also fixed along the way: roster button clipping (Radix ScrollArea `display:table` trap),
online/offline labels on saves, and the edit action bar moved to the bottom + shown only
when dirty.

## 2. Roadmap #6 — Auto-restart (DONE, live-verified)

**Architecture (chosen: host publishes, dashboard decides).** The dashboard has no Docker
socket / cgroup access by design, and the game REST omits memory — so:

- **Host publisher** (`~/palworld-server/scripts/palworld-metrics-publisher.sh` +
  `palworld-metrics.service`, enabled): a persistent loop, cgroup **v2**, resolves the
  container cgroup via `/proc/<pid>/cgroup`, reads `memory.current`/`memory.max` + a
  `cpu.stat` delta + `docker inspect`, and writes `/run/palworld/metrics.json` (0644) every
  10 s. **Observes only.**
- **Dashboard monitor** (`lib/auto-restart.ts`, started on boot by `instrumentation.ts`):
  reads that file + its own authenticated REST probe, and restarts via the existing
  `restart.request` flag on **hang** (running but unresponsive past a boot grace) or
  **memory** over an **absolute MB ceiling** (the container has no cgroup limit → percent is
  null). **Hourly cap**; **manual-stop exclusion is structural** — the container's
  `unless-stopped` policy means a crashed process is auto-recovered by Docker and the
  container only stays `exited` on a deliberate stop, so the monitor acts only on a
  *running* container.
- **UI:** a self-contained **Auto-restart card in the Engine tab** (enable, memory limit,
  max/hour, countdown, live memory, last action, Save/Test — Test is a dry-run).

**Live end-to-end verification (2026-07-26):** armed a 1500 MB ceiling → monitor fired
(ledger `reason: memory`) → container recreated (StartedAt changed) → healthy again, **RCON
`Info` answered** → hourly cap ledgered the triggers → a normal manual stop was **not**
counted as a crash / not revived → reset to disabled with the ledger kept as first history.
The dry-run Test path (broadcast, no recreate) was confirmed too.

**k8s portability (in the spec):** swap the publisher for a metrics API and the flag-file
write for a k8s API call; the decision core is unchanged.

## 3. Refinement — PalDefender as a built-in mod

PalDefender is the standalone **d3d9 injection** (not a UE4SS mod). It now appears in the
**Mods** tab as a protected **built-in**: shown when installed, `PalDefender` + `Built-in`
badges, a working **toggle** (adds/removes `PalDefender.dll` from the d3d9 loader's
`Win64/d3d9_config.json` `load_dlls` — the loader's own mechanism), and a **disabled Remove**
(UI + API both reject deletion). Effective on next restart, like every mod toggle.

## Hard-won gotchas (recorded in CLAUDE.md)

- Deleting `Players/<uid>.sav` does NOT reset a character (data lives in `Level.sav`).
- Solo players admin their own "Unnamed Guild"; orphan guilds break rejoin.
- Item removal needs the `"None"` sentinel, not slot-dropping.
- Game REST port 8212 returns 401 even when the container is stopped.
- Radix ScrollArea's `display:table` wrapper defeats flex truncation.
- `unless-stopped` auto-recovers crashed processes → exited == deliberate stop (the basis
  for the auto-restart manual-stop exclusion).

## Current state

- Both repos **clean**, everything committed. No remotes (local-only by design).
- Automation ships **disabled**: enable auto-backup in Saves, auto-restart in Engine.
- Roadmap: #1–#6 done. **#7 (multi-instance management)** is the only remaining item —
  not started (needs an explicit go).

## Commit trail (this session)

Dashboard (`~/palworld-dashboard`), newest first:
```
db3ed93 feat(mods): PalDefender as a toggleable, non-removable built-in
645967e docs: item #5 (Saves & Backups) status report
c0a4150 feat(engine): auto-restart monitor — memory/hang triggers, hourly cap (#6)
446876d feat(saves): pin the edit action bar to the bottom, show only when dirty
32991e7 feat(saves): scheduled auto-backups (interval, retention, skip-when-empty)
9385742 feat(saves): Stage 3 item editing
a230caf feat(saves): Stage 3 Pal editing — per-Pal level + heal-all
90bf680 feat(saves): Stage 3 player-basics editing
dbf0ab5 feat(saves): read-only per-player inventory in the Save Inspector
e145f1a fix(saves): remove the player's orphan guild so rejoin isn't rejected
551d3e3 refactor(roster): drop world coordinates from roster rows
fc8c324 feat(saves): online/offline state on each player-save row
21ac61a fix(roster): stop Kick/Ban/⋮ clipping off the panel
afa6095 feat(saves): delete player from world to force character recreation
b1e937c feat(saves): show a player save's owner name even when offline
5cdaa69 fix(roster): stop the Kick/Ban/⋮ buttons clipping off the panel
```

Config repo (`~/palworld-server`), #6 + doc syncs:
```
bb325f2 docs: sync — PalDefender listed as a built-in mod
7817a90 chore(git): track scripts/systemd/ — palworld-metrics.service
771cf5d feat(metrics): host publisher for the auto-restart monitor (#6)
41695bc docs: sync — auto-backup scheduler
d9fc143 docs: sync — Stage 3 item editing (complete)
f99b121 docs: sync — Stage 3 Pal editing
666ef34 docs: sync — save inspector inventory + Stage 3 editing
386a713 docs: sync — delete-player-from-world gotchas
```

*See `docs/item-5-saves-report.md` for the deeper Saves write-up and
`docs/specs/auto-restart-spec.md` for the #6 design + data contract.*
