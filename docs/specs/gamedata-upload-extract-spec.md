# Spec: in-dashboard usmap upload → auto-extract game data

**Status:** proposed (scoping only — not built). Builds on the runtime-extraction
feature (extractor fork + converter + runtime-loaded datasets/icons) already
shipped.

## Goal

Let an admin upload a `mappings.usmap` in the dashboard and get item/Pal names +
icons populated automatically — no shell, no `docker run`, no rebuild. The
heavy extraction (net10 + a multi-GB pak parse) runs **off the web tier**.

Out of scope: generating the usmap (still made on a Windows PC with UE4SS per
game version) and item icons (PDE is Pal-focused).

## Security model (unchanged)

The web container keeps **no Docker and no sudo**. It only ever (a) writes an
uploaded file and (b) drops a request flag file — both in dirs it owns. A
root-owned host runner does the privileged `docker run`. Identical to the
lifecycle / provisioning pattern.

```text
Dashboard (uid 2001)                      Host runner (root)
  POST usmap ─▶ /srv/palworld/gamedata/<id>/mappings.usmap
  POST extract ─▶ /run/palworld/<id>/gamedata.request ──watch──▶ docker run extractor
                                                                    (pak ro + usmap → out)
  GET status  ◀── /run/palworld/<id>/gamedata.status ◀──write── phase/pct/message
  /api/datasets + /api/game-icon  ◀── reads ── /srv/palworld/gamedata/<id>/{data,icons}
```

## Components

1. **Dashboard UI** — a "Game Data" card (Maintenance tab, or next to the RCON
   pickers). Upload usmap (validated client-side: `.usmap`, magic `c4 30`),
   "Extract now" button, live progress (idle/extracting/converting/done/failed +
   last-run time), and current coverage (X pals/items named, Y icons — from
   `/api/datasets`). Progress polling mirrors the provisioning wizard.

2. **Dashboard API (admin-gated):**
   - `POST /api/game-data/usmap` — accept the upload (validate magic + size cap),
     write to `/srv/palworld/gamedata/<id>/mappings.usmap`.
   - `POST /api/game-data/extract` — temp-then-rename a `gamedata.request` JSON
     (`{instance, pakDir, usmapPath, requestedAt}`) into `/run/palworld/<id>/`.
   - `GET /api/game-data/status` — read `gamedata.status` + dataset counts.

3. **Host runner** — a new `palworld-gamedata` systemd service (or a branch in
   `palworld-control`): watches `gamedata.request`, runs
   `ghcr.io/dhampyru/palworld-data-extractor` with the instance's pak (ro) + the
   uploaded usmap, output → `/srv/palworld/gamedata/<id>/{data,icons}`; writes
   `gamedata.status` (phase/pct/message). Concurrency-guarded (one at a time),
   timeout, memory cap. Registry-driven for multi-instance.

4. **Wiring** — dashboard `PALWORLD_DATASETS_DIR` / `PALWORLD_ICONS_DIR` point at
   `/srv/palworld/gamedata/<id>/{data,icons}`; the shared `/srv/palworld` mount
   already exists. `scripts/host/install.sh` installs the new service. Data is
   global-per-version (one usmap/output shared across instances of the same
   build) unless per-instance is wanted.

## Prerequisite

**Publish the extractor image to GHCR** (a CI workflow, like the dashboard /
game-server images) so the host runner can `docker pull
ghcr.io/dhampyru/palworld-data-extractor`. Today the extractor is source-only.

## Phases

1. Extractor image + CI publish (prerequisite).
2. Host runner (`gamedata.request` → docker run → status) + installer wiring.
3. Dashboard API (upload, extract, status).
4. Dashboard UI (Game Data card + progress polling).
5. Docs + Full Self-Hosted Setup integration.

## Effort / risk

- **Moderate-large.** Reuses proven patterns (flag-file→host, status polling from
  provisioning, runtime datasets dirs, host installer), so it's incremental.
- **Risks:** extraction is heavy (RAM/time) → runner needs a concurrency guard,
  timeout, and memory limit; the extractor image must be pinned + published; pak
  path resolution per instance; upload validation (reject non-usmap).
- **Requires host integration installed** (the runner) — same bar as lifecycle /
  provisioning; a pure compose-only deploy can't auto-extract (would fall back to
  the manual `docker run` extractor).

## Caveats

- The usmap is still operator-made per game version (this only moves the
  *upload* into the UI).
- Item icons remain absent (PDE limitation).
