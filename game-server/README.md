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
- **Pin the game version** (`TARGET_MANIFEST_ID`) if you rely on UE4SS — a game
  update can outpace UE4SS and break injection until it catches up.
- Backups: `docker exec palworld-server backup`, or schedule via
  `BACKUP_ENABLED=true`.
