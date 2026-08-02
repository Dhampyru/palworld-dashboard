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
3. ✅ Dashboard API — `/api/game-data/{usmap,extract,status}` (admin-gated);
   `/api/datasets` + `/api/game-icon` prefer the instance's extracted data.
4. ✅ Dashboard UI — `components/game-data-card.tsx` in the Engine tab: upload,
   guarded one-time extract (confirm-on-overwrite, disabled while running),
   live progress + coverage.
5. Docs + Full Self-Hosted Setup integration.

## Verified live (2026-08-02)

Full E2E on the live box (no players): upload usmap → extract → daemon runs the
extractor against the real 5.4 GB pak (~4 s — CUE4Parse seeks specific data
tables, it doesn't decompress the whole pak) → `/api/datasets` flips to
`source: extracted` with real names (Alpaca→Melpaca, Kitsun; 603 named pals /
1894 named items). Game container untouched (`StartedAt` unchanged).

## Known limitation — Pal icons cannot come from the SERVER pak (names only)

Icon PNGs come out **empty** and are omitted (the picker shows name/ID, no broken
images). **Definitive root cause (diagnosed 2026-08-02): the dedicated-server cook
strips texture pixel data.** The pak here is `Pal-WindowsServer.pak` — a dedicated
server never renders, so UE cooks its textures WITHOUT mip/pixel data. Proof: for
`T_Anubis_icon_normal` the texture's `ImportedSize` is still `128x128` (metadata
survives so references resolve) but its `FTexturePlatformData` is empty —
`PixelFormat=""`, `SizeX=0`, `Mips=0`, `FirstMipToSerialize=-1`. This is **not** a
CUE4Parse/Skia/wiring bug (we're on the newest CUE4Parse 1.2.2.202608; data tables
are schema-driven so names are unaffected) and not fixable parser-side — **the
pixels are not in the server pak.** The earlier "293 icons" were always 0-byte.

**Icons ARE supported — via a client-extracted upload (BUILT 2026-08-02).** Icons
come from a CLIENT pak (a gaming PC keeps full texture data). The operator is
already on that PC to generate the usmap (UE4SS is client-side), so they run the
extractor there against the client pak to get `pal/*.png`, then upload that set as
a **zip** — `POST /api/game-data/icons` (admin-gated, adm-zip, zip-slip-safe, PNG
basenames only) flattens it into `<srv>/gamedata/<id>/icons/pal/`. `/api/datasets`
then links each `<id>.png` to the pal of that id (server-extracted pals carry no
`image`, so the link is derived from the icons dir at serve time). `/api/game-icon`
serves them. A multi-GB client-pak upload to the server is not practical; an icon
zip (~a few MB) is. The Game Data card has a "Choose icons .zip" row + an icon
coverage count. Verified E2E (synthetic zip: 5 pals linked by id, served 200).

Perms: the daemon leaves `icons/` group-writable + setgid (`2775 root:<dashgid>`)
so both the extractor (root) and the dashboard uid can write it; `data/` stays
read-only to the web tier. Two fixes also landed so a client pak that IS parsed
here yields real PNGs: the Dockerfile publishes `libSkiaSharp.so`
(`SkiaSharp.NativeAssets.Linux.NoDependencies` 2.88.9 — was missing) and
`convert.py` skips 0-byte icons.

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
