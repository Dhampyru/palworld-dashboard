# Saves & Backups (roadmap item 5) — spec

Status: **GROUNDWORK** (2026-07-24). Terrain verified against the live server;
read-only listing backend built first. Mutating operations (create backup,
restore, switch world) are designed below but NOT yet built — restore is
destructive and wants owner review before wiring.

## 1. Terrain (verified on the live box, read-only)

- **Worlds** live at `Pal/Saved/SaveGames/0/<WORLD_ID>/` (the `0` is the local
  user slot). Each world dir holds `Level.sav`, `LevelMeta.sav`, `Players/*.sav`,
  and the game's own `backup/`. Currently ONE world:
  `BD2A59D54272251977937E943DAD189A` (3.3M, 2 players). A sibling `backup/` dir
  under `SaveGames/0/` is the game's auto-backup, **not** a world — exclude it.
- **World IDs are opaque 32-hex.** No human-readable world name is stored
  anywhere we can read (`LevelMeta.sav` is `PlM1`/Oodle — unparseable, §3 gotcha
  7). So the UI lists worlds by ID + derived metadata (size, last-modified,
  player count, active flag). An **operator-assigned friendly alias** can be
  stored dashboard-side (`data/world-aliases.json` or similar) — optional, later.
- **Active world** = `DedicatedServerName` in
  `Pal/Saved/Config/WindowsServer/GameUserSettings.ini` (section
  `[/Script/Pal.PalGameLocalSettings]`). Currently
  `DedicatedServerName=BD2A59D54272251977937E943DAD189A`. Switching worlds =
  rewrite that one line + restart. The file is otherwise client graphics/audio
  settings; **no secrets** — safe to back up via `writeConfigFileWithBackup`.
- **Backups** already exist at `game/backups/` — 7 tarballs named
  `palworld-save-<YYYYMMDD_HHMMSS>.tar.gz`, written daily ~05:00 by the game
  container's `scripts/backup.sh` (cron/supercronic). Format:
  `tar -czf backups/palworld-save-<stamp>.tar.gz -C Pal/Saved SaveGames` — i.e.
  the whole `SaveGames` tree (all worlds), gzip. Sizes 0.6–2.2 MB.
- **The dashboard image has GNU tar 1.34.** So the dashboard can create and
  extract these tarballs itself, directly on the mounted `/palworld-game`
  volume (RW) — **no host-systemd escalation needed for the save files**. Host
  integration (§2) is only needed to stop/start around a restore.
- **Permissions:** dashboard runs as uid 2001. `game/` is `0777`; `game/backups/`
  is `0777` and non-sticky, so uid 2001 can create AND delete files there even
  the root-owned (cron-written) ones. Verified the dir mode; watch for a future
  tightening that would break delete.

## 2. Backend surface

`lib/saves.ts` (pure-ish helpers) + `app/api/saves/route.ts`. Admin-tier only
(saves are as powerful as it gets). Paths derive from `PALWORLD_GAME_DIR`
(`/palworld-game` in the dashboard container), same as the other config routes.

- `SAVEGAMES_DIR = <game>/Pal/Saved/SaveGames/0`
- `BACKUPS_DIR   = <game>/backups`
- `GUS_INI       = <game>/Pal/Saved/Config/WindowsServer/GameUserSettings.ini`

### Dashboard-data backup (BUILT 2026-08-06)
The dashboard's OWN state (`/app/data`: mod-config overrides, mod↔Nexus/Steam links,
backup + auto-restart schedules, mod-groups) is a named docker volume — durable across
recreation, but nothing backs up the volume itself. `backupDashboardData()`
(`lib/saves.ts`) tars it to `BACKUPS_DIR/dashboard-data-<stamp>.tar.gz` — a **different
volume** (game), so a lost data volume is recoverable. Runs from the backup-scheduler
`tick()` (global, once/tick), freshness-gated to ~daily (`maxAgeMs 24h`); the first tick
after boot creates one immediately (no prior snapshot). Independent of the world
auto-backup toggle — it's operator config, not a world. Own retention (`keep` newest 14);
its `dashboard-data-*` files don't match `BACKUP_FILE_RE` so they never appear in the
saves restore list nor get touched by the world-backup pruners. **Secrets excluded**
(repo rule — no secrets in plaintext backups): `panel-auth.json` (re-seeded from
`PANEL_INITIAL_ADMIN_PASSWORD`), `nexus.json` (API key — re-enter), `steam/` (SteamCMD
session — re-login); `*.tmp` too. Verified live: first snapshot (2 KB) contains the 7
operational JSONs and none of the excluded secrets.

