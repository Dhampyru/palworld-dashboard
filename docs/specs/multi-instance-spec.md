# Multi-instance management (roadmap #7)

*Status: IN PROGRESS (2026-08-01). Owner-approved scope: full UI provisioning of new
servers, per-instance lifecycle/monitoring/saves/mods/settings, delete-keeps-saves, able
to run several concurrently (usually one/few active). The live "Palkatraz" server becomes
the seeded `default` instance and must keep working throughout.*

## Goal

Manage **N** Palworld game servers ("instances") from one dashboard:

- switch the active instance; every existing feature (snapshot, saves, mods, world/engine
  settings, guilds, RCON, PalDefender) operates on the selected instance,
- per-instance one-click lifecycle (start / stop / restart),
- **create a brand-new server from the UI** (allocate ports, create dir + `.env`, first-boot
  install, bring it up),
- **delete-keeps-saves** (tear down the container, never the save data),
- per-instance monitoring + auto-backup + auto-restart.

## Non-negotiable constraints (from CLAUDE.md)

- The dashboard container **never** gets Docker or sudo. Every privileged action is
  triggered by the dashboard writing a flag file it owns under `/run/palworld` (uid/gid
  2001); a **host** process reacts. This security boundary is unchanged by this feature.
- **Secrets never in code, git, or logs.** Per-instance admin/RCON passwords live only in
  that instance's host-side `.env` (`0660 root:2001`), generated host-side.
- Verify a real restart by the container's `StartedAt` changing, not exit code.
- "Is it up?" requires an **authenticated REST 200** — port 8212 answers `401` even when the
  container is stopped.

## Three architectural decisions

**A. One shared parent mount, not a mount per instance.** Adding a bind-mount for each
UI-provisioned server would force a dashboard-container recreate every time. Instead the
dashboard bind-mounts one parent dir **once**: host `/srv/palworld` → container
`/srv/palworld`. Every *new* instance lives at `/srv/palworld/<id>/{game,mods,.env,
docker-compose.yml}` — reachable by path with no new mount. Palkatraz stays at
`/root/palworld-server` (its two existing mounts retained) and is the **one special-cased
entry**.

**B. One persistent privileged host daemon** (`palworld-control`, modeled on the existing
`palworld-metrics.service`). Provisioning cannot be a `PathExists=` oneshot and the
dashboard cannot `systemctl enable` per-instance template units, so a persistent privileged
worker is required for provisioning anyway — route **per-instance lifecycle through it too**
(registry-driven) rather than maintaining `palworld-<action>@<id>.{path,service}` units × N.

**Refinement (built 2026-08-01, Phase 3): the daemon handles NON-default instances only.**
The live `default` server keeps its own proven `palworld-{restart,shutdown,start}.{path,
service}` units watching the FLAT `/run/palworld/*.request` paths — there is **no cutover of
the live lifecycle path**, which removes the single riskiest step (a player-kicking live
restart to prove a migration). `resolveLifecyclePaths(id)` returns flat paths for `default`
(→ old units) and `/run/palworld/<id>/<action>.request` for everything else (→ daemon). The
daemon's registry query explicitly `select(.id != "default")`.

**C. Per-instance secrets reuse the existing `.env` pattern.** Palkatraz's admin password
already lives in `/root/palworld-server/.env` (`0660 root:2001`) and the dashboard already
reads/writes it for World Settings sync. Each instance's password lives in *its* `.env`,
resolved on demand — never in the registry, code, or git.

## Registry (data model)

`/srv/palworld/registry.json` (`0664 root:2001`; same absolute path host- and
container-side). Read by both sides; the dashboard (uid 2001) may rewrite it. **Secrets are
NOT stored here** — resolved on demand from `envFilePath` + PalDefender `Tokens/`.

