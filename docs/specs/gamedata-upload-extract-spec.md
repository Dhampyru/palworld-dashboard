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

3. **Host runner — BUILT (folded into `palworld-control`, Phase 2).** Rather than
   a separate service, the existing control daemon gained a game-data branch: it
   watches `<runDir>/gamedata.request` for **all** instances incl `default`
   (`default` has no legacy units, so unlike lifecycle it isn't skipped), runs
   `ghcr.io/dhampyru/palworld-data-extractor` (env `PALWORLD_EXTRACTOR_IMAGE`)
   against the instance's pak (ro, host `gameDir` from the registry) + the
   uploaded usmap, output → `${SRV_ROOT}/gamedata/<id>/{data,icons}`; writes
   `<runDir>/gamedata.status` (phase/pct/message). **Serialized** (one extraction
   at a time — skips the scan while any `gamedata.processing` exists), `timeout`
   (`PALWORLD_GAMEDATA_TIMEOUT`, default 2400s), usmap magic-checked (`c430`),
   output chowned to the dashboard gid. `install.sh` creates the `gamedata`
   workspace (`2775 root:gid`) and writes the env. Verified with a stubbed
   extractor (8/8: targets, happy path, bad-magic/missing-usmap/missing-pak).

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

1. ✅ Extractor image + CI publish (prerequisite) — `publish-extractor.yml`.
2. ✅ Host runner (`gamedata.request` → docker run → status) + installer wiring —
   folded into `palworld-control`.
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