### GET (BUILT — read-only)
Returns `{ worlds: WorldInfo[], backups: BackupInfo[], activeWorldId }`.
- `WorldInfo = { id, active, sizeBytes, modifiedAt, playerCount }`
- `BackupInfo = { file, sizeBytes, modifiedAt }`
- `activeWorldId` parsed from `GameUserSettings.ini` `DedicatedServerName`.
- Degrades gracefully: missing SaveGames dir → empty worlds; missing backups dir
  → empty backups; unreadable ini → `activeWorldId: null`.

### POST (DESIGNED — not built)
Mutating actions, `{ action, ... }`:
- `action: 'backup'` — RCON `Save` first (flush to disk), then
  `tar -czf backups/palworld-save-<stamp>.tar.gz -C Pal/Saved SaveGames`. Safe
  while the server is running. Returns the new backup's info. (Stamp is passed
  in / generated server-side; note scripts can't use `Date.now()` — the ROUTE
  can, it's normal Node.)
- `action: 'restore', file` — **destructive.** Guardrails: (1) validate `file`
  is a basename matching `palworld-save-*.tar.gz` inside BACKUPS_DIR (no path
  traversal); (2) auto-create a `pre-restore` backup of current SaveGames first;
  (3) require the server to be STOPPED — trigger the §2 stop flag, wait for the
  container to actually be down, extract over `Pal/Saved/SaveGames`, then start.
  Extract is `tar -xzf <file> -C Pal/Saved`. This is the piece to review before
  building — it overwrites the live world.
- `action: 'switch', worldId` — rewrite `DedicatedServerName` in
  `GameUserSettings.ini` via `writeConfigFileWithBackup` (add GameUserSettings.ini
  to that helper's allowlist), then restart (§2). Validate `worldId` is an
  existing world dir.
- `action: 'delete', file` — same basename validation, then unlink. (Refuse to
  delete if it's the only backup? optional.)

### Download
A backup download can be a `GET /api/saves/download?file=<basename>` streaming
the tarball with the same basename validation. (Or reuse the POST route with an
action — but a GET is friendlier for a browser download.)

## 3. Non-negotiable guardrails

- **Path-traversal:** every `file`/`worldId` from the client is validated as a
  bare basename and re-resolved under its known parent; reject anything with `/`,
  `..`, or that escapes the dir. Saves operations touch real save data — this is
  the highest-value injection target in the app.
- **Restore backs up first.** Never overwrite the live world without snapshotting
  it (a `pre-restore-<stamp>` tarball), so a bad restore is itself reversible.
- **Restore requires a real stop, confirmed by container state**, not just the
  stop flag being written — mirror the restart handler's "verify by StartedAt"
  discipline (§2 / §3.1). Swapping save files under a running server corrupts.
- **Admin-tier only**, every action. Mod tier is rejected before any fs touch.
- **No secrets in tarballs or `.bak`:** SaveGames + GameUserSettings.ini carry no
  credentials, so this is clean — but the backup path must never sweep in `.env`
  or `Tokens/` (it won't: it tars `SaveGames` only, `-C Pal/Saved`).

## 4. UI (later — not groundwork)

A new **Saves** surface (tab, or a card under an existing admin tab — TBD). Lists
worlds (active badge, size, last-played, players) and backups (size, date,
download / restore / delete). "Create backup now" button. Restore behind a
double-confirm that spells out the stop→restore→start sequence. Adding a *tab*
touches the two-file tab switcher (see CLAUDE.md) — do it deliberately, after the
backend + this spec are signed off.

## 5. Open questions for the owner

1. **Restore ergonomics:** auto pre-restore backup + full stop/start is the safe
   default. OK to always stop the server for a restore, or do you want a "danger,
   I know it's running" override? (Recommend: always stop.)
2. **Backup location:** keep writing to `game/backups/` alongside the cron
   backups (unified list), or a separate `game/backups/manual/`? (Recommend:
   same dir; distinguish cron vs manual by nothing — they're interchangeable
   restore sources. Optionally tag manual ones in the filename.)
3. **World aliases:** worth a dashboard-side friendly-name store, or is the ID +
   metadata enough for a single/low-count-world server? (Recommend: skip until
   multi-world is common.)
4. **Multi-world creation** (making a NEW empty world) is really roadmap item 7
   territory (multi-instance) — out of scope here; item 5 is list/switch/backup/
   restore of EXISTING worlds.
