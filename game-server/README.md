# Palworld game server (Windows binary under Wine, UE4SS-capable)

A self-contained Docker image that runs the **Windows** Palworld dedicated-server
binary under **WineHQ stable** — the setup that can load **UE4SS** mods (which
are Windows-only) and **PalDefender**, unlocking the dashboard's richer features.

This is the game-server companion to the [dashboard](../README.md). Run it, point
the dashboard at its REST + RCON, and you have the full stack. See the dashboard's
**Full Self-Hosted Setup** guide for the end-to-end path.

## What's baked in vs installed at boot

- **Baked:** Wine, SteamCMD, `rcon-cli`, supercronic, the entrypoint. **No game
  files** — nothing of Pocketpair's is redistributed.
- **First boot:** SteamCMD downloads the Palworld Windows server (AppID 2394010);
  **UE4SS** (MIT) is fetched and installed; **PalDefender** (MIT) installs too if
  `ENABLE_PALDEFENDER=true` + `PALDEFENDER_URL` is set.

## Quick start

```bash
cp .env.example .env        # set ADMIN_PASSWORD at minimum
docker compose up -d
docker compose logs -f      # watch the SteamCMD install on first boot
```

First boot downloads several GB and can take a while. When `docker compose ps`
shows healthy, the server is up.

## Run the published image (GHCR)

No local build needed — pull the prebuilt image (Wine + SteamCMD + mod-loaders;
the game itself still downloads on first boot):

```
ghcr.io/dhampyru/palworld-game-server:latest
```

**Compose:** in `docker-compose.yml`, comment out `build: .` and use the image line:

```yaml
services:
  palworld:
    # build: .
    image: ghcr.io/dhampyru/palworld-game-server:latest
```

then `docker compose up -d` as above.

**Plain `docker run`** (the security options are required — Wine uses ptrace, and
the entrypoint needs Xvfb + the DLL overrides, both baked in):

```bash
docker run -d --name palworld-server --restart unless-stopped \
  --security-opt seccomp=unconfined --security-opt no-new-privileges:true \
  --cap-add SYS_PTRACE --stop-timeout 30 \
  -p 8211:8211/udp -p 27015:27015/udp \
  -p 127.0.0.1:25575:25575/tcp -p 127.0.0.1:8212:8212/tcp \
  -e ADMIN_PASSWORD='change-me-strong-and-alphanumeric' \
  -e WINEDLLOVERRIDES='dwmapi=n,b;d3d9=n,b' \
  -e RCON_ENABLED=true -e REST_API_ENABLED=true \
  -v /srv/palworld-game/game:/palworld \
  -v /srv/palworld-game/mods:/mods \
  ghcr.io/dhampyru/palworld-game-server:latest
```

RCON (25575) and REST (8212) are bound to `127.0.0.1` here — keep them off the
public internet; only the dashboard needs them.

## Unraid

A ready-made template lives at [`unraid/palworld-game-server.xml`](unraid/palworld-game-server.xml).

1. Copy it onto the Unraid box (WebUI > Terminal, or a share):
   ```bash
   curl -sL https://raw.githubusercontent.com/Dhampyru/palworld-dashboard/main/game-server/unraid/palworld-game-server.xml \
     -o /boot/config/plugins/dockerMan/templates-user/palworld-game-server.xml
   ```
2. **Docker** tab > **Add Container** > pick **palworld-game-server** from the
   *Template* dropdown.
3. Set **ADMIN_PASSWORD** (32 alphanumeric chars — punctuation breaks the
   INI/argv/compose path), adjust ports/paths if needed, **Apply**.

The template presets the required `--security-opt seccomp=unconfined
--cap-add SYS_PTRACE` (Extra Parameters) and the `WINEDLLOVERRIDES` for mod
injection. First boot pulls ~12-15 GB into the mapped *Game data* path, so put it
on a roomy pool/share. RCON/REST/PalDefender ports are marked advanced and should
stay internal — do **not** port-forward them at your router.

> **Heads-up:** the game port is **UDP**. Forward `8211/udp` (not TCP).

## Publishing the image (maintainer)

CI (`.github/workflows/publish-gameserver.yml`) builds `game-server/` and pushes
to `ghcr.io/<owner>/palworld-game-server` on any `v*` tag, or on manual
**Run workflow** (workflow_dispatch). Tags produced: the version, `MAJOR.MINOR`,
`latest`, and a short-SHA. After the first publish, make the GHCR package
**public** (repo > Packages > package > Package settings > Change visibility) so
`docker pull` works without auth. Re-run the workflow after changing anything
under `game-server/` (e.g. the Xvfb display fix) so `latest` stays current.

## Ports

| Port | Proto | Purpose | Expose publicly? |
| --- | --- | --- | --- |
| 8211 | UDP | Game (players connect here) | Yes |
| 27015 | UDP | Steam query | Optional |
| 25575 | TCP | RCON | **No** (bound to localhost) |
| 8212 | TCP | REST API (dashboard) | **No** (bound to localhost) |
| 17993 | TCP | PalDefender REST | **No** (bound to localhost) |

## Connecting the dashboard

Enable RCON + REST (defaults in `.env.example`), then set on the dashboard:

```env
PALWORLD_REST_URL=http://host.docker.internal:8212
PALWORLD_ADMIN_PASSWORD=<same as ADMIN_PASSWORD here>
```

## Mods

Stage mods in `./mods` (created next to this file):

- `./mods/Win64/` → UE4SS Lua/DLL mods → `Pal/Binaries/Win64/Mods/`
- `./mods/pak/` → `.pak` mods → `Pal/Content/Paks/`

## Notes

- **Plain Wine, not Proton** — Proton's Steam-bridging layer broke the headless
  dedicated-server join handshake; plain Wine works. The `WINEDLLOVERRIDES`
  (`dwmapi=n,b;d3d9=n,b`) is required for UE4SS/PalDefender injection.
- **Headless display (Xvfb) is baked in and required** — recent Palworld builds
  need a display context during graphics/RHI init even for the dedicated server,
  so the image installs `xvfb` and the entrypoint starts `Xvfb :99` (`DISPLAY=:99`)
  before wine. Without it the server access-violates on boot (`nodrv_CreateWindow`
  / no GL context) and crash-loops after Steam login. Don't strip it from a
  custom entrypoint.
- **Pin the game version** (`TARGET_MANIFEST_ID`) if you rely on UE4SS — a game
  update can outpace UE4SS and break injection until it catches up.
- Backups: `docker exec palworld-server backup`, or schedule via
  `BACKUP_ENABLED=true`.