```jsonc
{
  "schemaVersion": 1,
  "instances": [{
    "id": "default",             // slug; used in paths, container name, flag-file dirs
    "displayName": "Palkatraz",
    "seed": true,                // true only for the migrated live server
    "enabled": true,             // participate in monitoring / auto-restart
    "container": "palworld-server",
    "composeDir": "/root/palworld-server",       // HOST view — used by the daemon/provisioner
    "gameDir": "/root/palworld-server/game",     // HOST view
    "envFilePath": "/root/palworld-server/.env",
    "ports": { "game": 8211, "query": 27015, "rcon": 25575, "rest": 8212, "paldefender": 17993 },
    "rconHost": "host.docker.internal",
    "restUrl": "http://host.docker.internal:8212",
    "paldefenderUrl": "http://host.docker.internal:17993",
    "createdAt": "2026-08-01T05:12:08Z"
  }]
}
```

**Host vs container paths.** For `default`, the DASHBOARD resolves filesystem paths from its
env vars (container view: `PALWORLD_GAME_DIR=/palworld-game`,
`PALWORLD_SERVER_ENV_PATH=/palworld-server-env/.env`); the registry's `composeDir`/`gameDir`
are the HOST view used by the daemon. For **new** instances under the shared `/srv/palworld`
mount, host and container paths **coincide**, so a single value serves both. `composeDir`
must therefore be identical host- and container-side for non-default instances — the shared
mount guarantees this (Decision A).

## Flag-file contracts (generalize today's, per instance)

Per-instance run dir `/run/palworld/<id>/` (`0775 2001:2001`), created by the daemon on
registry load (and/or tmpfiles.d):

- Lifecycle requests (dashboard → daemon), temp-then-rename, JSON `{waittime, message,
  dryRun, requestedAt}` — same shape as today: `/run/palworld/<id>/{start,stop,
  restart}.request`; cancels `/run/palworld/<id>/{stop,restart}.cancel`.
- Metrics (daemon → dashboard): `/run/palworld/<id>/metrics.json` (same schema as today's
  single file). The flat `/run/palworld/metrics.json` is kept for `default` during migration.
- Provisioning (Phase 5): `/run/palworld/provision/<id>.request` (non-secret config; daemon
  generates passwords) and `<id>.status` `{phase,pct,message,updatedAt}`; delete
  `/run/palworld/<id>.delete.request`.

## Dashboard config resolution

Single new server-only helper `lib/instances.ts` that every current `process.env` read-site
routes through: `listInstances()`, `getInstance(id)`, `resolveInstance(id?)`,
`resolveSecrets(id?)`, `resolveRcon(id?)`. For `default`/absent id it returns **today's
env-var-derived values** (so nothing changes until an instance is explicitly selected). The
active instance is carried client→API by the `x-palworld-instance` header (added to
`PALWORLD_PROXY_HEADERS` in `lib/palworld.ts`, matching the header-only convention already
used for the admin password). `server-context.tsx` holds `activeInstanceId` + `instances`
and namespaces `localStorage` per instance.

World-switching inside one server (`lib/saves.ts`, via `DedicatedServerName` in
`GameUserSettings.ini`) is a **different axis** from instance-switching and stays as-is.

## Rollout order (live server safe until the final cutover)

**Phase −1** backups (done 2026-08-01): live world tarball copied to
`/root/backups/pre-multi-instance-*`, git tag `pre-multi-instance`, host-config snapshot.
**Phase 0** this spec + `/srv/palworld` + seeded `registry.json` (inert). **Phase 1**
`lib/instances.ts` + resolver refactor (behavior identical via default fallbacks). **Phase
2** one-time `/srv/palworld` mount in the dashboard compose (only step that recreates the
live-panel container; game independent) + header/context plumbing. **Phase 3**
`palworld-control` daemon drives non-default lifecycle (verified on a throwaway `test-01`);
`default` KEEPS its flat-path units — no cutover. **Phase 4** (built 2026-08-01) the metrics
publisher (`scripts/host/palworld-metrics-publisher` → `/usr/local/bin/palworld-metrics-
publisher.sh`) now iterates the registry and writes each instance's `metrics.json` (default
stays FLAT at `/run/palworld/metrics.json`, superset schema so the armed in-process monitor
is untouched); `/api/instances` surfaces per-instance live status. **Deliberately deferred:**
making the in-process `backup-schedule.ts` + armed `auto-restart.ts` per-instance — they keep
protecting `default` unchanged, and per-instance auto-backup/auto-restart is a later
enhancement (rewriting the live armed monitor was not worth the risk for the first cut).
**Phase 5** (built + stub-verified 2026-08-01) provisioning + delete via the daemon:
`app/api/instances` POST (admin; slugifies the name, rejects reserved/duplicate, writes
`/run/palworld/provision/<id>.request`) and `app/api/instances/[id]` GET (status) / DELETE
(delete-keeps-saves → `/run/palworld/<id>.delete.request`). The daemon allocates a
non-colliding host-port block (registry + `ss`), creates `/srv/palworld/<id>/{game,mods,
compatdata-seed}`, generates a `0660` `.env` (32-char alphanumeric admin password),
templates the compose from `scripts/host/instance-template.docker-compose.yml` (reuses the
prebuilt image; unique host ports → default internal ports), `docker compose up -d`,
registers the instance, then polls **authenticated REST 200** for readiness (status file
`/run/palworld/provision/<id>.status`). Delete runs `docker compose down` (no `-v`),
deregisters, keeps the game dir. Verified in isolation with a stub template/image (port
alloc, dir/.env/compose, registration, delete-keeps-saves incl. a surviving save marker);
the live-API guardrails (reserved/duplicate/refuse-default/unauth) verified on `:3000`. A
**real** Palworld provision (multi-GB SteamCMD first boot) is deferred to an explicit
owner-triggered run — though an accidental test confirmed the real image/template brings a
container up healthy. **Phase 6** (built + verified 2026-08-01) FLEET-FIRST UI — owner's chosen
model: log in → a **fleet landing** (`components/fleet-view.tsx` + `instances-panel.tsx`)
listing every server; click one to open its full dashboard scoped to it; a header "Instances"
button returns to the fleet. `server-context` gained `activeInstanceId` +
`enterInstance`/`exitToFleet` (persisted; folds the id into `config.instanceId` so every
request carries the header). To make each server's dashboard show its OWN data, the filesystem
libs were made per-instance via a request-scoped `AsyncLocalStorage` (`runWithInstance` /
`currentGameDir` / `currentEnvFilePath` / `currentRestConfig` in `lib/instances.ts`):
`saves.ts`, `game-mods.ts`, `palschema.ts`, `steam.ts`, and the `palworld-settings` /
`engine-tuning` / `paldefender-config` / `chat` routes resolve paths from the active instance,
with `default` byte-identical to pre-#7 (verified: game-mods/saves/settings identical
live-vs-preview; `test-01` resolves to its own dir). `lib/palworld-settings.ts` stays
client-safe (the world-settings panel imports its parser), so its per-instance ini path lives
in the route. Per-instance dashboard state files are id-suffixed (`./data/*.<id>.json`);
default keeps the original filename. Every risky step was validated on a throwaway before
Palkatraz; rollback source is the Phase −1 snapshot.

**Follow-ups — DONE (2026-08-01).** Auto-backup, auto-restart, and FPS sampling are now
per-instance. `lib/auto-restart.ts` + `lib/backup-schedule.ts` key settings + state by
instance and the monitors iterate `listInstances()`; `default` stays byte-identical (same
settings files, flat flag paths, ARMED crash default) while crash auto-restart defaults OFF
for new instances (so a first-boot SteamCMD install isn't killed as a hang). The
`scripts/fps-sampler` sidecar is registry-driven (per-instance rings `fps-history.<id>.json`,
reading each instance's rest port + `.env` password; `/srv/palworld` mounted read-only);
`lib/fps-ring.ts` + the snapshot/fps-history routes resolve the ring per active instance.

## Verification

Per phase: `tsc --noEmit` in a node container → rebuild → verify on preview `:3001` → deploy
`:3000`. Lifecycle verified by container `StartedAt` changing + RCON `Info` answering;
readiness by authenticated REST 200; delete verified by container gone but
`/srv/palworld/<id>/game` still on disk.
